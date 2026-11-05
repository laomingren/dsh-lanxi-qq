/**
 * OneBot 11 WebSocket transport: reverse server (NapCat ws-reverse dials in)
 * and forward client (we dial NapCat's ws server), frame handling, echo
 * correlation for action calls, heartbeat, and reconnect-with-backoff.
 * Ported from the Hermes OneBotAdapter connection half.
 * @module dsh-onebot/connection
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INTERCEPTED_MESSAGE_ID, isWriteAction } from './inject.js';
import { DEFAULT_STATS_DIR, DailyStatsRecorder, kindsOfSegments } from './stats.js';
export { DEFAULT_STATS_DIR };
import { describeError, errorStack } from './errors.js';
/** Reconnect backoff ladder (seconds); the last value repeats. */
const RECONNECT_BACKOFF = [2, 5, 10, 30, 60];
const MAX_RECONNECT_ATTEMPTS = 100;
const HEARTBEAT_MS = 30_000;
/**
 * Per-frame byte cap for both directions. ws defaults to 100MiB, letting a
 * token holder pin memory with a single giant frame. 64MiB keeps ample
 * headroom over the 20MiB maxInboundFileBytes default: a get_file response
 * carrying a max-size file is ~27MiB as base64 plus JSON framing.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/**
 * Reverse churn guard: at most CHURN_MAX_REPLACES replacements of a healthy
 * dial-in within CHURN_WINDOW_MS; further dial-ins are rejected so rapid
 * re-dials cannot endlessly squeeze out the legitimate NapCat.
 */
const CHURN_WINDOW_MS = 60_000;
const CHURN_MAX_REPLACES = 5;
/**
 * W2-① reverse EADDRINUSE retry: fixed 15s backoff until the port is released
 * (competitor parity: measured ≤15s takeover) and no attempt cap — stop() is
 * the only exit. The retry is scheduled, never awaited, so a busy port cannot
 * block or crash the host's startup.
 */
const REVERSE_RETRY_MS = 15_000;
/** Steady-state log dedup: the first failure plus one error line every 10 minutes. */
const REVERSE_LOG_EVERY = Math.max(1, Math.round(600_000 / REVERSE_RETRY_MS));
/**
 * W2-④ forward self-heal (after the reconnect ladder gave up): 15s dials with
 * a rolling-hour cap of SELF_HEAL_HOURLY_CAP attempts; once the budget is
 * exhausted the interval stretches to 60s so a multi-hour outage cannot hammer
 * the peer. The ladder itself ([2,5,10,30,60] + reconnectMaxAttempts) is
 * untouched — self-heal only starts where the ladder's give-up branch ends.
 */
const SELF_HEAL_INTERVAL_MS = 15_000;
const SELF_HEAL_SLOW_INTERVAL_MS = 60_000;
const SELF_HEAL_HOURLY_CAP = 120;
const HOUR_MS = 3_600_000;
/** Error thrown for action calls that fail or time out. */
export class OneBotActionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OneBotActionError';
    }
}
/** Error thrown when the transport is not connected. */
export class OneBotNotConnectedError extends Error {
    constructor(message = 'OneBot WebSocket not connected') {
        super(message);
        this.name = 'OneBotNotConnectedError';
    }
}
// ------------------------------------------------------------ dry-run（2026-11-01）
/** 试运行默认日志文件（插件配置 dryRunLogFile 可覆盖）。 */
// 2026-11-02 (fork): 默认日志路径不再写死 D 盘 —— 换 <用户目录>/.dsh/logs/onebot-dryrun.log。
export const DEFAULT_DRYRUN_LOG_FILE = join(homedir(), '.dsh', 'logs', 'onebot-dryrun.log');
/** 试运行日志单文件体积上限（8 MiB）：到了改名成 .1 重新开，试跑日志不留历史。 */
const DRYRUN_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** 已确认建好的日志目录（省掉每条都 mkdir）。 */
let dryRunLogDir = '';
/** 当前日志字节数（-1 = 还没探过，第一次写时 stat 一次拿到基数）。 */
let dryRunLogSize = -1;
/** 试运行日志串行追加链：并发命中时不会出现两行交错。 */
let dryRunWriteChain = Promise.resolve();
/**
 * 试运行额外拦截的写 action（2026-11-01 复核 F1）。
 * 这三个会真改外部状态（上传文件进群/私聊、删一条说说），但名字不在
 * inject.js 的 isWriteAction 白名单里（那边只管 send_* / set_* / delete_msg）。
 * 在这里补一个集合，而不去扩大 isWriteAction 本身：那个函数同时被注入层
 * dry-run 用，动它会连带改注入行为，得单独做回归。
 */
const DRYRUN_EXTRA_WRITES = new Set(['upload_group_file', 'upload_private_file', 'delete_qzone_msg']);
/**
 * 是否拦截一次调用：插件配置 dryRun=true 且是出站写操作
 * （send_* / set_* / delete_msg，加上 DRYRUN_EXTRA_WRITES 那三个）。
 * 读写类 action（get_msg / get_status / ocr_image 等）不受影响。
 */
export function isDryRunWrite(config, action) {
    if (config?.dryRun !== true)
        return false;
    return isWriteAction(action) || DRYRUN_EXTRA_WRITES.has(action);
}
/** 目标会话：group:<群号> / private:<QQ> / qzone / -（取不到）。 */
function dryRunSessionOf(action, params) {
    if (params?.group_id !== undefined && params.group_id !== null)
        return 'group:' + params.group_id;
    if (params?.user_id !== undefined && params.user_id !== null)
        return 'private:' + params.user_id;
    if (action === 'send_qzone_msg')
        return 'qzone';
    return '-';
}
/** 消息类型：send_msg 按 segments 推导（text/image/voice/video/file 或组合）；
 * 合并转发=forward、撤回=recall、正在输入=typing；其余（说说等）用 action 名。 */
function dryRunTypeOf(action, params) {
    if (action === 'send_msg') {
        const message = params?.message;
        if (Array.isArray(message)) {
            const types = [];
            for (const seg of message) {
                const t = typeof seg?.type === 'string' ? seg.type : 'unknown';
                if (!types.includes(t))
                    types.push(t);
            }
            return types.length > 0 ? types.join('+') : 'text';
        }
        return 'text';
    }
    if (action === 'send_forward_msg' || action === 'send_private_forward_msg')
        return 'forward';
    if (action === 'delete_msg')
        return 'recall';
    if (action === 'set_input_status')
        return 'typing';
    return action;
}
/** 内容截到前 120 字：换行/制表符折成空格，按码点切（避免劈开 emoji）。 */
function dryRunClip(text) {
    return Array.from(String(text).replace(/[\r\n\t]+/g, ' ').trim()).slice(0, 120).join('');
}
/** 内容预览：文本段取原文，非文本段记 [类型]；转发节点记「name: 内容」；
 * 撤回/正在输入记关键参数；其余 action 记参数 JSON。 */
function dryRunPreviewOf(action, params) {
    if (action === 'send_forward_msg' || action === 'send_private_forward_msg') {
        const nodes = Array.isArray(params?.messages) ? params.messages : [];
        return dryRunClip(nodes.map((node) => {
            const name = String(node?.data?.name ?? '');
            const content = Array.isArray(node?.data?.content)
                ? node.data.content.map((c) => c?.type === 'text' ? String(c.data?.text ?? '') : '[' + String(c?.type ?? '?') + ']').join('')
                : '';
            return (name !== '' ? name + ': ' : '') + content;
        }).join(' | '));
    }
    const message = params?.message;
    if (typeof message === 'string')
        return dryRunClip(message);
    if (Array.isArray(message)) {
        return dryRunClip(message
            .map((seg) => seg?.type === 'text' ? String(seg.data?.text ?? '') : '[' + String(seg?.type ?? '?') + ']')
            .join(' '));
    }
    if (action === 'delete_msg')
        return dryRunClip('msg=' + String(params?.message_id ?? ''));
    if (action === 'set_input_status')
        return dryRunClip('user_id=' + String(params?.user_id ?? ''));
    if (params !== undefined && params !== null) {
        try {
            return dryRunClip(JSON.stringify(params));
        }
        catch {
            return '[unserializable]';
        }
    }
    return '';
}
/** 组装一行试运行日志：ISO 时间、目标会话、消息类型、内容前 120 字（纯函数，自测直接验）。 */
export function dryRunLogLine(nowIso, action, params) {
    const parts = [nowIso, dryRunSessionOf(action, params), dryRunTypeOf(action, params)];
    const preview = dryRunPreviewOf(action, params);
    if (preview !== '')
        parts.push(preview);
    return parts.join(' ');
}
/** 等当前试运行日志追加链落盘（自测用；生产可不理）。 */
export function dryRunFlush() {
    return dryRunWriteChain;
}
/**
 * 拦截一次出站写：追加一行日志（写失败只 warn，绝不影响调用方），
 * 返回模拟成功。message_id 用负数标记——与注入 dry-run 共用「真 OneBot
 * id 不会是负数」的不变式，撤回这类标记 id 的 delete_msg 也会被一并拦下。
 */
export function dryRunIntercept(config, action, params, log) {
    const file = typeof config?.dryRunLogFile === 'string' && config.dryRunLogFile !== ''
        ? config.dryRunLogFile
        : DEFAULT_DRYRUN_LOG_FILE;
    const line = dryRunLogLine(new Date().toISOString(), action, params) + '\n';
    dryRunWriteChain = dryRunWriteChain.then(async () => {
        const dir = dirname(file);
        if (dryRunLogDir !== dir) {
            await mkdir(dir, { recursive: true });
            dryRunLogDir = dir;
        }
        if (dryRunLogSize < 0) {
            try {
                dryRunLogSize = (await stat(file)).size;
            }
            catch {
                dryRunLogSize = 0; // 文件还不存在
            }
        }
        if (dryRunLogSize + line.length > DRYRUN_LOG_MAX_BYTES) {
            // 轮转只留上一份：.1 涨满了直接换掉，试跑日志不留历史
            try {
                await rename(file, file + '.1');
            }
            catch {
                // 没有旧文件，第一次轮转
            }
            dryRunLogSize = 0;
        }
        await appendFile(file, line, 'utf8');
        dryRunLogSize += line.length;
    }).catch((error) => {
        dryRunLogDir = '';
        log?.('warn', 'dryRun 日志写入失败（不影响拦截）: ' + describeError(error));
    });
    // call() 的契约是返回 action 的 data 载荷（onFrame 里 resolve(msg.data)），
    // 所以这里只回 data 部分；负数 message_id 沿用注入 dry-run 的不变式。
    return { message_id: INTERCEPTED_MESSAGE_ID };
}
/**
 * OneBot 11 transport. One instance handles exactly one peer: either a
 * reverse server accepting NapCat's dial-in or a forward client dialing out.
 * All frames share the same correlation table.
 */
export class OneBotConnection {
    config;
    /** Inbound message event handler; the bridge/plugin wires this. */
    onMessage = () => undefined;
    /** Meta event handler (self_id learning). */
    onMeta = () => undefined;
    /** Connection-state callback. */
    onStatus = () => undefined;
    /**
     * W3/T4 (P3): fault-reference hook, called at the significant connection
     * failure points (forward reconnect give-up, reverse bind failure, reverse
     * server error) — the bridge implements it by minting/recording/tracing a
     * `QQ-CONN-…` reference; the returned reference is appended to the log
     * line so host logs and the trace file share the same number. Absent
     * (default) = the fault log lines keep their 0.8.1 wording unchanged.
     */
    onFailure = undefined;
    server;
    socket;
    lastPongAt = 0;
    heartbeatTimer;
    pending = new Map();
    /** 每日收发计数记录器（懒创建；2026-11-01 概览数字）。 */
    stats;
    stopping = false;
    reconnectPromise;
    reconnectTimer;
    reconnectAttempts = 0;
    connectedFlag = false;
    /** Reverse churn guard: timestamps (ms) of recent healthy-socket replacements. */
    reverseReplaces = [];
    /** W2-①: pending EADDRINUSE bind retry timer (reverse mode). */
    reverseRetryTimer;
    /** W2-①: bind failures since the last successful listen (log dedup + takeover count). */
    reverseRetryAttempts = 0;
    /** W2-④: pending self-heal dial timer (forward mode, after the ladder gave up). */
    selfHealTimer;
    /** W2-④: true from a self-heal dial start until it succeeds (routes failures back to self-heal). */
    selfHealing = false;
    /** W2-④: start timestamps (ms) of self-heal dials within the rolling hour. */
    selfHealTimes = [];
    /** The bot's own QQ id, learned from meta events (or config botQQ). */
    selfId = '';
    constructor(config) {
        this.config = config;
    }
    /** Whether the transport currently has a live socket. */
    get connected() {
        return this.connectedFlag;
    }
    /** The reverse server's bound address (for tests / diagnostics), if any. */
    address() {
        const address = this.server?.address();
        if (typeof address === 'object' && address !== null) {
            return { host: address.address, port: address.port };
        }
        return undefined;
    }
    /**
     * M3-E3b: the transport's single log exit. The injected config.log is the
     * production sink (index.ts wires the same deps.log the bridge uses); the
     * console fallback keeps the class independently usable. Messages carry no
     * '[dsh-onebot] ' prefix — the sink owns prefixing.
     */
    log(level, message) {
        if (this.config.log !== undefined) {
            this.config.log(level, message);
            return;
        }
        const line = '[dsh-onebot] ' + message;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
    }
    /** Start the transport (server or client) without blocking. */
    start() {
        // Reentrancy guard: a live socket/server, a pending reconnect, a pending
        // EADDRINUSE bind retry, or a pending self-heal dial means the transport
        // is already up (or about to dial/binding). Restarting blindly would
        // leave a stale timer dialing/binding into the new session (ghosts).
        if (this.socket !== undefined || this.server !== undefined || this.reconnectTimer !== undefined || this.reconnectPromise !== undefined || this.reverseRetryTimer !== undefined || this.selfHealTimer !== undefined) {
            return;
        }
        this.stopping = false;
        if (this.config.mode === 'reverse')
            this.startReverseServer();
        else
            void this.connectForwardOnce();
    }
    /** Stop the transport: close sockets, cancel reconnects, fail pending calls. */
    async stop() {
        this.stopping = true;
        // Cancel a pending reconnect dial: a stale timer firing into the next
        // start() would open a second (ghost) connection.
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.reconnectPromise = undefined;
        // W2-①: cancel a pending EADDRINUSE bind retry (stop() is the only exit
        // of that loop, so it must be able to kill it).
        if (this.reverseRetryTimer !== undefined) {
            clearTimeout(this.reverseRetryTimer);
            this.reverseRetryTimer = undefined;
        }
        this.reverseRetryAttempts = 0;
        // W2-④: cancel a pending self-heal dial the same way.
        if (this.selfHealTimer !== undefined) {
            clearTimeout(this.selfHealTimer);
            this.selfHealTimer = undefined;
        }
        this.selfHealing = false;
        this.selfHealTimes = [];
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        const socket = this.socket;
        this.socket = undefined;
        if (socket !== undefined) {
            socket.removeAllListeners();
            // 保命：close() 进入 CLOSING 窗口后对端仍可能发异常帧/ECONNRESET，
            // ws 会 emit 'error'；没有监听者的 'error' 会在 EventEmitter 上直接
            // 抛未捕获异常，把宿主进程带走。保留一个 no-op 监听直到 socket 消亡。
            socket.on('error', () => undefined);
            try {
                socket.close();
            }
            catch {
                // already closing
            }
        }
        await new Promise(resolve => {
            if (this.server === undefined) {
                resolve();
                return;
            }
            const server = this.server;
            this.server = undefined;
            server.close(() => resolve());
            // Force-resolve if close hangs (open client sockets keep it open).
            setTimeout(resolve, 2_000).unref();
            for (const client of server.clients) {
                try {
                    client.terminate();
                }
                catch {
                    // ignore
                }
            }
        });
        this.failAllPending(new OneBotNotConnectedError('OneBot transport stopped'));
    }
    /**
     * Call a OneBot action and await its data payload.
     * @param action - OneBot 11 action name.
     * @param params - action parameters (plain object).
     * @returns the action data payload (object or array).
     * @throws OneBotNotConnectedError / OneBotActionError on failure or timeout.
     */
    call(action, params) {
        // 试运行总闸（2026-11-01 dryRun 补丁）：dryRun 开启时所有出站写操作
        // 在此拦下——不碰 WebSocket、不调 NapCat API，改写日志并返回模拟
        // 成功。放在连通性判断之前：没有 NapCat 也能完整试跑。
        if (isDryRunWrite(this.config, action)) {
            this.recordOutbound(action, params); // 试跑也记数，否则概览永远是 0
            return Promise.resolve(dryRunIntercept(this.config, action, params, (level, message) => this.log(level, message)));
        }
        const socket = this.socket;
        if (socket === undefined || socket.readyState !== WebSocket.OPEN || this.stopping) {
            return Promise.reject(new OneBotNotConnectedError());
        }
        const echo = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new OneBotActionError('OneBot action ' + action + ' timed out after ' + this.config.callTimeoutMs + 'ms'));
            }, this.config.callTimeoutMs);
            this.pending.set(echo, { resolve, reject, timer, action, params });
            try {
                socket.send(JSON.stringify({ action, params, echo }));
            }
            catch (error) {
                this.pending.delete(echo);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new OneBotActionError(String(error)));
            }
        });
    }
    // ------------------------------------------------------------------ reverse
    startReverseServer() {
        // 2026-11-02 (fork): 空 accessToken 不再抛错。
        // 新装用户第一次启动时多半还没填 NapCat 口令；旧行为是在 ctx.effect 里
        // 同步抛错 -> Fiber FAILED -> 插件永远不 ACTIVE（DSH 市场上架验证的 L5.4 就挂在这）。
        // 现在改成安静待着：不监听端口、不崩溃、日志里说一句；设置页填好口令重启后自己起来。
        if (this.config.accessToken === '') {
            this.log('warn', 'QQ 通道还没配置：accessToken 是空的，先不监听端口。到设置页把 NapCat 的口令填上，保存后就会自动连。');
            return;
        }
        const server = new WebSocketServer({ host: this.config.host, port: this.config.port, maxPayload: MAX_FRAME_BYTES });
        this.server = server;
        server.on('error', error => {
            const code = error.code;
            if (code === 'EADDRINUSE') {
                this.scheduleReverseRetry(server, error);
                return;
            }
            // W3/T4: a non-EADDRINUSE server error is a significant bridge fault —
            // mint a QQ-CONN reference (bridge hook) and share it with the log line.
            const ref = this.onFailure?.('reverse-server-error', '反向 WS 服务器错误: ' + describeError(error));
            this.log('error', 'reverse WS server error: ' + describeError(error) + (ref !== undefined ? '（参考号 ' + ref + '）' : '') + errorStack(error));
        });
        server.on('connection', (socket, request) => {
            const expected = Buffer.from('Bearer ' + this.config.accessToken, 'utf8');
            const provided = Buffer.from(request.headers.authorization ?? '', 'utf8');
            if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
                this.log('warn', 'rejecting reverse WS client: bad access token');
                socket.close(4401, 'unauthorized');
                return;
            }
            // Last-wins: NapCat expects a single dial-in; close any older socket.
            const previous = this.socket;
            if (previous !== undefined && previous.readyState < WebSocket.CLOSING) {
                // Churn guard: endlessly replacing the healthy dial-in squeezes out
                // the legitimate NapCat, so cap replacements per rolling window.
                const now = Date.now();
                this.reverseReplaces = this.reverseReplaces.filter(at => now - at < CHURN_WINDOW_MS);
                if (this.reverseReplaces.length >= CHURN_MAX_REPLACES) {
                    this.log('warn', 'rejecting reverse WS client: too many connection replacements within ' + CHURN_WINDOW_MS / 1000 + 's');
                    socket.close(4000, 'too many connections');
                    return;
                }
                this.reverseReplaces.push(now);
                try {
                    previous.close(4000, 'replaced');
                }
                catch {
                    // ignore
                }
            }
            this.attachSocket(socket);
            this.startHeartbeat();
        });
        server.on('listening', () => {
            const address = server.address();
            const shown = typeof address === 'object' && address !== null ? address.address + ':' + address.port : String(address);
            if (this.reverseRetryAttempts > 0) {
                // W2-①: the port was released while a retry loop was pending — the
                // takeover is the user-visible payoff, so it gets its own info line.
                this.log('info', 'reverse WS server took over ' + this.config.host + ':' + this.config.port + ' after ' + this.reverseRetryAttempts + ' retry attempt(s): the port was released');
            }
            this.reverseRetryAttempts = 0;
            this.log('info', 'reverse WS server listening on ws://' + shown + ' (path /ws or /)');
        });
        server.on('close', () => {
            this.server = undefined;
            this.reverseRetryAttempts = 0;
        });
    }
    /**
     * W2-①: EADDRINUSE is no longer a dead end. ws does not emit 'close' after
     * a failed bind, so the failed instance would hang on this.server forever —
     * and the start() reentrancy guard would then block even a manual restart.
     * This handler (1) closes and detaches the dead instance, (2) logs with
     * steady-state dedup (first failure + one line per 10 minutes), and
     * (3) schedules a fixed 15s re-bind until the port is released or stop()
     * is called. No attempt cap; the timer is unref'd and the retry is never
     * awaited, so host startup stays unblocked and the loop cannot keep the
     * process alive on its own.
     */
    scheduleReverseRetry(server, error) {
        if (this.stopping)
            return;
        if (this.server !== server)
            return; // stale corpse: a newer bind attempt owns the state
        // 1) Dead-instance cleanup (best-effort): never listened → close may
        //    throw ERR_SERVER_NOT_RUNNING; swallow, the instance is a corpse.
        this.server = undefined;
        try {
            server.removeAllListeners();
            const handle = server._server;
            handle?.unref?.();
        }
        catch {
            // corpse cleanup is best-effort
        }
        try {
            server.close();
        }
        catch {
            // already handled above
        }
        // 2) Log with dedup: attempts 2..REVERSE_LOG_EVERY-1 stay at debug level.
        //    W3/T4: the reference is minted only when a line is actually logged
        //    (steady-state dedup — bind retries must not spam references).
        this.reverseRetryAttempts += 1;
        if (this.reverseRetryAttempts === 1 || this.reverseRetryAttempts % REVERSE_LOG_EVERY === 0) {
            const ref = this.onFailure?.('reverse-bind-failed', '反向 WS 服务器无法监听 ' + this.config.host + ':' + this.config.port + '：端口被占用（EADDRINUSE）');
            this.log('error', 'reverse WS server cannot listen on ' + this.config.host + ':' + this.config.port + ': port already in use (EADDRINUSE); stop the process occupying this port, or change config.port; retrying every ' + REVERSE_RETRY_MS / 1000 + 's until the port is released (attempt ' + this.reverseRetryAttempts + ')' + (ref !== undefined ? '（参考号 ' + ref + '）' : '') + errorStack(error));
        }
        else {
            this.log('debug', 'reverse WS server bind retry ' + this.reverseRetryAttempts + ': port ' + this.config.port + ' still in use');
        }
        // 3) Fixed 15s backoff, unref'd, no cap (stop() terminates the loop).
        this.reverseRetryTimer = setTimeout(() => {
            this.reverseRetryTimer = undefined;
            if (this.stopping)
                return;
            this.startReverseServer();
        }, REVERSE_RETRY_MS).unref();
    }
    // ------------------------------------------------------------------ forward
    connectForwardOnce() {
        if (this.stopping)
            return;
        const url = this.config.url;
        const headers = {};
        if (this.config.accessToken !== '')
            headers.Authorization = 'Bearer ' + this.config.accessToken;
        let socket;
        try {
            socket = new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES });
        }
        catch (error) {
            this.log('error', 'forward WS connect failed: ' + describeError(error) + errorStack(error));
            this.scheduleForwardRetry();
            return;
        }
        this.socket = socket;
        socket.on('open', () => {
            this.reconnectAttempts = 0;
            // W2-④: a successful dial (initial, ladder retry, or self-heal) fully
            // restores normal reconnect semantics and resets the self-heal budget.
            this.selfHealing = false;
            this.selfHealTimes = [];
            if (this.selfHealTimer !== undefined) {
                clearTimeout(this.selfHealTimer);
                this.selfHealTimer = undefined;
            }
            this.lastPongAt = Date.now();
            this.setConnected(true);
            this.startHeartbeat();
        });
        socket.on('message', data => this.onFrame(data));
        socket.on('pong', () => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial owns the timestamps
            this.lastPongAt = Date.now();
        });
        socket.on('error', error => {
            this.log('warn', 'forward WS error: ' + describeError(error));
        });
        socket.on('close', (code, reason) => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial has replaced it
            this.socket = undefined;
            this.stopHeartbeat();
            this.setConnected(false);
            this.failAllPending(new OneBotNotConnectedError('OneBot WS closed (code ' + code + ')'));
            this.scheduleForwardRetry();
        });
    }
    scheduleReconnect() {
        if (this.stopping || this.reconnectPromise !== undefined)
            return;
        this.reconnectAttempts += 1;
        // reconnectMaxAttempts: undefined -> built-in default, positive -> give up
        // once exceeded, 0 or negative -> retry forever (the ladder still caps the
        // delay at its last value).
        const max = this.config.reconnectMaxAttempts ?? MAX_RECONNECT_ATTEMPTS;
        if (max > 0 && this.reconnectAttempts > max) {
            // W3/T4: the give-up is the ladder's terminal fault point — one
            // QQ-CONN reference for the whole outage (individual ladder retries
            // stay reference-free to avoid fault storms).
            const ref = this.onFailure?.('forward-reconnect-give-up', 'forward 重连 ' + max + ' 次后放弃（reconnectMaxAttempts=' + max + '），转入慢速自愈');
            this.log('error', 'giving up forward WS reconnect after ' + max + ' retries (reconnectMaxAttempts=' + max + '); check the NapCat ws address and network, then restart the plugin or reload the dsh-onebot channel to reconnect; slow self-heal retries continue every ' + SELF_HEAL_INTERVAL_MS / 1000 + 's (capped at ' + SELF_HEAL_HOURLY_CAP + '/hour) until the peer comes back' + (ref !== undefined ? '（参考号 ' + ref + '）' : ''));
            this.scheduleSelfHeal();
            return;
        }
        const index = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF.length - 1);
        const delay = RECONNECT_BACKOFF[index] * 1000;
        this.reconnectPromise = new Promise(resolve => {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = undefined;
                this.reconnectPromise = undefined;
                resolve();
                this.connectForwardOnce();
            }, delay).unref();
        });
    }
    /**
     * Failure-path dispatcher: while a self-heal dial is in flight (selfHealing),
     * failures route back to the self-heal scheduler instead of the ladder, so
     * the give-up state is not silently rebuilt. Anything else keeps the ladder
     * semantics untouched.
     */
    scheduleForwardRetry() {
        if (this.selfHealing) {
            this.scheduleSelfHeal();
            return;
        }
        this.scheduleReconnect();
    }
    /**
     * W2-④: long-period recovery after the reconnect ladder gave up. Dials every
     * 15s, but a rolling-hour budget of SELF_HEAL_HOURLY_CAP attempts applies;
     * once exhausted the interval stretches to 60s, so a multi-hour outage dials
     * at most 15s×budget + 60/hour afterwards instead of hammering the peer.
     * The ladder state (reconnectAttempts) stays frozen at its give-up value; a
     * successful dial clears everything (see the 'open' handler).
     */
    scheduleSelfHeal() {
        if (this.stopping || this.selfHealTimer !== undefined)
            return;
        const now = Date.now();
        this.selfHealTimes = this.selfHealTimes.filter(at => now - at < HOUR_MS);
        const capped = this.selfHealTimes.length >= SELF_HEAL_HOURLY_CAP;
        const delay = capped ? SELF_HEAL_SLOW_INTERVAL_MS : SELF_HEAL_INTERVAL_MS;
        this.selfHealTimer = setTimeout(() => {
            this.selfHealTimer = undefined;
            if (this.stopping)
                return;
            this.selfHealTimes.push(Date.now());
            this.selfHealing = true;
            this.connectForwardOnce();
        }, delay).unref();
    }
    // ------------------------------------------------------------------ shared
    attachSocket(socket) {
        const previous = this.socket;
        this.socket = socket;
        this.lastPongAt = Date.now();
        socket.on('message', data => this.onFrame(data));
        socket.on('pong', () => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial-in owns the timestamps
            this.lastPongAt = Date.now();
        });
        socket.on('close', (code, reason) => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial-in replaced it
            this.socket = undefined;
            this.stopHeartbeat();
            this.setConnected(false);
            this.failAllPending(new OneBotNotConnectedError('OneBot WS closed (code ' + code + ')'));
            if (!this.stopping) {
                this.log('warn', 'reverse WS client disconnected: ' + code + ' ' + reason.toString());
            }
        });
        socket.on('error', error => {
            this.log('warn', 'reverse WS client error: ' + describeError(error));
        });
        this.setConnected(true);
        if (previous !== undefined && previous !== socket && previous.readyState < WebSocket.CLOSING) {
            try {
                previous.close(4000, 'replaced');
            }
            catch {
                // ignore
            }
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const socket = this.socket;
            if (socket === undefined)
                return;
            if (socket.readyState !== WebSocket.OPEN)
                return;
            const now = Date.now();
            if (now - this.lastPongAt >= 2 * HEARTBEAT_MS) {
                this.log('warn', 'heartbeat timeout: no pong for ' + (now - this.lastPongAt) + 'ms (mode=' + this.config.mode + '); terminating socket');
                socket.terminate();
                return;
            }
            try {
                socket.ping();
            }
            catch {
                // socket may be closing
            }
        }, HEARTBEAT_MS).unref();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
    setConnected(connected) {
        if (this.connectedFlag === connected)
            return;
        this.connectedFlag = connected;
        try {
            this.onStatus(connected);
        }
        catch (error) {
            this.log('error', 'onStatus handler failed: ' + describeError(error) + errorStack(error));
        }
    }
    failAllPending(error) {
        for (const [echo, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    /** 每日计数记录器（懒创建；统计失败不影响通道）。 */
    statsRecorder() {
        if (this.stats === undefined) {
            this.stats = new DailyStatsRecorder({ dir: this.config?.statsDir, log: (level, message) => this.log(level, message) });
        }
        return this.stats;
    }
    /** 出站计数：只算真的发出去的内容（读调用、撤回、正在输入不计）。
     *  整体包 try/catch——统计是旁路，任何时候都不许把发消息拖垮。 */
    recordOutbound(action, params) {
        try {
            if (typeof action !== 'string')
                return;
            if (!isWriteAction(action) && !DRYRUN_EXTRA_WRITES.has(action))
                return;
            const stats = this.statsRecorder();
            if (action === 'send_msg') {
                stats.recordKinds('out', kindsOfSegments(params?.message));
                return;
            }
            if (action === 'send_forward_msg' || action === 'send_private_forward_msg') {
                stats.record('out', 'forward');
                return;
            }
            if (action === 'delete_msg' || action === 'set_input_status')
                return;
            stats.record('out', 'other');
        }
        catch (error) {
            this.log('warn', '统计出站计数失败（不影响消息）: ' + describeError(error));
        }
    }
    /** 入站计数（同样整体守住：统计出错不许影响收消息）。 */
    recordInbound(event) {
        try {
            this.statsRecorder().recordKinds('in', kindsOfSegments(event?.message));
        }
        catch (error) {
            this.log('warn', '统计入站计数失败（不影响消息）: ' + describeError(error));
        }
    }
    /** One JSON frame: an action response (has echo) or an inbound event. */
    onFrame(data) {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        }
        catch {
            this.log('warn', 'dropping non-JSON WS frame');
            return;
        }
        if (typeof payload !== 'object' || payload === null)
            return;
        const frame = payload;
        if (typeof frame.echo === 'string' && this.pending.has(frame.echo)) {
            const pending = this.pending.get(frame.echo);
            this.pending.delete(frame.echo);
            if (pending === undefined)
                return;
            clearTimeout(pending.timer);
            if (frame.status === 'ok') {
                this.recordOutbound(pending.action, pending.params);
                pending.resolve(frame.data ?? {});
            }
            else {
                const wording = typeof frame.wording === 'string' ? frame.wording : '';
                const retcode = frame.retcode ?? 'unknown';
                pending.reject(new OneBotActionError('OneBot action failed (retcode ' + retcode + ')' + (wording !== '' ? ': ' + wording : '')));
            }
            return;
        }
        if (typeof frame.post_type === 'string') {
            const event = frame;
            if (typeof event.self_id === 'number' || typeof event.self_id === 'string') {
                this.selfId = String(event.self_id);
            }
            if (event.post_type === 'message') {
                try {
                    this.recordInbound(event);
                    this.onMessage(event);
                }
                catch (error) {
                    this.log('error', 'onMessage handler failed: ' + describeError(error) + errorStack(error));
                }
                return;
            }
            if (event.post_type === 'meta_event') {
                try {
                    this.onMeta(event);
                }
                catch (error) {
                    this.log('error', 'onMeta handler failed: ' + describeError(error) + errorStack(error));
                }
                return;
            }
            // notice / request events are intentionally ignored (v1).
        }
    }
}
