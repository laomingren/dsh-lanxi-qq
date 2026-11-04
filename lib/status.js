/**
 * 连接状态与统计快照（2026-11-02 P0 改造，对齐竞品 dsh-connect 徽标 /
 * dsh-qq-access 状态机 / dsh-im-channel :8899 状态页的数据面）：
 * StatusStore 由插件主入口持有，onStatus 翻转与看门狗探测样本喂进来，
 * 周期性把快照原子写到 mediaDir/qq-status.json；设置页 Remote 的
 * getStatus() 只读这个文件 + 当日统计（statsDir）+ 事件文件，不碰任何
 * 活对象——宿主没跑插件时也能看到「最后一次已知状态」。
 *
 * 快照字段（设置页徽标同源，/status 命令同源）：
 *   connected / mode / selfId / lastConnectedAt / lastDisconnectedAt /
 *   lastDisconnectReason / disconnectCount / connectedSinceSec /
 *   probe{at,statusOk,online,loginOk} / outbox{...} / wal{...} /
 *   today{in,out,errors,day} / updatedAt / stale
 *
 * 隐私：快照只有状态数字，没有任何消息正文。
 * @module dsh-onebot/status
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeError } from './errors.js';
import { EVENTS_FILE } from './events.js';
import { localDay } from './stats.js';
/** 状态快照文件（append under mediaDir；原子替换）。 */
export const STATUS_FILE = 'qq-status.json';
export const STATUS_TMP_FILE = STATUS_FILE + '.tmp';
/** 快照刷新间隔（毫秒）：连接翻转立即写，平时按这个节奏续期计数。 */
export const DEFAULT_REFRESH_MS = 5_000;
/** 文件龄超过此值视为「可能已停止」（UI 显示灰色存疑徽标）。 */
export const STALE_AFTER_MS = 60_000;
const ENV = (name) => process.env[name] ?? '';
/** dsh 数据根（$DSH_HOME 或 ~/.dsh）——与 index.js 的 dshHome() 同口径。 */
export function dshHome() {
    return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
}
/** 生效 mediaDir：配置 mediaDir 非空用之，否则 <dsh-home>/media/onebot
 *  （与 index.js defaultMediaDir() 同口径；本模块不 import index.js——
 *  settings-remote 是独立 insert 行，不能把整个插件模块拖进来）。 */
export function resolveMediaDir(config) {
    const configured = config?.mediaDir;
    if (typeof configured === 'string' && configured !== '')
        return configured;
    return join(dshHome(), 'media', 'onebot');
}
/** 生效 statsDir：配置 statsDir 非空用之，否则 <dsh-home>/data/onebot-stats
 *  （与 stats.js DEFAULT_STATS_DIR 同口径）。 */
export function resolveStatsDir(config) {
    const configured = config?.statsDir;
    if (typeof configured === 'string' && configured !== '')
        return configured;
    return join(dshHome(), 'data', 'onebot-stats');
}
/** 本地日起止（epoch ms，系统时区）——今日统计窗口。 */
export function localDayBounds(now = Date.now()) {
    const date = new Date(now);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
    return { start: start.getTime(), end: end.getTime(), day: localDay(date) };
}
/**
 * 活状态存储：连接翻转、探测样本、周期落盘。providers 由 bridge 装配后
 * 填入（outbox/wal 的统计闭包），避免本模块反向依赖桥。
 */
export class StatusStore {
    dir;
    log;
    now;
    refreshMs;
    providers = {};
    connected = false;
    lastConnectedAt = 0;
    lastDisconnectedAt = 0;
    lastDisconnectReason = '';
    disconnectCount = 0;
    /** 看门狗最近一次探测样本（ NapCat 登录态）。 */
    probe = { at: 0, statusOk: false, online: false, loginOk: false };
    /** 今日错误计数（按本地日重置；面板「错误数」）。 */
    errorsToday = 0;
    errorsDay = '';
    /** 连接模式（reverse/forward；index.js 装配时写入，徽标显示用）。 */
    mode = '';
    writeChain = Promise.resolve();
    refreshTimer;
    constructor(options = {}) {
        this.dir = options.dir;
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    }
    noteConnected() {
        if (this.connected)
            return;
        this.connected = true;
        this.lastConnectedAt = this.now();
    }
    noteDisconnected(reason) {
        if (!this.connected && this.lastDisconnectedAt !== 0)
            return;
        this.connected = false;
        this.lastDisconnectedAt = this.now();
        this.lastDisconnectReason = typeof reason === 'string' && reason !== '' ? reason : '连接断开（未上报原因）';
        this.disconnectCount += 1;
    }
    noteProbe(sample) {
        if (sample === null || typeof sample !== 'object')
            return;
        this.probe = {
            at: this.now(),
            statusOk: sample.statusOk === true,
            online: sample.online === true,
            loginOk: sample.loginOk === true,
        };
    }
    /** 记一个错误事件（ok:false）：今日错误数 +1。 */
    noteError() {
        const day = localDay(new Date(this.now()));
        if (this.errorsDay !== day) {
            this.errorsDay = day;
            this.errorsToday = 0;
        }
        this.errorsToday += 1;
    }
    /** 当前快照（活对象拼装；缺的 provider 字段给安全默认）。 */
    snapshot() {
        const now = this.now();
        const outbox = this.providers.outbox?.();
        const wal = this.providers.wal?.();
        const bounds = localDayBounds(now);
        if (this.errorsDay !== bounds.day) {
            this.errorsDay = bounds.day;
            this.errorsToday = 0;
        }
        return {
            connected: this.connected,
            mode: this.mode,
            selfId: this.providers.selfId?.() ?? '',
            lastConnectedAt: this.lastConnectedAt,
            lastDisconnectedAt: this.lastDisconnectedAt,
            lastDisconnectReason: this.lastDisconnectReason,
            disconnectCount: this.disconnectCount,
            connectedSinceSec: this.connected && this.lastConnectedAt > 0
                ? Math.max(0, Math.round((now - this.lastConnectedAt) / 1000))
                : 0,
            probe: { ...this.probe },
            outbox: outbox ?? { enabled: false, pending: 0, failed: 0 },
            wal: wal ?? { enabled: false, unacked: 0 },
            errorsToday: this.errorsToday,
            today: bounds.day,
            updatedAt: now,
        };
    }
    /** 原子写快照（tmp + rename；串行链）。 */
    persist() {
        const payload = JSON.stringify(this.snapshot(), null, 2) + '\n';
        this.writeChain = this.writeChain.then(async () => {
            try {
                await mkdir(this.dir, { recursive: true });
                await writeFile(join(this.dir, STATUS_TMP_FILE), payload, 'utf8');
                await rename(join(this.dir, STATUS_TMP_FILE), join(this.dir, STATUS_FILE));
            }
            catch (error) {
                this.log('warn', '状态快照写盘失败（设置页将显示上次已知状态）: ' + describeError(error));
            }
        }).catch(() => undefined);
        return this.writeChain;
    }
    /** 连接翻转时由桥立即调用（10s 内变红的原因就在这里）。 */
    persistNow() {
        return this.persist();
    }
    /** 周期刷新：先落快照再跑 onTick（桥/WAL 的旁路计数刷新挂这里，一个定时器）。 */
    startRefresh(onTick) {
        if (this.refreshTimer !== undefined || this.refreshMs <= 0)
            return;
        this.refreshTimer = setInterval(() => {
            void this.persist();
            if (typeof onTick === 'function') {
                try {
                    onTick();
                }
                catch {
                    // 旁路钩子异常绝不影响刷新定时器
                }
            }
        }, this.refreshMs);
        if (typeof this.refreshTimer.unref === 'function')
            this.refreshTimer.unref();
    }
    stopRefresh() {
        if (this.refreshTimer !== undefined) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }
    flush() {
        return this.writeChain;
    }
}
// ── 只读侧（settings-remote 的 getStatus/getEvents 用；纯文件读） ──────────
/** 读状态快照文件；缺失/损坏返回降级快照（available:false）。 */
export async function readStatusSnapshot(dir, now = Date.now()) {
    const fallback = {
        available: false,
        connected: false,
        mode: '',
        selfId: '',
        lastConnectedAt: 0,
        lastDisconnectedAt: 0,
        lastDisconnectReason: '',
        disconnectCount: 0,
        connectedSinceSec: 0,
        probe: { at: 0, statusOk: false, online: false, loginOk: false },
        outbox: { enabled: false, pending: 0, failed: 0 },
        wal: { enabled: false, unacked: 0 },
        errorsToday: 0,
        today: localDay(new Date(now)),
        updatedAt: 0,
        stale: true,
    };
    let text;
    try {
        text = await readFile(join(dir, STATUS_FILE), 'utf8');
    }
    catch {
        return fallback;
    }
    let parsed;
    try {
        parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    }
    catch {
        return fallback;
    }
    if (parsed === null || typeof parsed !== 'object')
        return fallback;
    const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0;
    return {
        available: true,
        connected: parsed.connected === true,
        mode: typeof parsed.mode === 'string' ? parsed.mode : '',
        selfId: typeof parsed.selfId === 'string' ? parsed.selfId : '',
        lastConnectedAt: numberOr(parsed.lastConnectedAt, 0),
        lastDisconnectedAt: numberOr(parsed.lastDisconnectedAt, 0),
        lastDisconnectReason: typeof parsed.lastDisconnectReason === 'string' ? parsed.lastDisconnectReason : '',
        disconnectCount: numberOr(parsed.disconnectCount, 0),
        connectedSinceSec: numberOr(parsed.connectedSinceSec, 0),
        probe: normalizeProbe(parsed.probe),
        outbox: normalizeOutbox(parsed.outbox),
        wal: normalizeWal(parsed.wal),
        errorsToday: numberOr(parsed.errorsToday, 0),
        today: typeof parsed.today === 'string' ? parsed.today : '',
        updatedAt,
        stale: updatedAt === 0 || now - updatedAt > STALE_AFTER_MS,
    };
}
function numberOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function normalizeProbe(probe) {
    if (probe === null || typeof probe !== 'object')
        return { at: 0, statusOk: false, online: false, loginOk: false };
    return {
        at: numberOr(probe.at, 0),
        statusOk: probe.statusOk === true,
        online: probe.online === true,
        loginOk: probe.loginOk === true,
    };
}
function normalizeOutbox(outbox) {
    if (outbox === null || typeof outbox !== 'object')
        return { enabled: false, pending: 0, failed: 0 };
    return {
        enabled: outbox.enabled === true,
        pending: numberOr(outbox.pending, 0),
        inFlight: numberOr(outbox.inFlight, 0),
        failed: numberOr(outbox.failed, 0),
        sent: numberOr(outbox.sent, 0),
        dropped: numberOr(outbox.dropped, 0),
        deduped: numberOr(outbox.deduped, 0),
    };
}
function normalizeWal(wal) {
    if (wal === null || typeof wal !== 'object')
        return { enabled: false, unacked: 0 };
    return {
        enabled: wal.enabled === true,
        unacked: numberOr(wal.unacked, 0),
        enqWritten: numberOr(wal.enqWritten, 0),
        replayed: numberOr(wal.replayed, 0),
    };
}
/** 读事件文件尾部（最新在前）；chatId 非空过滤。坏行跳过。 */
export async function readRecentEvents(dir, limit = 50, chatId = '') {
    const want = Math.min(Math.max(1, limit), 500);
    let text;
    try {
        text = await readFile(join(dir, EVENTS_FILE), 'utf8');
    }
    catch {
        return [];
    }
    const events = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            const event = JSON.parse(trimmed);
            if (event === null || typeof event !== 'object' || typeof event.ts !== 'number')
                continue;
            if (chatId !== '' && String(event.chatId ?? '') !== chatId)
                continue;
            events.push(event);
        }
        catch {
            // 坏行只丢一行
        }
    }
    return events.slice(-want).reverse();
}
/** 读当日收发计数（statsDir/<本地日>.jsonl 聚合；只记类型不记内容）。 */
export async function readDailyStats(statsDir, now = Date.now()) {
    const bounds = localDayBounds(now);
    const result = { day: bounds.day, in: 0, out: 0, byKind: {} };
    let text;
    try {
        text = await readFile(join(statsDir, bounds.day + '.jsonl'), 'utf8');
    }
    catch {
        return result; // 今天还没收发过：空态不崩
    }
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            const row = JSON.parse(trimmed);
            if (row === null || typeof row !== 'object')
                continue;
            const direction = row.d === 'in' ? 'in' : row.d === 'out' ? 'out' : '';
            if (direction === '')
                continue;
            result[direction] += 1;
            const kind = typeof row.k === 'string' ? row.k : 'other';
            result.byKind[direction + ':' + kind] = (result.byKind[direction + ':' + kind] ?? 0) + 1;
        }
        catch {
            // 坏行只丢一行
        }
    }
    return result;
}
