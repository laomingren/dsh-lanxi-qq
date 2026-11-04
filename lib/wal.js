/**
 * 入站 WAL（2026-11-02 P0 改造，对齐竞品 dsh-lark-link 的入站预写日志）：
 * 每条真实入站消息（注入/回放的除外）在处理前先写一行 enq，同步处理完成后
 * （handleInboundOnce 收口）写一行 ack。进程在「写了 enq 还没写 ack」时被杀，
 * 该消息的重启后自动重放（inboundWalReplay=true）——补回「处理到一半崩溃」
 * 丢掉的入站，与持久 Outbox 合成双向 at-least-once。
 *
 * 为什么重放是安全的：ack 点在实际派发（dispatchFollowup）之后、异步模型
 * 回合之前——已回复过的消息一定已 ack，不会二次回复；未 ack 的消息其派发
 * 随进程一起死亡，重放等于第一次处理。残留风险（崩溃恰好落在派发后、ack
 * 前）最多多重放一条，报告里有说明。
 *
 * 文件格式（mediaDir/qq-inbox-wal.jsonl，一行一个 op）：
 *   {"op":"enq","id","ts","frame"}   frame = record.js 的 toInboxFrame 业务帧
 *   {"op":"ack","id","at"}
 *   {"op":"replay","id","at"}        重放过一次后标记，避免崩溃-重放-崩溃循环
 * 纯旁路：写失败只 warn，绝不影响收消息；ack 行攒到阈值 compaction。
 * @module dsh-onebot/wal
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from './errors.js';
import { toInboxFrame } from './record.js';
/** WAL 文件与临时文件（append under mediaDir）。 */
export const WAL_FILE = 'qq-inbox-wal.jsonl';
export const WAL_TMP_FILE = WAL_FILE + '.tmp';
/** ack 行累积到此数触发一次 compaction。 */
const COMPACT_AFTER_ACKS = 512;
/** frame 文本截断（与 record.js 同一口径，防超大消息撑爆 WAL）。 */
const FRAME_TEXT_MAX_CHARS = 2000;
/**
 * 入站预写日志。会话形态与 InboundRecorder 对齐：begin(event) 拿 session，
 * bridge 在同步处理收口时调 session.end() 写 ack。
 */
export class InboundWal {
    dir;
    log;
    now;
    writeChain = Promise.resolve();
    acksSinceCompact = 0;
    loadPromise = null;
    /** loadUnacked 缓存是否已过期（任何 append/compact 后置位，下次重读文件）。 */
    dirty = false;
    refreshingUnacked = false;
    /** 未确认条数：内存计数（begin +1 / end -1）与文件计数（refreshUnacked）
     *  双轨，文件算过一次后以文件为准（崩溃恢复后内存计数从零开始，不可信）。 */
    unacked = 0;
    unackedFile = -1;
    stats = { enqWritten: 0, ackWritten: 0, replayed: 0, compacted: 0, writeFailures: 0 };
    constructor(options = {}) {
        this.dir = options.dir;
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
    }
    file() {
        return join(this.dir, WAL_FILE);
    }
    tmpFile() {
        return join(this.dir, WAL_TMP_FILE);
    }
    /** 开始一条入站的 WAL 记录：同步写 enq 行（不等盘），返回会话。 */
    begin(event) {
        const frame = toInboxFrame(event);
        for (const key of ['raw_message', 'message']) {
            const value = frame[key];
            if (typeof value === 'string' && value.length > FRAME_TEXT_MAX_CHARS) {
                frame[key] = value.slice(0, FRAME_TEXT_MAX_CHARS);
            }
        }
        const id = frame.message_id !== undefined && frame.message_id !== ''
            ? frame.message_id
            : 'wal-' + this.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        this.append({ op: 'enq', id, ts: this.now(), frame });
        this.stats.enqWritten += 1;
        this.unacked += 1;
        const wal = this;
        return {
            id,
            frame,
            /** 同步处理收口：确认这条入站（不再重放）。 */
            end() {
                wal.append({ op: 'ack', id, at: wal.now() });
                wal.stats.ackWritten += 1;
                wal.unacked = Math.max(0, wal.unacked - 1);
                wal.acksSinceCompact += 1;
                if (wal.acksSinceCompact >= COMPACT_AFTER_ACKS) {
                    wal.acksSinceCompact = 0;
                    wal.compact();
                }
            },
        };
    }
    /** 读出所有未确认（enq 后无 ack/replay）的业务帧——重启重放的原料。
     *  结果带缓存，但任何 append（enq/ack/replay/compact）都会置 dirty 使下次
     *  调用重读——否则 refreshUnacked() 永远返回开机时的快照，徽标上的
     *  「未确认」计数再也不更新。读之前先等写链，保证看到全部已发起的写。 */
    loadUnacked() {
        if (this.loadPromise === null || this.dirty) {
            this.dirty = false;
            this.loadPromise = this.writeChain.then(() => this.readLines()).then((lines) => {
                const unacked = new Map();
                for (const line of lines) {
                    let op;
                    try {
                        op = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (op === null || typeof op !== 'object')
                        continue;
                    const id = typeof op.id === 'string' ? op.id : '';
                    if (id === '')
                        continue;
                    if (op.op === 'enq' && op.frame !== null && typeof op.frame === 'object') {
                        unacked.set(id, op.frame);
                    }
                    else if (op.op === 'ack' || op.op === 'replay') {
                        unacked.delete(id);
                    }
                }
                return [...unacked.entries()].map(([id, frame]) => ({ id, frame }));
            }).catch((error) => {
                this.log('warn', '入站 WAL 读取失败（跳过重放）: ' + describeError(error));
                return [];
            });
        }
        return this.loadPromise;
    }
    /** 标记一条已重放：后续崩溃不再重投它（at-least-once 的有界化）。 */
    markReplayed(id) {
        this.append({ op: 'replay', id, at: this.now() });
        this.stats.replayed += 1;
        this.unacked = Math.max(0, this.unacked - 1);
    }
    /** 从文件重算未确认条数（状态刷新节奏调用；同时进行只一次，失败保持旧值）。 */
    async refreshUnacked() {
        if (this.refreshingUnacked)
            return;
        this.refreshingUnacked = true;
        try {
            const unacked = await this.loadUnacked();
            this.unackedFile = unacked.length;
        }
        catch {
            // 读失败：保持上次已知值
        }
        finally {
            this.refreshingUnacked = false;
        }
    }
    /** 重写文件只留未确认条目（原子替换）。 */
    compact() {
        this.dirty = true; // 文件被重写：loadUnacked 缓存过期
        this.writeChain = this.writeChain.then(async () => {
            try {
                const lines = await this.readLines();
                const unacked = new Map();
                for (const line of lines) {
                    let op;
                    try {
                        op = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (op === null || typeof op !== 'object')
                        continue;
                    const id = typeof op.id === 'string' ? op.id : '';
                    if (id === '')
                        continue;
                    if (op.op === 'enq' && op.frame !== null && typeof op.frame === 'object') {
                        unacked.set(id, op);
                    }
                    else if (op.op === 'ack' || op.op === 'replay') {
                        unacked.delete(id);
                    }
                }
                const payload = [...unacked.values()].map((op) => JSON.stringify(op) + '\n').join('');
                await mkdir(this.dir, { recursive: true });
                await writeFile(this.tmpFile(), payload, 'utf8');
                await rename(this.tmpFile(), this.file());
                this.stats.compacted += 1;
            }
            catch (error) {
                this.log('warn', '入站 WAL 压缩失败（不影响收消息）: ' + describeError(error));
            }
        }).catch(() => undefined);
    }
    async readLines() {
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
    /** 追加一行（串行链；失败只 warn）。 */
    append(op) {
        this.dirty = true; // 文件即将变化：loadUnacked 缓存过期
        const line = JSON.stringify(op) + '\n';
        this.writeChain = this.writeChain.then(async () => {
            try {
                await mkdir(this.dir, { recursive: true });
                await appendFile(this.file(), line, 'utf8');
            }
            catch (error) {
                this.stats.writeFailures += 1;
                this.log('warn', '入站 WAL 写盘失败（不影响收消息）: ' + describeError(error));
            }
        }).catch(() => undefined);
    }
    /** 等写链落盘（自测/停止时用）。 */
    flush() {
        return this.writeChain;
    }
    getStats() {
        return {
            enabled: true,
            unacked: this.unackedFile >= 0 ? this.unackedFile : this.unacked,
            ...this.stats,
        };
    }
}
