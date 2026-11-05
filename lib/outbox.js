/**
 * 持久 Outbox（2026-11-02 P0 改造，对齐竞品 dsh-lark-link 的可靠投递）：
 * 断线期间排队的外发回复从「内存 per-chat FIFO（cap 20 / TTL 5 分钟 / 超了
 * 丢最旧）」升级为落盘 JSONL（mediaDir/qq-outbox.jsonl）——
 *   - at-least-once：enq 行先落盘再进内存队列；补发失败/进程被杀，重启后
 *     load() 重建队列继续投，不丢消息；
 *   - 幂等键：每条队列项带全局唯一 id；相同 (chatId, text) 的重复入队被去重
 *     （防同一回复被 park 两次）；已确认（ack）的 id 在进程内记住，重复的
 *     enq 行不会被二次投递；
 *   - 按序重发：due() 按 queuedAt 全局 FIFO 吐出，per-chat 顺序另由出站管线
 *     的 per-chat send chain 保证；
 *   - 失败离队：单条补发连续失败 outboxMaxAttempts 次后移入 failed 列表
 *     （文件留痕，随 /doctor 诊断包导出），不再自动重试；
 *   - 周期清理：ack/drop 行累积到阈值就 compaction（只重写 pending + failed）。
 *
 * 文件格式（JSONL，一行一个 op）：
 *   {"op":"enq","id","chatId","text","queuedAt"}
 *   {"op":"ack","id","at"}
 *   {"op":"drop","id","reason","at"}
 *   {"op":"fail","entry":{...},"reason","attempts","at"}
 * 坏行跳过（只丢一行）；写失败只 warn，绝不影响发送路径。
 *
 * 关闭 durableOutbox 时本模块不参与，出站管线走旧的内存队列，行为与改造前
 * 逐字节一致。
 * @module dsh-onebot/outbox
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from './errors.js';
/** Outbox 文件与临时文件（append under mediaDir，与 qq-actions.log 同目录）。 */
export const OUTBOX_FILE = 'qq-outbox.jsonl';
export const OUTBOX_TMP_FILE = OUTBOX_FILE + '.tmp';
/** 队列总条数上限（所有聊天合计）；超过丢最旧一条（warn + 调用方通知，不静默）。 */
export const DEFAULT_OUTBOX_MAX_ENTRIES = 500;
/** 单条补发连续失败上限；达到后移入 failed 队列。 */
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
/** failed 列表内存/文件保留条数。 */
export const FAILED_KEEP = 50;
/** ack/drop 行累积到此数触发一次 compaction。 */
const COMPACT_AFTER_OPS = 256;
/** 进程内记住的已确认 id 个数上限（幂等去重的有界内存）。 */
const ACKED_KEEP = 4096;
/** One queued outbound reply. text 是已清洗的最终文本（strip 后的形态）。 */
export class DurableOutbox {
    dir;
    log;
    now;
    maxEntries;
    maxAttempts;
    /** id → entry（Map 插入序 = 全局 FIFO）。 */
    pending = new Map();
    /** due() 后尚未 ack/fail 的条目（进程崩溃时随文件重建，不丢）。 */
    inFlight = new Map();
    /** 终态失败条目（新→旧，有界）。 */
    failed = [];
    /** 已确认 id（有界 FIFO 记忆，防重复 enq 行被二次投递）。 */
    ackedIds = new Set();
    ackedOrder = [];
    stats = {
        loaded: 0,
        enqueued: 0,
        deduped: 0,
        sent: 0,
        sendFailed: 0,
        failed: 0,
        dropped: 0,
        compacted: 0,
        writeFailures: 0,
    };
    /** 串行写链：所有文件 op 按调用顺序落盘。 */
    writeChain = Promise.resolve();
    /** 自上次 compaction 以来累积的 ack/drop 行数。 */
    opsSinceCompact = 0;
    loadPromise = null;
    loaded = false;
    constructor(options = {}) {
        this.dir = options.dir;
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_OUTBOX_MAX_ENTRIES);
        this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS);
    }
    file() {
        return join(this.dir, OUTBOX_FILE);
    }
    tmpFile() {
        return join(this.dir, OUTBOX_TMP_FILE);
    }
    /** 读盘重建（幂等，可重复调）；内存中已有的条目合并进来（内存版后到、attempts 更新）。 */
    load() {
        if (this.loadPromise === null) {
            this.loadPromise = this.readFile().then((lines) => {
                const fromFile = new Map();
                const failedFromFile = [];
                for (const line of lines) {
                    let op;
                    try {
                        op = JSON.parse(line);
                    }
                    catch {
                        continue; // 坏行只丢一行
                    }
                    if (op === null || typeof op !== 'object')
                        continue;
                    if (op.op === 'enq' && typeof op.id === 'string' && op.id !== '') {
                        if (this.ackedIds.has(op.id))
                            continue;
                        fromFile.set(op.id, {
                            id: op.id,
                            chatId: String(op.chatId ?? ''),
                            text: String(op.text ?? ''),
                            queuedAt: Number(op.queuedAt ?? 0),
                            attempts: Number(op.attempts ?? 0),
                        });
                    }
                    else if (op.op === 'ack' && typeof op.id === 'string') {
                        fromFile.delete(op.id);
                        this.rememberAcked(op.id);
                    }
                    else if (op.op === 'drop' && typeof op.id === 'string') {
                        fromFile.delete(op.id);
                        this.rememberAcked(op.id);
                    }
                    else if (op.op === 'fail' && op.entry !== null && typeof op.entry === 'object') {
                        fromFile.delete(String(op.entry.id ?? ''));
                        failedFromFile.push({
                            id: String(op.entry.id ?? ''),
                            chatId: String(op.entry.chatId ?? ''),
                            text: String(op.entry.text ?? ''),
                            queuedAt: Number(op.entry.queuedAt ?? 0),
                            attempts: Number(op.attempts ?? 0),
                            reason: String(op.reason ?? ''),
                            failedAt: Number(op.at ?? 0),
                        });
                    }
                }
                // 合并：文件条目 + 内存条目（同 id 内存版覆盖：attempts 更新、排队时间更早的保留）
                for (const [id, entry] of this.pending) {
                    const existing = fromFile.get(id);
                    if (existing === undefined) {
                        fromFile.set(id, entry);
                    }
                    else {
                        existing.attempts = Math.max(existing.attempts, entry.attempts);
                        existing.queuedAt = Math.min(existing.queuedAt || entry.queuedAt, entry.queuedAt);
                    }
                }
                // 全局 FIFO：按 queuedAt 稳定排序（同毫秒保持插入序）
                const merged = [...fromFile.values()].map((entry, index) => ({ entry, index }))
                    .sort((a, b) => (a.entry.queuedAt - b.entry.queuedAt) || (a.index - b.index))
                    .map((item) => item.entry);
                this.pending = new Map(merged.map((entry) => [entry.id, entry]));
                this.failed = failedFromFile.slice(-FAILED_KEEP);
                this.stats.loaded = this.pending.size;
                this.loaded = true;
                return this.pending.size;
            }).catch((error) => {
                this.log('warn', 'outbox 读取失败（按空队列继续）: ' + describeError(error));
                this.loaded = true;
                return 0;
            });
        }
        return this.loadPromise;
    }
    async readFile() {
        let text;
        try {
            text = await readFile(this.file(), 'utf8');
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return [];
            throw error;
        }
        return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    }
    /** 排队一条外发回复。返回 { id, deduped, dropped }——
     *  deduped=true 表示相同 (chatId, text) 已在队列（幂等，不重复入队）；
     *  dropped 是因总上限被挤掉的最旧条目（调用方负责通知，不静默丢）。 */
    enqueue(chatId, text, options = {}) {
        const queuedAt = this.now();
        // 幂等：同一 chat 同一文本已在队列时不再入队（防断线分支被触发两次）。
        // due() 把条目从 pending 搬到 inFlight，补发窗口内同文本再来必须一起扫，
        // 否则会当成新条目入队，补发完成后 QQ 上出现两条一样的消息。
        for (const entry of [...this.pending.values(), ...this.inFlight.values()]) {
            if (entry.chatId === chatId && entry.text === text) {
                this.stats.deduped += 1;
                return { id: entry.id, deduped: true, dropped: undefined };
            }
        }
        const entry = {
            id: options.id ?? randomUUID(),
            chatId,
            text,
            queuedAt,
            attempts: 0,
        };
        let dropped;
        while (this.pending.size >= this.maxEntries) {
            const oldest = this.pending.keys().next();
            if (oldest.done === true)
                break;
            const victim = this.pending.get(oldest.value);
            this.pending.delete(oldest.value);
            this.inFlight.delete(oldest.value);
            this.stats.dropped += 1;
            this.append({ op: 'drop', id: victim.id, reason: 'outbox full (maxEntries=' + this.maxEntries + ')', at: queuedAt });
            dropped = victim;
        }
        this.pending.set(entry.id, entry);
        this.stats.enqueued += 1;
        this.append({ op: 'enq', id: entry.id, chatId, text, queuedAt });
        return { id: entry.id, deduped: false, dropped };
    }
    /** due() 后被重新park（补发瞬间又断线）：同 id 回队，保序重试。 */
    requeue(id) {
        const entry = this.inFlight.get(id);
        if (entry === undefined)
            return false;
        this.inFlight.delete(id);
        this.pending.set(entry.id, entry);
        this.append({ op: 'enq', id: entry.id, chatId: entry.chatId, text: entry.text, queuedAt: entry.queuedAt });
        return true;
    }
    /** 取出全部待补发条目（全局 FIFO），转入 inFlight；ack/fail 前进程崩溃 →
     *  文件里的 enq 行仍在，重启后 load() 重建，at-least-once 不丢。 */
    due() {
        const batch = [...this.pending.values()];
        this.pending.clear();
        for (const entry of batch)
            this.inFlight.set(entry.id, entry);
        return batch;
    }
    /** 补发成功：确认（ack 行落盘 + 进程内记住 id）。 */
    ack(id) {
        const entry = this.inFlight.get(id);
        this.inFlight.delete(id);
        this.rememberAcked(id);
        this.stats.sent += 1;
        this.append({ op: 'ack', id, at: this.now() });
        if (entry !== undefined && this.pending.has(id))
            this.pending.delete(id);
        this.maybeCompact();
    }
    /** 补发失败：attempts+1；未到上限回队等下次重连，到达上限移入 failed 队列。 */
    fail(id, reason) {
        const entry = this.inFlight.get(id) ?? this.pending.get(id);
        this.inFlight.delete(id);
        if (entry === undefined)
            return 'gone';
        entry.attempts += 1;
        this.stats.sendFailed += 1;
        if (entry.attempts >= this.maxAttempts) {
            this.pending.delete(id);
            this.failed.push({ ...entry, reason, failedAt: this.now() });
            if (this.failed.length > FAILED_KEEP)
                this.failed.shift();
            this.stats.failed += 1;
            this.append({ op: 'fail', entry: { id: entry.id, chatId: entry.chatId, text: entry.text, queuedAt: entry.queuedAt }, reason, attempts: entry.attempts, at: this.now() });
            this.maybeCompact();
            return 'failed';
        }
        this.pending.set(entry.id, entry); // 回队尾，下次补发窗口重试
        return 'retry';
    }
    /** 主动丢弃一条（TTL 过期等）：落 drop 行 + 通知性统计。 */
    drop(id, reason) {
        const entry = this.inFlight.get(id) ?? this.pending.get(id);
        this.inFlight.delete(id);
        this.pending.delete(id);
        if (entry !== undefined) {
            this.stats.dropped += 1;
            this.append({ op: 'drop', id, reason, at: this.now() });
            this.maybeCompact();
        }
        return entry;
    }
    /** 待补发总条数（状态徽标用）。 */
    pendingCount() {
        return this.pending.size + this.inFlight.size;
    }
    /** 状态快照（/status 与设置页徽标同源）。
     *  注意展开顺序：stats 计数器在前、显式字段在后——failed 必须是当前
     *  failed 列表长度（重启后从文件重建的列表），不能被 stats.failed
     *  （本进程内终态失败计数）覆盖。 */
    getStats() {
        return {
            ...this.stats,
            enabled: true,
            pending: this.pending.size,
            inFlight: this.inFlight.size,
            failed: this.failed.length,
            maxEntries: this.maxEntries,
            maxAttempts: this.maxAttempts,
        };
    }
    /** 最近失败条目（诊断/导出用）。 */
    recentFailed(limit = 10) {
        return this.failed.slice(-limit).reverse();
    }
    /** 等写链落盘（自测/停止时用）。 */
    flush() {
        return this.writeChain;
    }
    rememberAcked(id) {
        if (this.ackedIds.has(id))
            return;
        this.ackedIds.add(id);
        this.ackedOrder.push(id);
        if (this.ackedOrder.length > ACKED_KEEP) {
            const evict = this.ackedOrder.splice(0, this.ackedOrder.length - ACKED_KEEP);
            for (const id2 of evict)
                this.ackedIds.delete(id2);
        }
    }
    /** 追加一行（串行链；失败只 warn 并计数，绝不影响发送）。 */
    append(op) {
        const line = JSON.stringify(op) + '\n';
        this.writeChain = this.writeChain.then(async () => {
            try {
                await mkdir(this.dir, { recursive: true });
                await appendFile(this.file(), line, 'utf8');
                if (op.op === 'ack' || op.op === 'drop') {
                    this.opsSinceCompact += 1;
                }
            }
            catch (error) {
                this.stats.writeFailures += 1;
                this.log('warn', 'outbox 写盘失败（不影响发送，重启可能重发一条）: ' + describeError(error));
            }
        }).catch(() => undefined);
    }
    /** ack/drop 行攒到阈值就重写文件（只留 pending + failed），防止文件无限增长。 */
    maybeCompact() {
        if (this.opsSinceCompact < COMPACT_AFTER_OPS)
            return;
        this.opsSinceCompact = 0;
        this.compact();
    }
    /** 重写：pending + inFlight 的 enq 行 + 最近 failed 行。原子替换（tmp + rename）。
     *  inFlight 必须一起写：due() 已取出尚未 ack 的条目只存在于内存，漏写它们
     *  等于压缩后崩溃即丢消息（at-least-once 破防）；load() 会按 queuedAt
     *  稳定排序还原全局 FIFO，文件内顺序不影响保序性。 */
    compact() {
        const lines = [];
        for (const entry of [...this.inFlight.values(), ...this.pending.values()]) {
            lines.push(JSON.stringify({ op: 'enq', id: entry.id, chatId: entry.chatId, text: entry.text, queuedAt: entry.queuedAt }) + '\n');
        }
        for (const item of this.failed.slice(-FAILED_KEEP)) {
            lines.push(JSON.stringify({ op: 'fail', entry: { id: item.id, chatId: item.chatId, text: item.text, queuedAt: item.queuedAt }, reason: item.reason, attempts: item.attempts, at: item.failedAt }) + '\n');
        }
        const payload = lines.join('');
        this.writeChain = this.writeChain.then(async () => {
            try {
                await mkdir(this.dir, { recursive: true });
                await writeFile(this.tmpFile(), payload, 'utf8');
                await rename(this.tmpFile(), this.file());
                this.stats.compacted += 1;
            }
            catch (error) {
                this.stats.writeFailures += 1;
                this.log('warn', 'outbox 压缩失败（不影响发送）: ' + describeError(error));
            }
        }).catch(() => undefined);
    }
}
