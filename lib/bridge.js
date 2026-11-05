/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { transcriptLabel } from './stt.js';
import { buildChatId, classifyUserRole, RESTRICTED_PREFIX, splitChatId } from './chat.js';
import { buildPlatformPrompt } from './prompt.js';
import { registerTools } from './tools.js';
import { tryHandleCommand as routeCommand, STEER_ACCEPTED_NOTICE } from './commands.js';
import { relayHostCards as relayCards } from './card-relay.js';
import { OutboundPipeline } from './outbound.js';
import { ChatRegistry } from './registry.js';
import { InboundPipeline, normalizeOneBot11 } from './inbound.js';
import { InterimTracker } from './interim.js';
import { DeferredDelivery } from './deferred.js';
import { DEFAULT_DEFERRED_TIMEOUT_MS } from './deferred.js';
import { describeError, errorStack } from './errors.js';
import { currentTrace, newTraceId, runWithTrace, TRACE_REASONS } from './trace.js';
import { runInjectRound, currentInjectRound, isWriteAction, INTERCEPTED_MESSAGE_ID } from './inject.js';
import { healthReport, exportDiagnostics } from './health.js';
import { FailureRefRegistry, failureRefSuffix } from './ref.js';
import { stripInternalTags } from './split.js';
import { kindsOfSegments } from './stats.js';
import { backfillMissedMessages } from './backfill.js';
/** T2 (P1): the queue notice sent to a chat when a message arrives while its
 * task is running under the default 'queue' policy — at most ONE per running
 * turn (the flag resets at turn/end) so a burst of queued messages never
 * spams the chat. Exported for the deterministic text wait in tests. */
export const QUEUE_NOTICE_TEXT = '⏳ 手上这步还没干完，你说的我记着了，忙完就回你。';
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
/** 入站合并窗口：同一 chat 在 10s 内连续发送的文本/图片消息合并成一轮。 */
const INBOUND_MERGE_WINDOW_MS = 10000;
/** 静默看门狗：默认「多少毫秒没有任何入站事件」算可疑静默（15 分钟）。 */
const WATCHDOG_DEFAULT_SILENCE_MS = 900_000;
/** 静默看门狗：默认探测节奏（每 60 秒看一眼）。 */
const WATCHDOG_DEFAULT_CHECK_INTERVAL_MS = 60_000;
/** 掉线确认窗口：WS 一断先等 30 秒，窗口内重连就当作抖动，不推外部告警。 */
const WATCHDOG_DEFAULT_CONFIRM_MS = 30_000;
/** 外部告警通道配置：放在 mediaDir 下，没有这个文件就等于没配告警。 */
const WATCHDOG_ALERT_CONFIG_FILE = 'alert-channel.json';
/** 外部告警单次推送的硬超时：推送服务卡住也不能拖住看门狗。 */
const WATCHDOG_ALERT_TIMEOUT_MS = 10_000;
/** 群聊工具闸（guard 档）：管理员回合也只放行这张小单子（2026-10-31 收紧）。 */
const GROUP_GUARD_ADMIN_TOOLS = new Set(['qq_send_image', 'qq_send_file', 'qq_send_voice', 'qq_send_video', 'qq_send_forward', 'qq_send_group_msg', 'read', 'glob', 'grep']);
/** 本地墙钟 HH:MM（管理员通报里的时间范围）。 */
function watchdogHhmm(at) {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
/** 正有限数或回退值：坏配置不能把看门狗关掉。 */
function watchdogPositiveNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** 本地墙钟 yyyy-MM-dd HH:mm:ss（外部告警正文要精确到秒，HH:MM 不够）。 */
function watchdogStamp(at) {
    const date = new Date(at);
    const two = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate())
        + ' ' + two(date.getHours()) + ':' + two(date.getMinutes()) + ':' + two(date.getSeconds());
}
/**
 * Server酱 的推送地址：SendKey 以 sctp 开头的是 Turbo/³ 版，地址形如
 * https://<uid>.push.ft07.com/send/<sendKey>.send（uid 就藏在 sctp<uid>t<token>
 * 里）；其余按旧版 Server酱 走 sctapi.ftqq.com。sctp 前缀却解不出 uid 的键
 * 是写坏了，返回 undefined 让调用方跳过而不是去撞一个必然 404 的地址。
 * @param sendKey 配置里的 serverChanSendKey（已 trim，非空）。
 * @returns 完整推送 URL，或 undefined（键格式不认识）。
 */
function serverChanEndpoint(sendKey) {
    const turbo = /^sctp(\d+)t(.+)$/i.exec(sendKey);
    if (turbo !== null)
        return 'https://' + turbo[1] + '.push.ft07.com/send/' + encodeURIComponent(sendKey) + '.send';
    if (/^sctp/i.test(sendKey))
        return undefined;
    return 'https://sctapi.ftqq.com/' + encodeURIComponent(sendKey) + '.send';
}
/**
 * 建一个静默看门狗：WS 层还连着、但长时间没有任何入站事件时，探测一次
 * get_status / get_login_info，把样本以一行 JSON 追加到 stateFile；若探测
 * 到登录态掉了就挂起事件，恢复时向管理员报一次「断了多久」。
 *
 * 2026-10-24（掉线必告警）：WS 层断开不再静默——onStatus 一给 false 就落一行
 * incident 证据并起 30s 确认窗口，窗口内重连当作抖动（取消待发告警），窗口
 * 到期仍然断着才推第一条外部告警（Server酱 → 微信）；重连落一行 recovered。
 * 断开期间 60s 定时器照常跳，但不再靠 connection.connected 决定探不探。
 *
 * 设计约束：每轮探测绝不与下一轮重叠（慢调用不堆积）；定时器 unref；任何
 * 异常都在内部吞掉并写日志——看门狗自身绝不把错误抛给宿主。
 *
 * @param options 看门狗接线：connection（有 connected、selfId 与 call）、log、
 *                stateFile、mediaDir（放 alert-channel.json）、notifyAdmin、
 *                adminUid、silenceMs、checkIntervalMs、confirmMs。
 * @returns { start, stop, noteInbound, noteConnected, noteDisconnected, getStats }，
 *          每个方法的输入都是全量的：无效输入与失败的下游只记日志，不抛。
 */
function createSilenceWatchdog(options = {}) {
    const connection = options.connection;
    const stateFile = typeof options.stateFile === 'string' ? options.stateFile : '';
    const mediaDir = typeof options.mediaDir === 'string' ? options.mediaDir : '';
    const notifyAdmin = typeof options.notifyAdmin === 'function' ? options.notifyAdmin : undefined;
    const adminUid = options.adminUid === undefined || options.adminUid === null ? '' : String(options.adminUid);
    const silenceMs = watchdogPositiveNumber(options.silenceMs, WATCHDOG_DEFAULT_SILENCE_MS);
    const checkIntervalMs = watchdogPositiveNumber(options.checkIntervalMs, WATCHDOG_DEFAULT_CHECK_INTERVAL_MS);
    const confirmMs = watchdogPositiveNumber(options.confirmMs, WATCHDOG_DEFAULT_CONFIRM_MS);
    const sink = typeof options.log === 'function'
        ? options.log
        : (connection !== undefined && connection !== null && typeof connection.log === 'function'
            ? (level, message) => connection.log(level, message)
            : undefined);
    let timer;
    // 基线取「现在」：新进程先白拿一个完整窗口，不会在第一跳就报警。
    let lastInboundAt = Date.now();
    let pendingIncidentSince;
    let checks = 0;
    let badChecks = 0;
    let checking = false;
    let loggedStateFileFailure = false;
    // 断线侧状态：disconnectedAt 是本轮断线的锚点，有它就说明 WS 现在是断的，
    // 定时器据此走告警分支（不再看 connection.connected）；alertedAt 记住本轮
    // 事件已经推过外部告警，避免 60s 一跳就重推一条；lastDisconnectAt 只进
    // getStats，incidentCount 记「从正常转异常」的次数。
    let disconnectedAt;
    let lastDisconnectAt;
    let lastDisconnectReason = '连接断开（未上报原因）';
    let alertedAt;
    let incidentCount = 0;
    let loggedAlertConfigFailure = false;
    /** 日志 sink 坏掉也不能把看门狗带崩。 */
    function logLine(level, message) {
        if (sink === undefined)
            return;
        try {
            sink(level, message);
        }
        catch {
            // a throwing sink is the sink's problem
        }
    }
    /** 一轮探测不能和下一轮重叠（慢调用会堆积）。 */
    function invoke(action) {
        try {
            if (connection === undefined || connection === null || typeof connection.call !== 'function')
                return Promise.reject(new Error('connection.call is not available'));
            return Promise.resolve(connection.call(action, {}));
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    /** 两个动作并行探测：被拒的调用算「这轮不正常」，不是崩溃。 */
    async function probe() {
        const [statusResult, loginResult] = await Promise.allSettled([
            invoke('get_status'),
            invoke('get_login_info'),
        ]);
        const status = statusResult.status === 'fulfilled' && statusResult.value !== null && typeof statusResult.value === 'object'
            ? statusResult.value
            : {};
        const login = loginResult.status === 'fulfilled' && loginResult.value !== null && typeof loginResult.value === 'object'
            ? loginResult.value
            : {};
        const statusOk = statusResult.status === 'fulfilled';
        const loginOk = loginResult.status === 'fulfilled';
        const online = statusOk && status.online === true;
        const good = statusOk && status.good === true;
        const userId = login.user_id === undefined || login.user_id === null ? '' : String(login.user_id);
        const nickname = typeof login.nickname === 'string' ? login.nickname : '';
        return { statusOk, loginOk, online, good, userId, nickname, bad: !statusOk || !loginOk || !online };
    }
    /** 追加一行样本；失败只报一次，之后静默。 */
    async function appendRecord(record) {
        if (stateFile === '') {
            if (!loggedStateFileFailure) {
                loggedStateFileFailure = true;
                logLine('warn', 'watchdog: stateFile is not configured, probe samples are dropped');
            }
            return;
        }
        try {
            await mkdir(dirname(stateFile), { recursive: true });
            await appendFile(stateFile, JSON.stringify(record) + '\n', 'utf8');
        }
        catch (error) {
            if (!loggedStateFileFailure) {
                loggedStateFileFailure = true;
                logLine('warn', 'watchdog: cannot append to ' + stateFile + ': ' + describeError(error));
            }
        }
    }
    /** 读 mediaDir 下的 alert-channel.json：文件不在就静默跳过（等于没配），
     * 读得到却读不动/解析不了才记一次日志，之后不再刷。 */
    async function alertChannel() {
        if (mediaDir === '')
            return undefined;
        let text;
        try {
            text = await readFile(mediaDir + '/' + WATCHDOG_ALERT_CONFIG_FILE, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                if (!loggedAlertConfigFailure) {
                    loggedAlertConfigFailure = true;
                    logLine('warn', 'watchdog: cannot read ' + WATCHDOG_ALERT_CONFIG_FILE + ': ' + describeError(error));
                }
            }
            return undefined;
        }
        try {
            const parsed = JSON.parse(text);
            return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
        }
        catch (error) {
            if (!loggedAlertConfigFailure) {
                loggedAlertConfigFailure = true;
                logLine('warn', 'watchdog: ' + WATCHDOG_ALERT_CONFIG_FILE + ' is not valid JSON: ' + describeError(error));
            }
            return undefined;
        }
    }
    /** 当前 bot 号（只用于告警正文，取不到就写「未知」）。 */
    function selfIdText() {
        const value = connection === undefined || connection === null ? undefined : connection.selfId;
        return value === undefined || value === null || value === '' ? '未知' : String(value);
    }
    /**
     * 外部告警：Server酱 推微信。没配通道（文件不在 / key 为空）就静默跳过；
     * 推送失败、超时、HTTP 非 2xx 一律只 log——告警路径绝不能反过来崩掉宿主。
     * @param title 推送标题。
     * @param desp 推送正文（纯文本，Server酱 按 Markdown 渲染）。
     */
    async function sendExternalAlert(title, desp) {
        try {
            const config = await alertChannel();
            const rawKey = config === undefined || config.serverChanSendKey === undefined || config.serverChanSendKey === null
                ? ''
                : String(config.serverChanSendKey).trim();
            if (rawKey === '')
                return;
            if (typeof fetch !== 'function') {
                logLine('warn', 'watchdog: global fetch is unavailable, external alert dropped');
                return;
            }
            const endpoint = serverChanEndpoint(rawKey);
            if (endpoint === undefined) {
                logLine('warn', 'watchdog: serverChanSendKey is malformed (expect sctp<uid>t<token>), external alert dropped');
                return;
            }
            const body = new URLSearchParams({ title, desp }).toString();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), WATCHDOG_ALERT_TIMEOUT_MS);
            if (typeof timeoutId.unref === 'function')
                timeoutId.unref();
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
                    body,
                    signal: controller.signal,
                });
                if (!response.ok) {
                    logLine('warn', 'watchdog: external alert rejected: HTTP ' + response.status);
                    return;
                }
                logLine('info', 'watchdog: external alert pushed: ' + title);
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (error) {
            logLine('warn', 'watchdog: external alert failed: ' + describeError(error));
        }
    }
    /** 恢复推送：只有配置里 notifyRecovery 为 true 才发（默认关，免得一天几条）。 */
    async function sendRecoveryAlert(since, now) {
        try {
            const config = await alertChannel();
            if (config === undefined || config.notifyRecovery !== true)
                return;
            const minutes = Math.max(1, Math.round((now - since) / 60_000));
            await sendExternalAlert('蓝鱼恢复：DSH QQ 连接已重连', '时间：' + watchdogStamp(now)
                + '\n断开时长：约 ' + minutes + ' 分钟（' + watchdogStamp(since) + ' 起）'
                + '\nQQ 桥接已恢复，消息可以正常收发。');
        }
        catch (error) {
            logLine('warn', 'watchdog: recovery alert failed: ' + describeError(error));
        }
    }
    /** 确认窗口到期：推掉线告警（正文带时间、原因、静默秒数、最后一条入站时间）。 */
    async function alertDisconnect(now) {
        const since = disconnectedAt === undefined ? now : disconnectedAt;
        const downSec = Math.max(0, Math.round((now - since) / 1000));
        const silenceSec = Math.max(0, Math.round((now - lastInboundAt) / 1000));
        logLine('warn', 'watchdog: external alert for ' + downSec + 's disconnected (' + lastDisconnectReason + ')');
        await sendExternalAlert('蓝鱼掉线：DSH QQ 连接已断开', '时间：' + watchdogStamp(now)
            + '\n原因：' + lastDisconnectReason
            + '\n已断开：' + downSec + ' 秒（' + watchdogStamp(since) + ' 起）'
            + '\nsilenceSec：' + silenceSec
            + '\n最后一条入站：' + watchdogStamp(lastInboundAt)
            + '\n实例：' + selfIdText());
    }
    /** 恢复通报：失败吞掉，只记日志。 */
    async function notifyRecovered(since, now) {
        const minutes = Math.max(1, Math.round((now - since) / 60_000));
        if (notifyAdmin === undefined) {
            logLine('info', 'watchdog: login recovered after about ' + minutes + ' minute(s), notifyAdmin not configured');
            return;
        }
        const text = '上次 QQ 登录状态断了约 ' + minutes + ' 分钟（' + watchdogHhmm(since) + ' 到 ' + watchdogHhmm(now) + '），可能是被踢下线，现已恢复';
        try {
            await notifyAdmin(text);
            logLine('info', 'watchdog: login recovered after about ' + minutes + ' minute(s)' + (adminUid !== '' ? ', admin ' + adminUid + ' notified' : ''));
        }
        catch (error) {
            logLine('warn', 'watchdog: notifyAdmin failed: ' + describeError(error));
        }
    }
    /** 一轮定时检查：每轮都落一行 sample（连没连着都有证据）；断线走告警分支，
     * 不探登录态；连着且静默超阈值才探测。整个函数自吞异常，绝不中断定时器。 */
    async function checkOnce() {
        if (checking)
            return;
        checking = true;
        try {
            const now = Date.now();
            const silenceSec = Math.max(0, Math.round((now - lastInboundAt) / 1000));
            const connected = connection !== undefined && connection !== null && connection.connected === true;
            /** 每轮只落一行 sample：断开、静默、探测三种去向共用同一套基础字段。 */
            const sample = (extra = {}) => {
                void appendRecord({
                    type: 'sample',
                    ts: now,
                    iso: new Date(now).toISOString(),
                    connected,
                    silenceSec,
                    lastInboundAt,
                    ...extra,
                });
            };
            // 断线分支：不看 connection.connected 决定探不探——onStatus 已经给过
            // 明确断开证据（disconnectedAt），这里只管确认窗口和告警；真正没连上
            // 却又没有 onStatus 的极端情况也兜在这里，免得永远不告警。
            if (disconnectedAt !== undefined || !connected) {
                sample({ reason: lastDisconnectReason });
                if (disconnectedAt === undefined) {
                    disconnectedAt = now;
                    if (pendingIncidentSince === undefined) {
                        pendingIncidentSince = now;
                        incidentCount += 1;
                    }
                }
                if (alertedAt === undefined && now - disconnectedAt >= confirmMs) {
                    alertedAt = now;
                    await alertDisconnect(now);
                }
                return;
            }
            if (now - lastInboundAt <= silenceMs) {
                sample();
                return;
            }
            checks += 1;
            const result = await probe();
            sample({
                statusOk: result.statusOk,
                online: result.online,
                good: result.good,
                loginOk: result.loginOk,
                userId: result.userId,
                nickname: result.nickname,
            });
            // 2026-11-02 P0：探测样本喂状态存储（设置页徽标的「NapCat 登录态」；
            // 旁路，异常不影响看门狗自身）。
            if (typeof options.onSample === 'function') {
                try {
                    options.onSample({
                        statusOk: result.statusOk === true,
                        online: result.online === true,
                        loginOk: result.loginOk === true,
                    });
                }
                catch {
                    // 旁路钩子异常吞掉
                }
            }
            if (result.bad) {
                badChecks += 1;
                if (pendingIncidentSince === undefined) {
                    pendingIncidentSince = now;
                    incidentCount += 1;
                    logLine('warn', 'watchdog: QQ login looks offline after ' + silenceSec + 's of silence (statusOk=' + result.statusOk + ', loginOk=' + result.loginOk + ', online=' + result.online + '); waiting for recovery');
                }
                return;
            }
            const since = pendingIncidentSince;
            if (since !== undefined) {
                pendingIncidentSince = undefined;
                await notifyRecovered(since, now);
            }
        }
        catch (error) {
            logLine('error', 'watchdog: check failed: ' + describeError(error));
        }
        finally {
            checking = false;
        }
    }
    /** 起 unref 过的定时器；重复调用是空操作。 */
    function start() {
        try {
            if (timer !== undefined)
                return;
            timer = setInterval(() => {
                void checkOnce();
            }, checkIntervalMs);
            if (typeof timer.unref === 'function')
                timer.unref();
            logLine('info', 'watchdog: started (silence ' + silenceMs / 1000 + 's, every ' + checkIntervalMs / 1000 + 's)');
        }
        catch (error) {
            logLine('error', 'watchdog: start failed: ' + describeError(error));
        }
    }
    /** 停表；重复调用或未 start 都安全。 */
    function stop() {
        try {
            if (timer === undefined)
                return;
            clearInterval(timer);
            timer = undefined;
            logLine('info', 'watchdog: stopped');
        }
        catch (error) {
            logLine('error', 'watchdog: stop failed: ' + describeError(error));
        }
    }
    /** 喂一个入站事件类型。meta_event 故意不算：心跳只证明 socket 活着，
     * 不证明 QQ 还在送消息。 */
    function noteInbound(postType) {
        try {
            if (postType === 'meta_event')
                return;
            lastInboundAt = Date.now();
        }
        catch (error) {
            logLine('error', 'watchdog: noteInbound failed: ' + describeError(error));
        }
    }
    /**
     * WS 层断开（由 connection.onStatus(false) 立刻调用）：马上落一行 incident
     * 证据并起确认窗口锚点。告警不在这里发——30s 窗口内重连成功就当作抖动。
     * @param reason 断开原因（传输层只给布尔值，这里由接线处填一句人话）。
     */
    function noteDisconnected(reason) {
        try {
            const now = Date.now();
            lastDisconnectAt = now;
            const text = typeof reason === 'string' && reason !== '' ? reason : '连接断开（未上报原因）';
            lastDisconnectReason = text;
            if (disconnectedAt === undefined) {
                disconnectedAt = now;
                if (pendingIncidentSince === undefined) {
                    pendingIncidentSince = now;
                    incidentCount += 1;
                }
                logLine('warn', 'watchdog: ' + text + '; waiting ' + Math.round(confirmMs / 1000) + 's before the external alert');
            }
            void appendRecord({
                type: 'incident',
                ts: now,
                iso: new Date(now).toISOString(),
                reason: text,
                silenceSec: Math.max(0, Math.round((now - lastInboundAt) / 1000)),
                lastInboundAt,
            });
        }
        catch (error) {
            logLine('error', 'watchdog: noteDisconnected failed: ' + describeError(error));
        }
    }
    /**
     * WS 层重连（由 connection.onStatus(true) 调用）：落一行 recovered；如果本轮
     * 断线还在确认窗口里（没推过告警）就直接取消，若已经推过告警就补一条恢复
     * 通报（QQ 管理员照旧 + notifyRecovery 为 true 时推微信）。
     */
    function noteConnected() {
        try {
            const now = Date.now();
            const since = disconnectedAt;
            const downSec = since === undefined ? 0 : Math.max(0, Math.round((now - since) / 1000));
            disconnectedAt = undefined;
            void appendRecord({
                type: 'recovered',
                ts: now,
                iso: new Date(now).toISOString(),
                silenceSec: Math.max(0, Math.round((now - lastInboundAt) / 1000)),
                lastInboundAt,
                downSec,
            });
            // 只有 WS 掉线产生的事件锚点归这里收尾；纯探测事件留给 checkOnce。
            if (since === undefined)
                return;
            const alerted = alertedAt !== undefined;
            alertedAt = undefined;
            pendingIncidentSince = undefined;
            if (!alerted) {
                logLine('info', 'watchdog: reconnected after ' + downSec + 's, inside the confirmation window — pending alert cancelled');
                return;
            }
            void notifyRecovered(since, now);
            void sendRecoveryAlert(since, now);
        }
        catch (error) {
            logLine('error', 'watchdog: noteConnected failed: ' + describeError(error));
        }
    }
    /** 只读快照，供诊断/健康检查用。原有字段全保留，只做新增。 */
    function getStats() {
        try {
            return {
                connected: connection !== undefined && connection !== null && connection.connected === true,
                lastInboundAt,
                silenceSec: Math.max(0, Math.round((Date.now() - lastInboundAt) / 1000)),
                pendingIncidentSince,
                lastDisconnectAt,
                incidentCount,
                checks,
                badChecks,
            };
        }
        catch {
            return {
                connected: false,
                lastInboundAt,
                silenceSec: 0,
                pendingIncidentSince,
                lastDisconnectAt,
                incidentCount,
                checks,
                badChecks,
            };
        }
    }
    return { start, stop, noteInbound, noteConnected, noteDisconnected, getStats };
}
/** B1（2026-11-05）：steer 路径的 payload 整形。先剥边界外的受信任前缀
 * （受限标签 + 群时间戳前缀），再保留 <user_message> 边界——与 followup 路径
 * 形状一致。绝不能对整段调用 stripInternalTags：INTERNAL_TAGS 含 user_message，
 * 无锚定正则会连边界带正文整块删掉，忙时插话直接消失。
 * 返回 '' 表示没有可送的内容（调用方按「空内容丢弃」处理）。 */
const STEER_BOUNDARY = /^\s*(<user_message\b[^>]*>)([\s\S]*)(<\/user_message\s*>)\s*$/i;
const STEER_GROUP_PREFIX = /^\[\d{2}:\d{2} .*?\(\d+\)\](?:\[@我\])? /;
export function shapeSteerPayload(text) {
    let out = String(text ?? '');
    if (out.startsWith(RESTRICTED_PREFIX))
        out = out.slice(RESTRICTED_PREFIX.length);
    const groupPrefix = STEER_GROUP_PREFIX.exec(out);
    if (groupPrefix !== null)
        out = out.slice(groupPrefix[0].length);
    out = out.trim();
    if (out === '')
        return '';
    const whole = STEER_BOUNDARY.exec(out);
    if (whole !== null) {
        const inner = stripInternalTags(whole[2]).trim();
        return inner === '' ? '' : whole[1] + inner + whole[3];
    }
    // 前缀剥完边界仍不在串首（昵称里带 ] 等极端情况）：宽松兜底，从第一个
    // 开标签到最后一个闭标签保留边界——宁可多留框架，也不把消息清空。
    const open = /<user_message\b[^>]*>/i.exec(out);
    if (open !== null) {
        const closeAll = /<\/user_message\s*>/gi;
        let last = null;
        for (let match = closeAll.exec(out); match !== null; match = closeAll.exec(out))
            last = match;
        if (last !== null && last.index >= open.index + open[0].length) {
            const inner = stripInternalTags(out.slice(open.index + open[0].length, last.index)).trim();
            return inner === '' ? '' : open[0] + inner + last[0];
        }
    }
    return stripInternalTags(out).trim();
}
export class ChatBridge {
    deps;
    /** Outbound pipeline (D1-PR2): the same-name bridge methods below delegate here. */
    outbound;
    /** The chat↔session registry (D1-PR3): chats/bySession dual index, the
     * persistence pair, per-chat settings and the create/resume assembly. */
    registry;
    /** Inbound pipeline (D1-PR4): normalizeOneBot11 + the policy→media→quote→
     * dispatch path; the same-name bridge methods below delegate here. */
    inbound;
    /** Interim domain (D1-PR5): the assistant/message interim routing, the
     * per-message recall timers and the turn/end settlement. */
    interim;
    /** T3 (P2): the deferred-delivery tracker (超时补发) — timeout timers, the
     * JSONL registry, bounded send retries and restart recovery. */
    deferred;
    /** T4 (P3): the bounded registry of recent fault references — every minted
     * QQ-CONN-/MF- number is recorded here for the /healthcheck report and the
     * diagnostics archive file name. */
    failureRefs = new FailureRefRegistry();
    /** Live registry indexes — the inbound/outbound/interim/turn links keep
     * reading them through these same-name views. */
    get chats() { return this.registry.chats; }
    get bySession() { return this.registry.bySession; }
    sessionEventOff;
    sessionFlushOff;
    /** W1: chat-level traceId association table — session events arrive on a
     * different async chain than the inbound pipeline, so dispatchFollowup
     * records the initiating traceId per chat here and onSessionEvent reads it
     * back (agent 回复事件归属发起 traceId). Last dispatch wins; entries are
     * dropped when the chat is removed. Not cleared at turn/end: the interim
     * settle loop sends the final reply AFTER turn/end, and clearing there
     * would orphan exactly that reply's outbound events. One entry per chat
     * id (bounded by the chat population), so growth is not a concern. */
    traceByChat = new Map();
    /** W1/T5: chatId → the traceId of the chat's unsettled INJECTED round
     * (independent of the trace sink, so the dry-run guard covers the async
     * agent reply even with tracing off). Cleared by a real dispatch to the
     * chat or when the chat is removed. */
    injectRoundByChat = new Map();
    /** 入站合并：chatId → { events, timer }，同一 chat 在窗口内连续发送的
     * 文本/图片消息先缓冲，窗口结束（或命令到达）时合并成一轮交给 pipeline。 */
    inboundMergeMap = new Map();
    /** 静默看门狗：WS 层连着、QQ 却长时间不送消息时探测登录态并留证据，
     * 恢复后给管理员报一次断线时长（诊断「看着在线却收不到消息」）。 */
    watchdog;
    /** T2 (P1): chats that already got the QUEUE_NOTICE_TEXT for their current
     * running turn (one notice per turn; cleared at turn/end and on chat
     * removal — bounded by the chat population). */
    queueNoticeChats = new Set();
    /** 2026-11-05 断线补拉：WS 断开的时刻（epoch ms）；undefined = 当前没在断线。 */
    reconnectSince;
    /** 2026-11-05 断线补拉防重入（一次重连只补一次）。 */
    backfillRunning = false;
    /** Plugin version + git commit, read once for /ver. */
    pluginVersion;
    pluginCommit;
    stopping = false;
    constructor(deps) {
        this.deps = deps;
        this.registry = new ChatRegistry({
            agents: deps.agents,
            sessions: deps.sessions,
            sessionPersistence: deps.sessionPersistence,
            workspaceRegistry: deps.workspaceRegistry,
            agentPresets: deps.agentPresets,
            defaultModel: deps.defaultModel,
            config: deps.config,
            log: (level, message) => deps.log(level, message),
            isStopping: () => this.stopping,
            onChatRemoved: chat => {
                this.stopTyping(chat);
                // W1/T5: forget the chat's injected round (and its trace mapping).
                this.deps.config.inject?.clearChat(chat.chatId);
                this.traceByChat.delete(chat.chatId);
                this.injectRoundByChat.delete(chat.chatId);
                this.queueNoticeChats.delete(chat.chatId);
            },
            installChannelScope: (agentCtx, chatId) => this.installChannelScope(agentCtx, chatId),
        });
        this.outbound = new OutboundPipeline({
            getChat: chatId => this.chats.get(chatId),
            connected: () => this.deps.connection.connected,
            selfId: () => this.deps.connection.selfId,
            call: (action, params, chatId) => this.guardedConnectionCall(action, params, chatId),
            isStopping: () => this.stopping,
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
            // 2026-11-02 P0：出站决策（发送/排队/补发失败）进事件时间线。
            events: deps.config.events,
            // W1: outbound decision events ride the chat's initiating traceId; a
            // write with no mapped trace (proactive tool sends) starts a fresh one.
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
        });
        this.inbound = new InboundPipeline({
            call: (action, params) => this.guardedConnectionCall(action, params),
            selfId: () => this.deps.connection.selfId,
            policy: deps.policy,
            getChat: chatId => this.chats.get(chatId),
            getSettings: chatId => this.registry.getSettings(chatId),
            sweepIdleChats: () => this.registry.sweepIdleChats(),
            media: deps.media,
            transcriber: deps.transcriber,
            steerTranscript: (chatId, text) => this.steerTranscript(chatId, text),
            tryHandleCommand: (chatId, text, userId, nickname) => this.tryHandleCommand(chatId, text, userId, nickname),
            buildBody: (text, media, chatId) => this.buildBody(text, media, chatId),
            expandQuote: messageId => this.expandQuote(messageId),
            dispatchFollowup: (chatId, text, role, nickname) => this.dispatchFollowup(chatId, text, role, nickname),
            interceptBusyTurn: (chatId, text, role, nickname, plain) => this.interceptBusyTurn(chatId, text, role, nickname, plain),
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.interim = new InterimTracker({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
            sendMsg: (chatId, segments, options) => this.sendMsg(chatId, segments, options),
            call: (action, params) => this.guardedConnectionCall(action, params),
            chainTail: chatId => this.outbound.chainTail(chatId),
            relayHostCards: (chatId, content) => this.relayHostCards(chatId, content),
            effectiveInterim: chatId => this.effectiveInterim(chatId),
            log: (level, message) => this.deps.log(level, message),
            config: deps.config,
        });
        this.deferred = new DeferredDelivery({
            sendToChat: (chatId, text, options) => this.sendToChat(chatId, text, options),
            isTurnRunning: chatId => this.chats.get(chatId)?.agent.status === 'running',
            takePendingText: chatId => {
                const chat = this.chats.get(chatId);
                if (chat === undefined || chat.loopPending === null)
                    return null;
                const text = chat.loopPending;
                chat.loopPending = null;
                return text;
            },
            traceIdFor: chatId => this.traceByChat.get(chatId),
            log: (level, message) => this.deps.log(level, message),
            trace: (chatId, event) => {
                const sink = deps.config.trace;
                if (sink === undefined || !sink.enabled)
                    return;
                const mapped = this.traceByChat.get(chatId);
                sink.emit({ traceId: mapped ?? newTraceId(sink.now()), chatId, ...event });
            },
            mediaDir: deps.config.mediaDir,
            timeoutMs: deps.config.deferredTimeoutMs ?? DEFAULT_DEFERRED_TIMEOUT_MS,
            isStopping: () => this.stopping,
        });
        // 静默看门狗：stateFile / 告警通道配置都落在 mediaDir（与 delayed 队列同
        // 目录），管理员取 policy.adminUsers[0]；没有媒体目录时样本与告警都跳过、
        // 功能照跑。
        this.watchdog = createSilenceWatchdog({
            connection: deps.connection,
            log: (level, message) => this.deps.log(level, message),
            stateFile: deps.config.mediaDir === undefined || deps.config.mediaDir === ''
                ? undefined
                : deps.config.mediaDir + '/watchdog.jsonl',
            mediaDir: deps.config.mediaDir,
            notifyAdmin: text => this.notifyAdminSilence(text),
            adminUid: deps.policy.adminUsers[0] ?? '',
            // 2026-11-02 P0：探测样本喂状态存储（设置页徽标的「NapCat 登录态」）。
            onSample: sample => {
                this.deps.config.status?.noteProbe(sample);
            },
        });
    }
    /** Start listening: wire connection handlers and the session event feed. */
    start() {
        const { connection, ctx: sessionEvents } = this.deps;
        connection.selfId = this.deps.config.botQQ;
        this.sessionEventOff = sessionEvents.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        this.sessionFlushOff = sessionEvents.on('session/flush', (session) => {
            void this.onSessionFlush(session);
        });
        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
            const status = this.deps.config.status;
            const events = this.deps.config.events;
            if (connected) {
                // P0：状态翻转立即落盘（设置页 10s 内变绿的来源）+ 时间线一笔。
                status?.noteConnected();
                void status?.persistNow();
                events?.record({ direction: 'conn', chatId: '', kind: 'connection', ok: true, reason: 'OneBot 已连接' });
                // 掉线看门狗：先记 recovered（确认窗口内恢复会直接取消待发告警），
                // 再把断线期间排队的出站消息补发出去。
                this.watchdog.noteConnected();
                this.outbound.drainPendingSends();
                // 2026-11-05 断线补拉：把断线期间 NapCat 没推的消息从历史里捞回来。
                void this.backfillAfterReconnect();
                return;
            }
            // 断开是硬证据：立刻落一行 incident 并起确认窗口，30s 后还断着才推告警。
            const reason = 'OneBot WebSocket 断开';
            status?.noteDisconnected(reason);
            void status?.persistNow();
            events?.record({ direction: 'conn', chatId: '', kind: 'connection', ok: false, reason });
            this.watchdog.noteDisconnected(reason);
            // 2026-11-05 断线补拉：只记第一次断开的时刻（连续失败重连不刷新锚点）。
            if (this.reconnectSince === undefined)
                this.reconnectSince = Date.now();
        };
        this.watchdog.start();
        // 启动链必须有终端 catch：任一步 reject 若冒到顶层，Node 22+ 会按
        // unhandledRejection 直接崩宿主；即使不崩，registry.createChat() 的
        // `await mappingLoaded` 也会让每条入站消息都撞同一个 rejected promise。
        // catch 后 mappingLoaded 保持 resolved，降级为空映射继续收新消息。
        let readyStage = 'ready';
        this.registry.mappingLoaded = this.ready().then(async () => {
            readyStage = 'loadRetired';
            await this.registry.loadRetired();
            readyStage = 'loadSwitchable';
            await this.registry.loadSwitchable();
            readyStage = 'loadMapping';
            await this.registry.loadMapping();
            // T3 (P2): restore deferred-delivery tracking（未完结条目在该会话的
            // 下一次 turn/end 兑现；损坏行降级跳过）。
            readyStage = 'loadPersisted';
            await this.deferred.loadPersisted();
            // 2026-11-02 P0：启动重放未确认入站（WAL）——必须在映射/补发跟踪
            // 恢复之后，重投的消息才能落到原会话上。
            readyStage = 'replayInboundWal';
            await this.replayInboundWal();
        }).then(() => {
            if (this.stopping)
                return;
            this.deps.log('info', 'bridge ready (' + this.registry.chats.size + ' resumed chat(s))');
        }).catch((error) => {
            this.deps.log('error', 'bridge ready failed at ' + readyStage + ': ' + describeError(error) + errorStack(error));
        });
    }
    /**
     * 2026-11-05 断线补拉：WS 断开期间 NapCat 不会补推消息，重连后按断开时刻
     * 把活跃会话漏掉的消息从历史里捞回来重投。只补本进程内见到的断线（插件
     * 重启不补）；dryRun 不补（试运行不该往会话里灌真实消息）。
     */
    async backfillAfterReconnect() {
        const since = this.reconnectSince;
        this.reconnectSince = undefined;
        if (since === undefined || this.backfillRunning || this.stopping)
            return;
        if (this.deps.config.dryRun === true) {
            this.deps.log('debug', 'backfill: dryRun 打开，跳过补拉');
            return;
        }
        this.backfillRunning = true;
        try {
            const result = await backfillMissedMessages({
                connection: this.deps.connection,
                chats: this.chats,
                selfId: String(this.deps.connection.selfId ?? ''),
                since,
                handleInbound: (event, opts) => this.handleInbound(event, opts),
                log: (level, message) => this.deps.log(level, message),
                isStopping: () => this.stopping,
            });
            this.deps.log(result.skipped ? 'debug' : 'info', 'backfill: ' + result.text);
        }
        catch (error) {
            this.deps.log('warn', 'backfill failed: ' + describeError(error));
        }
        finally {
            this.backfillRunning = false;
        }
    }
    /**
     * P0：启动重放未确认入站（WAL）。只重投「同步处理没收口」的消息——已回复
     * 过的一定已 ack，不会二次回复；重投事件带 replayed 标记（不进录制、不
     * 进 WAL，防注入式反馈环），每条重投前 markReplayed，崩溃-重放-崩溃
     * 也不会无限循环。inboundWalReplay=false 时只留一条日志，条数以状态
     * 面板的「未确认」为准。
     */
    async replayInboundWal() {
        const wal = this.deps.config.wal;
        if (wal === undefined || this.stopping)
            return;
        let unacked;
        try {
            unacked = await wal.loadUnacked();
        }
        catch {
            return;
        }
        if (unacked.length === 0)
            return;
        const replayEnabled = this.deps.config.inboundWalReplay !== false;
        if (!replayEnabled) {
            this.deps.log('warn', '入站 WAL：' + unacked.length + ' 条未确认入站消息（inboundWalReplay=false，不自动重投；数量见状态面板）');
            return;
        }
        this.deps.log('warn', '入站 WAL：重放 ' + unacked.length + ' 条未确认入站消息');
        for (const item of unacked) {
            if (this.stopping)
                break;
            wal.markReplayed(item.id);
            try {
                await this.handleInbound(item.frame, { replayed: true });
            }
            catch (error) {
                this.deps.log('error', 'WAL 重放失败: ' + describeError(error) + errorStack(error));
            }
        }
    }
    /** 入站合并：把 event 放进 chat 的窗口缓冲；返回 true 表示已缓冲（调用方直接 return）。
     * 命令消息（/xxx）不缓冲，先 flush 已有缓冲再放行。
     *  2026-11-02 P0：walSession 随事件暂存——缓冲≠处理完，这批事件的 WAL
     *  确认延后到 flushInboundMerge 真正处理完之后（崩溃可整批重放）。 */
    async mergeInboundEvent(event, walSession) {
        let inbound;
        try {
            inbound = normalizeOneBot11(event);
        }
        catch {
            return false;
        }
        if (inbound === null || inbound.chatId === undefined)
            return false;
        const { chatId } = inbound;
        const raw = typeof event.raw_message === 'string' ? event.raw_message.trim() : '';
        if (raw.startsWith('/') || raw.startsWith('／')) {
            await this.flushInboundMerge(chatId);
            return false;
        }
        const arm = () => {
            const timer = setTimeout(() => {
                this.flushInboundMerge(chatId).catch((error) => this.deps.log('error', 'inbound merge flush failed: ' + describeError(error)));
            }, INBOUND_MERGE_WINDOW_MS);
            if (typeof timer.unref === 'function')
                timer.unref();
            return timer;
        };
        const entry = this.inboundMergeMap.get(chatId);
        if (entry === undefined) {
            this.inboundMergeMap.set(chatId, { events: [event], timer: arm(), walSessions: walSession === undefined ? [] : [walSession] });
            return true;
        }
        clearTimeout(entry.timer);
        entry.events.push(event);
        if (walSession !== undefined)
            entry.walSessions.push(walSession);
        entry.timer = arm();
        return true;
    }
    /** 结束 chat 的合并窗口：合并缓冲里的消息，交给 pipeline 处理。
     *  2026-11-02 P0：整批处理完后才收口这批事件的 WAL（ack）——批次里任何
     *  一条崩溃都没确认，重启后按 WAL 重放（ constituent 事件逐条重投，
     *  不再合并，属可接受的降级）。插件停止时缓冲被清空、会话不收口，
     *  同样走重启重放。 */
    async flushInboundMerge(chatId) {
        const entry = this.inboundMergeMap.get(chatId);
        if (entry === undefined)
            return;
        this.inboundMergeMap.delete(chatId);
        clearTimeout(entry.timer);
        // #1: never merge different senders into one batch — mergeInboundEvents
        // inherits the first event's identity, which would let a member's message
        // ride an admin's role. Split into contiguous same-sender runs instead.
        const groups = [];
        for (const event of entry.events) {
            const key = String(event.user_id ?? '');
            const last = groups[groups.length - 1];
            if (last !== undefined && last.key === key)
                last.events.push(event);
            else
                groups.push({ key, events: [event] });
        }
        for (const group of groups) {
            const merged = this.mergeInboundEvents(group.events);
            const inbound = normalizeOneBot11(merged);
            if (inbound === null)
                continue;
            try {
                await this.processInbound(inbound);
            }
            catch (error) {
                this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));
            }
        }
        for (const walSession of entry.walSessions ?? [])
            walSession.end();
    }
    /** 合并同一窗口内的多条 OneBot 事件：拼接 message 段与 raw_message，
     * 沿用首条的身份字段、message_id 取最后一条。 */
    mergeInboundEvents(events) {
        const first = events[0];
        const last = events[events.length - 1];
        const message = [];
        const rawParts = [];
        for (const event of events) {
            if (Array.isArray(event.message))
                message.push(...event.message);
            if (typeof event.raw_message === 'string')
                rawParts.push(event.raw_message);
        }
        return { ...first, message, raw_message: rawParts.join('\n'), message_id: last.message_id };
    }
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    async stop() {
        this.stopping = true;
        // A2：分条发送的延迟等待必须能中断，否则 dispose 后还会往 QQ 补发残余气泡。
        this.outbound.stopBubbles();
        if (this.sessionEventOff !== undefined) {
            this.sessionEventOff();
            this.sessionEventOff = undefined;
        }
        if (this.sessionFlushOff !== undefined) {
            this.sessionFlushOff();
            this.sessionFlushOff = undefined;
        }
        await this.registry.stop();
        // T3 (P2): disarm the deferred silent-wait timers（pending 条目已落盘，
        // 重启后 loadPersisted 恢复跟踪续投）。
        this.deferred.stopAll();
        for (const entry of this.inboundMergeMap.values()) {
            clearTimeout(entry.timer);
        }
        this.inboundMergeMap.clear();
        this.watchdog.stop();
    }
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** Whether a caller backing an agent session may perform file edits. QQ chats
     * require the currently running turn's initiator to be an admin (role frozen
     * from the dispatch queue at turn/start); non-QQ sessions (Web and other
     * channels) are trusted by default (A1 scoping). Unknown states fail closed
     * as member. */
    canEditFiles(sessionId) {
        const chatId = this.bySession.get(sessionId);
        if (chatId === undefined)
            return true;
        return this.chats.get(chatId)?.activeTurnRole === 'admin';
    }
    /**
     * Outbound media fence roots for one agent session's current turn (M1-A3b):
     * the plugin media dir always, plus the chat's workspace directory when the
     * running turn's initiator is an admin. The role reuses the M1-A2 turn-level
     * semantics (canEditFiles: frozen at turn/start, fail-closed member); a
     * session with no known chat stays mediaDir-only even though canEditFiles
     * would trust it — the media gate itself fails closed. Roots are
     * realpath-normalized here; the MediaStore fence re-checks containment
     * (the double check is harmless).
     */
    async mediaSendRoots(sessionId) {
        const isTurnAdmin = sessionId !== undefined && this.canEditFiles(sessionId);
        const chatId = sessionId !== undefined ? this.bySession.get(sessionId) : undefined;
        const candidates = [this.deps.config.mediaDir];
        if (chatId !== undefined && isTurnAdmin)
            candidates.push(this.effectiveCwd(chatId));
        const roots = [];
        for (const root of candidates) {
            try {
                roots.push(await realpath(root));
            }
            catch {
                roots.push(root); // missing root: kept as-is; the fence skips it (cannot contain anything)
            }
        }
        return { roots, isTurnAdmin };
    }
    /** Whether the connection is usable for sends. */
    get connected() {
        return this.deps.connection.connected;
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.outbound.sendToChat(chatId, text, options);
    }
    /**
     * 静默看门狗的管理员通报：私聊首位管理员，走正常出站队列（断线时
     * queuable 会把它排到重连后补发）。
     * @param text - 通报正文。
     */
    async notifyAdminSilence(text) {
        const adminUid = this.deps.policy.adminUsers[0];
        if (adminUid === undefined)
            return;
        await this.sendToChat(buildChatId('private', String(adminUid)), text, { queuable: true });
    }
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.outbound.sendSegments(chatId, segments);
    }
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    async ready() {
        await this.deps.hostReady?.();
    }
    // ------------------------------------------------------------ inbound
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     * W1: the whole inbound chain runs inside one trace scope (ALS), so every
     * pipeline decision point can attribute its event to this message's
     * traceId; disabled = no scope, no id, 0.6.0 behavior. W1/T5: injected
     * events (opts.injected) run inside their inject round (ALS) so the
     * dry-run guard covers the whole synchronous chain, and real events are
     * recorded by the inbound recorder when recordInbound is on (injected
     * events are never recorded — no inject→record→replay feedback loop).
     */
    async handleInbound(event, opts = {}) {
        const injected = opts.injected === true;
        const replayed = opts.replayed === true;
        const backfill = opts.backfill === true;
        const run = () => this.handleInboundOnce(event, injected, replayed, backfill);
        return injected
            ? runInjectRound({ traceId: newTraceId(), intercepted: 0 }, run)
            : run();
    }
    async handleInboundOnce(event, injected, replayed = false, backfill = false) {
        // 喂看门狗：真实入站事件（含 merge 前）才算「QQ 还在送消息」。
        if (!injected)
            this.watchdog.noteInbound(event.post_type);
        // Recording: skipped for injected events (they would otherwise feed the
        // injector again through replay) and skipped when no recorder exists.
        // 2026-11-02 P0：WAL 重放的帧同样不录制（它来自 WAL，再录会和 inject
        // 回放通道混淆）。
        const recorder = injected || replayed || backfill ? undefined : this.deps.config.recorder;
        const session = recorder?.begin(event) ?? undefined;
        // 2026-11-02 P0：入站 WAL——处理前预写 enq，收口时 ack。注入不写
        // （防注入→WAL→重放反馈环）；重放帧本身就在 WAL 里，不重复写。
        // 只认真实聊天消息（post_type=message）：meta 心跳/notice/request 事件
        // 到 normalizeOneBot11 就被丢弃，给它们写 enq+ack 两条纯噪音，还会
        // 加速 ack 堆积触发 compaction。
        const walSession = injected || replayed || backfill || event.post_type !== 'message'
            ? undefined
            : this.deps.config.wal?.begin(event);
        const trace = this.beginInboundTrace(event);
        const scope = trace !== undefined
            ? (session !== undefined ? session.wrapScope(trace) : trace)
            : session?.captureScope();
        // 合并窗口内的事件延后收口 WAL（见 flushInboundMerge）：缓冲≠处理完，
        // 崩溃后要能重放整批。
        let mergeBuffered = false;
        try {
            await runWithTrace(scope, async () => {
                if (this.stopping) {
                    this.deps.log('debug', '插件停止中，入站消息丢弃');
                    scope?.emit('inbound', { ok: false, reason: TRACE_REASONS.inboundStopping });
                    return;
                }
                if (!injected && await this.mergeInboundEvent(event, walSession)) {
                    mergeBuffered = true;
                    scope?.emit('normalize', { ok: true, reason: 'inbound-merge-buffered' });
                    return;
                }
                const inbound = normalizeOneBot11(event);
                if (inbound === null) {
                    this.deps.log('debug', '非聊天消息事件，不处理（post_type=' + String(event.post_type) + '）');
                    scope?.emit('normalize', { ok: false, reason: TRACE_REASONS.inboundNotChat });
                    return;
                }
                // P0：收到的聊天消息进事件时间线（只记元数据，不记正文）。
                this.deps.config.events?.record({
                    direction: 'in',
                    chatId: inbound.chatId,
                    kind: kindsOfSegments(inbound.segments).join('+') || 'other',
                    ok: true,
                    reason: backfill ? '补拉：断线期间漏掉的消息' : replayed ? 'WAL 重放：未确认入站' : '收到消息',
                    messageId: inbound.messageId,
                });
                await this.processInbound(inbound);
            });
        }
        catch (error) {
            scope?.emit('dispatch', { ok: false, reason: '入站处理失败: ' + describeError(error) });
            this.deps.log('error', 'inbound handling failed: ' + describeError(error) + errorStack(error));
        }
        finally {
            session?.end();
            if (!mergeBuffered)
                walSession?.end();
        }
    }
    /** W1: mint the inbound traceId + scope and record the first (收到消息)
     * event; undefined when tracing is off (zero overhead, zero difference).
     * W1/T5: an injected event REUSES its inject round's traceId, so the whole
     * injected round (pipeline decisions + intercepted outbound calls) shares
     * one traceId in the trace stream. */
    beginInboundTrace(event) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const kind = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined;
        const chatId = kind !== undefined
            ? buildChatId(kind, String(kind === 'group' ? event.group_id ?? '' : event.user_id ?? ''))
            : '';
        const messageId = event.message_id === undefined || event.message_id === null ? undefined : String(event.message_id);
        const traceId = currentInjectRound()?.traceId ?? newTraceId(sink.now());
        const scope = sink.scope(traceId, chatId, messageId);
        sink.emit({ traceId: scope.traceId, stage: 'inbound', ok: true, chatId, messageId, data: { messageType: String(event.message_type ?? '') } });
        return scope;
    }
    async processInbound(inbound) {
        await this.inbound.processInbound(inbound);
    }
    /** Feed one user message into a chat's agent (create on demand). Records
     * the base text for /retry, queues the initiator's turn role, and applies
     * per-chat /goal + /plan prefixes. */
    async dispatchFollowup(chatId, text, role, nickname) {
        const final = this.prefixTurn(chatId, text);
        const fallback = this.chats.get(chatId)?.lastNickname ?? '';
        const chat = await this.ensureChat(chatId, nickname ?? fallback);
        if (nickname !== undefined && nickname !== '')
            chat.lastNickname = nickname;
        chat.lastFollowup = text;
        chat.lastActivityAt = Date.now();
        // M3-D2a: a dispatched user turn starts a fresh interim cycle (the
        // inbound residue reset already cleared the loop fields directly).
        this.interim.onNewUserTurn(chat);
        // Queue this turn's initiator role; the host's turn/start freezes it as
        // the running turn's role (M1-A2). Push and followup happen synchronously,
        // so the role cannot interleave with another dispatch.
        chat.pendingTurnRoles.push(role);
        this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120));
        // Plugin-originated user message: the session log attributes QQ inbound
        // messages to this plugin's own producer-owned source kind, keeping them
        // distinguishable from host/web UI inputs.
        chat.agent.followup(createUserMessage({
            content: [{ type: 'text', text: final }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        // W1 cross-stream join: the turn's session events arrive on a different
        // async chain, so record this dispatch's traceId per chat for
        // onSessionEvent to pick up (runs inside the inbound ALS scope — command
        // dispatches reach here through the same await chain).
        const trace = currentTrace();
        if (trace !== undefined) {
            this.traceByChat.set(chatId, trace.traceId);
            trace.emit('dispatch', { ok: true, reason: '消息已投递给模型' });
        }
        // W1/T5 inject bookkeeping: an injected dispatch registers its round for
        // this chat (the async reply stays attributable — INDEPENDENT of tracing,
        // so the dry-run guard also works with the trace sink off); a real
        // dispatch clears any leftover injected round so real users are never
        // collaterally intercepted by the dry-run guard.
        const injectedRound = currentInjectRound();
        if (injectedRound !== undefined)
            this.injectRoundByChat.set(chatId, injectedRound.traceId);
        else
            this.injectRoundByChat.delete(chatId);
        this.deps.config.inject?.noteDispatch(chatId);
        this.startTyping(chat);
    }
    /** Prepend per-chat context directives (/goal reminder) to a turn's user
     * text. Plan mode is host-owned now (/plan forwards to the host command),
     * so the agent's own plan-mode instruction section governs planning. */
    prefixTurn(chatId, text) {
        let out = text;
        const goal = this.registry.getSettings(chatId).goal;
        if (goal !== undefined && goal.trim() !== '') {
            out = '【当前目标】' + goal + '\n' + out;
        }
        return out.trim();
    }
    /** Per-chat outbound-mode override (/mode), falling back to the global config. */
    effectiveInterim(chatId) {
        return this.registry.getSettings(chatId).interimOverride ?? this.deps.config.interimMessages;
    }
    /** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
    relayHostCards(chatId, content) {
        relayCards(this.cardRelayCtx, chatId, content);
    }
    /** The CardRelayContext handed to the card relay (D1-PR2): the outbound
     * send path plus the bridge log — the only capabilities the relay touches. */
    get cardRelayCtx() {
        return {
            sendToChat: (chatId, text) => this.sendToChat(chatId, text),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /**
     * Slash-command router. Commands are admin-only (the Hermes member
     * slash-command block) and are matched on the first word; a leading
     * @mention glued to the command (QQ group at + text) is stripped first.
     * A path like /tmp/x is never a command (command words are
     * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
     * message reaches the model, matching the Hermes "fall through" behavior.
     * @param chatId - the chat the command arrived in.
     * @param text - parsed inbound text.
     * @param userId - sender QQ number.
     * @param nickname - sender display name (pre-sanitized; T9-A /steer boundary).
     * @returns true when the message was consumed by a command.
     */
    tryHandleCommand(chatId, text, userId, nickname) {
        return routeCommand(this.commandCtx, chatId, text, userId, nickname);
    }
    /**
     * The CommandContext handed to the command table (D1-PR1): exposes exactly
     * the bridge capabilities the routed commands use, resolved live per
     * invocation (the llm catalog especially must stay a live service lookup).
     */
    get commandCtx() {
        const bridge = this;
        return {
            sendToChat: (chatId, text) => bridge.sendToChat(chatId, text),
            log: (level, message) => bridge.deps.log(level, message),
            isAdmin: userId => classifyUserRole(userId, bridge.deps.policy.adminUsers) === 'admin',
            getChat: chatId => bridge.chats.get(chatId),
            hasChat: chatId => bridge.chats.has(chatId),
            resetChat: chatId => bridge.resetChat(chatId),
            dispatchFollowup: (chatId, text, role, nickname) => bridge.dispatchFollowup(chatId, text, role, nickname),
            // T3 (P2): /stop 也显式终止该聊天的超时补发跟踪（其他聊天不受影响）。
            stopDeferredTracking: chatId => bridge.deferred.cancelChat(chatId),
            // T2 (P1): /steer — the bridge-owned steer core keeps the createUserMessage
            // source write point in bridge.ts (producer-owned kind, session-v4 guard).
            steerRunningTurn: (chatId, text) => bridge.steerMessage(chatId, text),
            effectiveCwd: chatId => bridge.effectiveCwd(chatId),
            sessionIdFromMapping: chatId => bridge.sessionIdFromMapping(chatId),
            resolvePresetId: chatId => bridge.resolvePresetId(chatId),
            // T3: /workspace persists with the chat mapping (debounced). When the
            // chat is not live, noteWorkspaceOverride snapshots it into the registry
            // so the flush actually reaches the mapping file instead of being
            // dropped by the chats/evictedChats-only rewrite.
            setChatWorkspacePath: (chatId, path) => {
                bridge.registry.getSettings(chatId).workspacePath = path;
                bridge.registry.noteWorkspaceOverride(chatId);
                bridge.registry.saveMappingDebounced();
            },
            presetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride,
            setPresetOverride: (chatId, id) => { bridge.registry.getSettings(chatId).presetOverride = id; },
            hasPresetOverride: chatId => bridge.registry.getSettings(chatId).presetOverride !== undefined,
            interimOverride: chatId => bridge.registry.getSettings(chatId).interimOverride,
            // D4b: /mode and /goal persist with the chat mapping (debounced).
            setInterimOverride: (chatId, value) => { bridge.registry.getSettings(chatId).interimOverride = value; bridge.registry.saveMappingDebounced(); },
            goal: chatId => bridge.registry.getSettings(chatId).goal,
            setGoal: (chatId, value) => { bridge.registry.getSettings(chatId).goal = value; bridge.registry.saveMappingDebounced(); },
            deleteGoal: chatId => { bridge.registry.getSettings(chatId).goal = undefined; bridge.registry.saveMappingDebounced(); },
            lastImagePath: chatId => bridge.registry.getSettings(chatId).lastImagePath,
            // R2: pending serial-number selection snapshot (lazy TTL lives in commands).
            pendingSelection: chatId => bridge.registry.getSettings(chatId).pendingSelection,
            setPendingSelection: (chatId, value) => { bridge.registry.getSettings(chatId).pendingSelection = value; },
            // /session: the per-chat switchable history and the switch itself.
            switchableSessions: chatId => bridge.registry.switchableSessions(chatId),
            switchSession: (chatId, targetSessionId) => bridge.registry.switchSession(chatId, targetSessionId),
            // /session list previews: cold-read each retired session's first user
            // input through the persistence port (read handle, small prefix).
            sessionPersistence: bridge.deps.sessionPersistence,
            takePendingImageRef: chatId => {
                const settings = bridge.registry.getSettings(chatId);
                const ref = settings.pendingImageRef;
                if (ref !== undefined)
                    settings.pendingImageRef = undefined;
                return ref;
            },
            resolveMediaRef: (ref, chatId) => bridge.resolveMediaRef(ref, chatId),
            llmCatalog: bridge.deps.llmCatalog,
            workspaceRegistry: bridge.deps.workspaceRegistry,
            agentDefaultModel: bridge.deps.agentDefaultModel,
            agentPresets: bridge.deps.agentPresets,
            commands: bridge.deps.commands,
            connection: bridge.deps.connection,
            dshHome: bridge.deps.dshHome,
            // W1/T5: the healthcheck command renders/packs through the bridge.
            healthReport: () => bridge.buildHealthReport(),
            // T4 (P3): export takes an optional trigger reference (file-name stamp).
            exportDiagnostics: triggerRef => bridge.exportDiagnosticsPackage(triggerRef),
            // 2026-11-02 P0：/status 的队列/ WAL 深度（与设置页徽标同源）。
            outboxStats: () => bridge.outbound.outboxStats(),
            walStats: () => bridge.deps.config.wal?.getStats() ?? { enabled: false, unacked: 0 },
            // T4 (P3): command-plane failures (/retry) mint an MF- reference through
            // the bridge's single entry point (registry + trace + structured log).
            reportFailure: (chatId, stage, detail) => bridge.registerMessageFailure(chatId, stage, detail),
            config: { interimMessages: bridge.deps.config.interimMessages, maxImageBytes: bridge.deps.config.maxImageBytes, unknownCommand: bridge.deps.config.unknownCommand },
        };
    }
    /** Read the chat→session mapping file (for /id and /status when no live chat). */
    async sessionIdFromMapping(chatId) {
        return this.registry.sessionIdFromMapping(chatId);
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    buildBody(text, media, chatId) {
        return this.inbound.buildBody(text, media, chatId);
    }
    /** Resolve one media ref to a text annotation with a local path. */
    resolveMediaRef(ref, chatId) {
        return this.inbound.resolveMediaRef(ref, chatId);
    }
    /** M3-D4c: steer a completed voice transcript into the chat's agent — the
     * running turn consumes it at its nearest step boundary; an idle agent
     * opens a turn. No live chat (dispatch dropped/never happened) drops it. */
    steerTranscript(chatId, text) {
        if (this.steerMessage(chatId, transcriptLabel(text)))
            return;
        this.deps.log('debug', 'voice transcript dropped (no live chat): ' + chatId);
        currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.transcriptNoChat });
    }
    /** T2 (P1): the single agent.steer write point — one createUserMessage with
     * the producer-owned source kind (the session-v4 guard counts the source
     * write points; this and dispatchFollowup are the only two). Shared by the
     * voice transcript path (steerTranscript), the 'steer' policy and /steer.
     * Returns false when the chat has no live agent (nothing was steered); a
     * payload that is empty after stripping is dropped but still reports true
     * (the chat exists, there is just nothing to steer). */
    steerMessage(chatId, text) {
        const chat = this.chats.get(chatId);
        if (chat === undefined)
            return false;
        // B1（2026-11-05）：保留 <user_message> 边界，与 followup 路径同形状。
        // 前缀（受限标签/群时间戳）在边界外先剥，边界内的正文才做内部标记清洗。
        const payload = shapeSteerPayload(text);
        if (payload === '')
            return true;
        chat.agent.steer(createUserMessage({
            content: [{ type: 'text', text: payload }],
            source: { kind: 'plugin:dsh-onebot' },
        }));
        return true;
    }
    /**
     * T2 (P1): the busy-turn policy seam (inbound ctx.interceptBusyTurn).
     * Called for every non-command message AFTER all gates, only when deciding
     * what to do with it while the chat's task is running:
     * - no running turn → false (caller dispatches normally; the 0.8.1 path,
     *   byte-identical — also the path for newMessagePolicy缺省 idle traffic);
     * - 'steer' policy + plain text + non-restricted sender + autoSteerPolicy
     *   eligibility ('admin' 档缺省 = 仅管理员；'all' 档不限，T9-B 用户裁决
     *   2026-10-12) → the message is submitted into the running turn via the
     *   steerMessage kernel (consumed at the nearest step boundary, NO new turn)
     *   and a submit notice goes out;
     * - otherwise (queue policy default / media-quote-forward message /
     *   restricted group member / 不具备自动插话资格) → the 0.8.1 dispatch path
     *   (agent.followup queues it as the next turn: consumed after the current
     *   turn ends, in arrival order) plus the queue notice at most once per
     *   running turn.
     * The running check reads the agent's own lifecycle state — the same
     * authoritative signal /stop uses; chat.busy (turn/start..turn/end view)
     * can lag the host driver and is deliberately NOT consulted.
     */
    async interceptBusyTurn(chatId, text, role, nickname, plain) {
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.agent.status !== 'running')
            return false;
        // The restricted-member soft limit ([受限用户:仅问答]) is never widened by
        // the steer policy: restricted senders' messages queue like everyone
        // else's media. The condition mirrors the RESTRICTED_PREFIX application
        // in the inbound pipeline (group + non-admin + restrictedMemberPrefix).
        const restricted = splitChatId(chatId).kind === 'group'
            && role !== 'admin' && this.deps.config.restrictedMemberPrefix;
        // T9-B: auto-steer eligibility (user ruling 2026-10-12) — 'admin' (缺省)
        // = admins only; 'all' = anyone. Restricted members stay excluded under
        // both; /steer remains admin-only regardless of this knob; queue mode is
        // untouched.
        const autoSteerAllowed = (this.deps.config.autoSteerPolicy ?? 'admin') === 'all' || role === 'admin';
        if ((this.deps.config.newMessagePolicy ?? 'queue') === 'steer' && plain && !restricted && autoSteerAllowed) {
            this.steerMessage(chatId, text);
            currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnSteered });
            this.sendToChat(chatId, STEER_ACCEPTED_NOTICE, { queuable: true }).catch((error) => {
                this.deps.log('debug', '插话提交提示发送失败: ' + describeError(error));
                currentTrace()?.emit('notice', { ok: false, reason: '插话提交提示发送失败: ' + describeError(error) });
            });
            return true;
        }
        await this.dispatchFollowup(chatId, text, role, nickname);
        currentTrace()?.emit('dispatch', { ok: true, reason: TRACE_REASONS.busyTurnQueued });
        if (!this.queueNoticeChats.has(chatId)) {
            this.queueNoticeChats.add(chatId);
            this.sendToChat(chatId, QUEUE_NOTICE_TEXT, { queuable: true }).catch((error) => {
                this.deps.log('debug', '排队提示发送失败: ' + describeError(error));
                currentTrace()?.emit('notice', { ok: false, reason: '排队提示发送失败: ' + describeError(error) });
            });
        }
        return true;
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    expandQuote(messageId) {
        return this.inbound.expandQuote(messageId);
    }
    // ------------------------------------------------------------ outbound
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        return this.outbound.sendMsg(chatId, segments, options);
    }
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    async sendForward(chatId, nodes) {
        return this.outbound.sendForward(chatId, nodes);
    }
    // ------------------------------------------------------------ inject dry-run guard
    /**
     * W1/T5: the single connection-call gate every bridge pipeline
     * (inbound/outbound/interim/typing) routes through. In inject dry-run
     * mode, WRITE actions of an injected round are intercepted at this
     * outbound action layer: counted, traced with the original text, resolved
     * with the marker message id — the real OneBot connection never sees them.
     * Attribution: (a) the synchronous chain via the inject round's ALS, (b)
     * the async agent reply via the chat→round association (injectRoundByChat,
     * independent of the trace sink), (c) recalls of already-intercepted sends
     * via the marker message id (a real OneBot id is never negative).
     */
    guardedConnectionCall(action, params, chatId) {
        const inject = this.deps.config.inject;
        if (inject === undefined || !inject.intercepting || !isWriteAction(action)) {
            return this.deps.connection.call(action, params);
        }
        const alsRound = currentInjectRound();
        if (alsRound !== undefined)
            return inject.intercept(alsRound, action, params);
        if (chatId !== undefined) {
            const round = inject.activeRoundFor(chatId);
            if (round !== undefined && this.injectRoundByChat.get(chatId) === round.traceId) {
                return inject.intercept(round, action, params);
            }
        }
        if (params.message_id === INTERCEPTED_MESSAGE_ID) {
            // Recall of an intercepted send (interim path has no chatId): count it
            // on the marker rule even without a resolvable round.
            return inject.intercept(undefined, action, params);
        }
        return this.deps.connection.call(action, params);
    }
    // ------------------------------------------------------------ health (W1/T5)
    /** The health deps the /healthcheck command renders from (resolved live). */
    healthDeps() {
        const conn = this.deps.connection;
        const transport = conn.config ?? {};
        const recorder = this.deps.config.recorder;
        const inject = this.deps.config.inject;
        return {
            mediaDir: this.deps.config.mediaDir,
            connection: { connected: this.deps.connection.connected, selfId: this.deps.connection.selfId },
            transport: { mode: String(transport.mode ?? '未知'), host: String(transport.host ?? ''), port: Number(transport.port ?? 0) },
            retryState: {
                reverseRetryAttempts: conn.reverseRetryAttempts,
                reconnectAttempts: conn.reconnectAttempts,
                selfHealing: conn.selfHealing,
            },
            dedup: {
                entries: this.inbound.dedupWindowEntries,
                // The W2-② window key rides as an optional intersection member.
                windowSeconds: this.deps.config.dedupWindowSeconds ?? 300,
            },
            writeGate: this.outbound.writeGateStats(),
            // 2026-11-02 P0：持久 Outbox / 入站 WAL 深度（体检一行 + 诊断包）。
            outbox: this.outbound.outboxStats(),
            wal: this.deps.config.wal?.getStats() ?? { enabled: false, unacked: 0 },
            ...(recorder !== undefined
                ? { recorder: { enabled: true, redact: recorder.redact, written: recorder.getStats().written } }
                : {}),
            ...(inject !== undefined
                ? {
                    inject: {
                        enabled: true, dryRun: inject.intercepting,
                        consumed: inject.getStats().consumed, intercepted: inject.getStats().intercepted,
                        skippedHistory: inject.getStats().skippedHistory,
                    },
                }
                : {}),
            configSnapshot: this.deps.configSnapshot?.() ?? {},
            // T4 (P3): the recent fault references for the report section.
            failureRefs: () => this.failureRefs.recent(),
            log: (level, message) => this.deps.log(level, message),
        };
    }
    /** /healthcheck: render the health summary. */
    async buildHealthReport() {
        return healthReport(this.healthDeps());
    }
    /** /healthcheck export: pack the redacted diagnostics archive. T4 (P3): the
     * file name carries the trigger reference — the explicit command argument,
     * or the most recent recorded fault reference when omitted. */
    async exportDiagnosticsPackage(triggerRef) {
        const deps = this.healthDeps();
        return exportDiagnostics({ ...deps, triggerRef: triggerRef ?? this.failureRefs.recent(1)[0]?.ref });
    }
    // ------------------------------------------------------------ session events
    onSessionEvent(session, event) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined) {
            // pipeline-hooks.md #20: non-QQ sessions (web/host) ride this same bus;
            // keep the early exit visible at debug without emitting any trace.
            this.deps.log('debug', 'session 事件早退：无 chat 映射（session=' + session.id + ' type=' + String(event.type) + '）');
            return;
        }
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.sessionId !== session.id)
            return;
        const trace = this.traceForChat(chatId);
        if (event.type === 'turn/start') {
            trace?.emit('agent', { ok: true, reason: '模型回合开始' });
            // B8: a new turn begins — prune the previous turn's recalled-id
            // residue (see InterimTracker.onTurnStart for the safety analysis).
            this.interim.onTurnStart(chat);
            // Freeze the running turn's initiator role from the dispatch FIFO
            // (M1-A2): turns the plugin did not dispatch (host/web input) find an
            // empty queue and fail closed as member.
            chat.activeTurnRole = chat.pendingTurnRoles.shift() ?? 'member';
            chat.lastActivityAt = Date.now();
            chat.busy = true;
            // T3 (P2): arm the deferred silent-wait window for this turn（每次模型
            // 输出重置；turn/end 解除；deferredTimeoutMs<=0 时为 no-op）。
            this.deferred.onTurnStart(chatId, session.id);
            return;
        }
        if (event.type === 'assistant/message') {
            // T3 (P2): a deferred-registered (timed-out) turn is muted — its text
            // messages are captured for the final补发 only（不插播 interim、不转
            // 审批/提问卡：超时后只补最终文字与终态通知）。
            if (this.deferred.onAssistantMessage(chatId, session.id, event.data.message))
                return;
            this.interim.onAssistantMessage(chatId, chat, event.data.message);
            return;
        }
        if (event.type === 'turn/end') {
            const reason = event.data.reason;
            // T4 (P3): a message-turn fault mints ONE MF- reference before any
            // consumer runs — the trace event (data.ref), the structured log line,
            // the ⚠️ notice tail and the deferred terminal text all carry the same
            // number. Normal (completed/cancelled) turns mint nothing.
            const errorRef = reason.kind === 'error'
                ? this.mintFailureRef('msg', 'agent', '模型回合出错: ' + reason.error.message, { chatId })
                : undefined;
            // T3 (P2): complete a deferred entry（补发异步进行）；true = the turn was
            // under deferred tracking — the terminal-state notice rides the补发
            // path, so the normal error notice below is suppressed（同一故障不双发）.
            const deferredTracked = this.deferred.onTurnEnd(chatId, session.id, reason, errorRef);
            this.interim.onTurnEnd(chatId, chat);
            if (reason.kind === 'error') {
                // T4: the ok:false agent event is emitted by mintFailureRef (with
                // data.ref) — no second event for the same decision point.
            }
            else {
                trace?.emit('agent', { ok: true, reason: '模型回合结束（' + reason.kind + '）' });
            }
            if (reason.kind === 'error') {
                const message = reason.error.message;
                // 基线语义保持：碰撞自愈原本挂在 sendErrorNotice 分支内；deferred
                // 回合的终态走补发通道，也必须自愈，故闸为 sendErrorNotice || deferredTracked。
                if ((this.deps.config.sendErrorNotice || deferredTracked)
                    && /persisted log on disk that does not match this live session|id collision/i.test(message)) {
                    void this.healSessionCollision(chatId);
                }
                if (!deferredTracked && this.deps.config.sendErrorNotice) {
                    this.sendToChat(chatId, '⚠️ 运行出错：' + message + failureRefSuffix(errorRef), { queuable: true }).catch((error) => {
                        // pipeline-hooks.md #21: the send failure used to be swallowed.
                        this.deps.log('debug', '错误通知发送失败: ' + describeError(error));
                        trace?.emit('notice', { ok: false, reason: TRACE_REASONS.noticeErrorSendFailed });
                    });
                }
            }
            this.stopTyping(chat);
            chat.lastActivityAt = Date.now();
            chat.busy = false;
            // T2 (P1): the turn that armed the queue notice is over — a later
            // running turn notifies again.
            this.queueNoticeChats.delete(chatId);
            this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind);
            // Durable: flush the session so a later restart can resume it.
            void this.deps.sessions.flush(chat.agent.session).catch((error) => {
                this.deps.log('warn', 'session flush failed: ' + String(error));
                trace?.emit('notice', { ok: false, reason: '会话落盘失败: ' + String(error) });
            });
            void this.saveMappingDebounced();
        }
    }
    /** W1: the trace scope for one chat's session events, resolved through the
     * chat-level association table; undefined when tracing is off or the chat
     * has no recorded dispatch (host-initiated turns stay untraced). */
    traceForChat(chatId) {
        const sink = this.deps.config.trace;
        if (sink === undefined || !sink.enabled)
            return undefined;
        const traceId = this.traceByChat.get(chatId);
        return traceId !== undefined ? sink.scope(traceId, chatId) : undefined;
    }
    // ------------------------------------------------------ failure references (W3/T4)
    /**
     * T4 (P3): the single fault-reference entry point. Mints one QQ-CONN-/MF-
     * number, records it in the bounded registry, emits the ok:false trace
     * event carrying `data.ref` (traceId = the chat's mapped id, or a fresh id
     * for chat-less connection faults), and writes the structured error log
     * line — every surface of the fault shares this one number. Called only on
     * fault events: normal traffic mints nothing (zero overhead).
     */
    mintFailureRef(kind, stage, detail, opts = {}) {
        const ref = this.failureRefs.mint(kind);
        const traceId = opts.chatId !== undefined ? this.traceByChat.get(opts.chatId) : undefined;
        this.failureRefs.record({ ref, kind, ts: Date.now(), stage, detail, traceId });
        const sink = this.deps.config.trace;
        if (sink !== undefined && sink.enabled) {
            sink.emit({
                traceId: traceId ?? newTraceId(sink.now()),
                chatId: opts.chatId,
                stage,
                ok: false,
                reason: detail,
                data: { ref, refKind: kind },
            });
        }
        this.deps.log('error', '故障参考号 ' + ref + ' [' + stage + ']: ' + detail);
        return ref;
    }
    /** T4: connection-fault reference entry (wired from index.ts via
     * `connection.onFailure`); the returned reference is appended to the
     * transport's own log line. */
    registerConnectionFailure(stage, detail) {
        return this.mintFailureRef('conn', 'connection', detail);
    }
    /** T4: message-fault reference entry for command-plane failures (e.g. the
     * /retry dispatch throw); the caller appends the returned reference to the
     * user-visible ⚠️ notice. */
    registerMessageFailure(chatId, stage, detail) {
        return this.mintFailureRef('msg', stage, detail, { chatId });
    }
    async onSessionFlush(session) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        // M1-E2: arbitrary session flushes debounce like turn/end — stop() still
        // forces the final saveMapping directly.
        this.saveMappingDebounced();
    }
    // ------------------------------------------------------------ registry facades
    /** Same-name delegations to the chat registry (D1-PR3): the command table's
     * ctx, the interim/turn event links and the outbound pipeline keep calling
     * the bridge exactly as before the split. */
    /** Get (or create) the agent for a chat. */
    ensureChat(chatId, nickname) {
        return this.registry.ensureChat(chatId, nickname);
    }
    effectiveCwd(chatId) {
        return this.registry.effectiveCwd(chatId);
    }
    resolvePresetId(chatId) {
        return this.registry.resolvePresetId(chatId);
    }
    saveMappingDebounced() {
        this.registry.saveMappingDebounced();
    }
    healSessionCollision(chatId) {
        return this.registry.healSessionCollision(chatId);
    }
    /**
     * /new: the registry disposes the agent and retires its session id so the
     * next inbound message creates a brand-new session (fresh history; the old
     * conversation stays on disk). The confirmation is sent directly through
     * the outbound pipeline since no agent is left to reply.
     */
    async resetChat(chatId) {
        const result = await this.registry.resetChat(chatId);
        // fix-4 made registry.resetChat refuse while the chat is busy; surface the
        // refusal instead of confirming a reset that did not happen.
        if (result !== undefined && result.ok === false) {
            this.sendToChat(chatId, result.message ?? '当前正在生成回复，请先 /stop 再开启新会话。', { queuable: true }).catch((error) => {
                this.deps.log('warn', 'reset refusal notice send failed: ' + String(error));
            });
            return result;
        }
        // B2: the old session's deferred trackers have nothing left to settle.
        this.deferred.cancelChat(chatId);
        this.sendToChat(chatId, '✅ 已开启新会话，下一条消息将进入全新会话，旧对话历史保留在之前的会话中。', { queuable: true }).catch((error) => {
            this.deps.log('warn', 'reset notice send failed: ' + String(error));
        });
        return result;
    }
    /**
     * Compose the QQ channel's scoped world for one agent: the QQ platform
     * prompt section and the qq_* tools. Registered on `agentCtx` (the agent's
     * own scope) instead of the plugin context, so Web/local sessions never see
     * the channel instructions or the media tools — they cannot (and should
     * not) push messages to QQ.
     */
    installChannelScope(agentCtx, chatId) {
        agentCtx.systemPrompt.section({
            name: 'channel:dsh-onebot',
            order: 90,
            text: buildPlatformPrompt(this.deps.config.restrictedMemberPrefix),
        });
        this.installGroupToolGate(agentCtx, chatId);
        registerTools(agentCtx, this, this.deps.connection, {
            maxImageBytes: this.deps.config.maxImageBytes,
            maxVoiceBytes: this.deps.config.maxVoiceBytes,
            maxFileBytes: this.deps.config.maxFileBytes,
        });
    }
    /**
     * 群聊工具硬闸档位（蓝汐 2026-10-28 补丁）：'inherit'（默认）完全不动，
     * 保持 0.9.4 行为；'guard' 逐回合按 activeTurnRole 拦截。
     */
    groupToolPolicy() {
        const p = this.deps.config.groupToolPolicy;
        return p === 'guard' ? 'guard' : 'inherit';
    }
    /**
     * 群聊工具闸（guard 档）：管理员回合放行全部工具；其他回合只能使用
     * groupMemberTools 白名单里的工具（2026-10-28 蓝汐补丁；起因：群里那个我在
     * 管理员回合 read 了 reports 下的报告并念进群）。私聊与其他通道不挂此闸。
     */
    installGroupToolGate(agentCtx, chatId) {
        if (this.groupToolPolicy() !== 'guard' || chatId === undefined)
            return;
        if (splitChatId(chatId).kind !== 'group')
            return;
        agentCtx.tools.guard(exec => this.guardGroupTool(chatId, exec));
    }
    /** 返回非空字符串 = 拒绝（宿主把理由包成 Error: <理由> 交给模型）。 */
    guardGroupTool(chatId, exec) {
        // 2026-10-31：群里「谁在说话」决定能不能干活。管理员本人的回合也只放行
        // GROUP_GUARD_ADMIN_TOOLS 这张小单子，其他群友维持 groupMemberTools 白名单。
        // activeTurnRole 在 turn/start 从派发队列冻结（bridge.js 1406 行），不是从消息
        // 正文推断，所以群友冒充管理员也拿不到 admin；字段缺失或为空的回合仍然走下面的
        // 白名单（fail-closed）。
        if (this.chats.get(chatId)?.activeTurnRole === 'admin' && GROUP_GUARD_ADMIN_TOOLS.has(exec.name))
            return undefined;
        const allow = Array.isArray(this.deps.config.groupMemberTools)
            ? this.deps.config.groupMemberTools
            : ['qq_send_image', 'qq_send_voice', 'qq_send_forward'];
        if (!allow.includes(exec.name))
            return '这个我不能在群里做';
        // 只许发给本群：阻止 member 用 chat_id 把图/语音/合并转发私聊给管理员或发去别的群
        if (this.deps.config.groupMemberPinChat !== false && exec.name.startsWith('qq_')) {
            const target = exec.arguments?.chat_id;
            if (typeof target === 'string' && target !== '' && target !== chatId)
                return '这个我不能在群里做';
        }
        return undefined;
    }
    // ------------------------------------------------------------ typing
    /** Start the NapCat typing indicator (private chats only). */
    startTyping(chat) {
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        this.stopTyping(chat);
        const pulse = () => {
            if (this.stopping)
                return;
            void this.guardedConnectionCall('set_input_status', {
                user_id: Number(ref.target),
                event_type: 1,
            }, chat.chatId).catch(() => undefined);
        };
        pulse();
        chat.typingTimer = setInterval(pulse, 5_000).unref();
    }
    /** Stop the typing indicator. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        void this.guardedConnectionCall('set_input_status', {
            user_id: Number(ref.target),
            event_type: 0,
        }, chat.chatId).catch(() => undefined);
    }
}
export { OneBotNotConnectedError, OneBotActionError } from './connection.js';
