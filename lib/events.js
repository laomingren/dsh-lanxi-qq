/**
 * 事件时间线（2026-11-02 P0 改造，对齐竞品 dsh-switchboard 的聊天时间线 /
 * dsh-im-channel 的状态页数据面）：内存环形缓冲 + 落盘 qq-events.jsonl。
 * 只记元数据不记正文（隐私）：ts / direction(in|out|conn) / chatId / kind /
 * ok / reason。设置页「最近事件」面板与 /doctor 诊断包同源。
 *
 * 落盘是为了「重启后仍在」：loadTail() 在启动时把文件尾部读回环形缓冲。
 * 轮转与 record.js 同款（2MiB 改名，保留 2 代）。纯旁路：写失败只 warn。
 * @module dsh-onebot/events
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from './errors.js';
/** 事件文件与轮转名（append under mediaDir）。 */
export const EVENTS_FILE = 'qq-events.jsonl';
export function eventsRotatedFile(generation) {
    return 'qq-events.' + generation + '.jsonl';
}
/** 单文件体积上限（2 MiB，与 qq-inbox.jsonl 一致）。 */
export const EVENTS_MAX_BYTES = 2 * 1024 * 1024;
/** 保留几代轮转文件。 */
export const EVENTS_KEEP_ROTATED = 2;
/** 环形缓冲容量（设置页面板默认展示条数的上界）。 */
export const DEFAULT_EVENTS_CAPACITY = 500;
/** One timeline event. NEVER carries message text. */
export class EventLog {
    dir;
    log;
    now;
    capacity;
    maxBytes;
    keepRotated;
    /** 环形缓冲（新→旧由 recent() 决定返回顺序；内部旧→新）。 */
    ring = [];
    writeChain = Promise.resolve();
    dirEnsured = false;
    lastWriteWarnAt = 0;
    /** 每条记录后的同步钩子（桥用来喂 StatusStore 的今日错误计数；异常吞掉）。 */
    onRecord;
    stats = { recorded: 0, writeFailures: 0, rotated: 0 };
    constructor(options = {}) {
        this.dir = options.dir;
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.onRecord = options.onRecord;
        this.capacity = Math.max(10, options.capacity ?? DEFAULT_EVENTS_CAPACITY);
        this.maxBytes = options.maxBytes ?? EVENTS_MAX_BYTES;
        this.keepRotated = Math.max(1, options.keepRotated ?? EVENTS_KEEP_ROTATED);
    }
    file() {
        return join(this.dir, EVENTS_FILE);
    }
    /** 记一条事件（同步入环 + 异步落盘；绝抛不出）。 */
    record(event) {
        const line = {
            ts: this.now(),
            d: event.direction,
            chatId: event.chatId ?? '',
            kind: event.kind ?? '',
            ok: event.ok !== false,
            reason: event.reason ?? '',
            ...(event.messageId !== undefined ? { mid: event.messageId } : {}),
        };
        this.ring.push(line);
        if (this.ring.length > this.capacity)
            this.ring.shift();
        this.stats.recorded += 1;
        this.append(line);
        if (this.onRecord !== undefined) {
            try {
                this.onRecord(line);
            }
            catch {
                // 钩子异常绝不冒泡到记录方
            }
        }
        return line;
    }
    /** 最近 limit 条（最新在前）；chatId 非空时只留该会话。 */
    recent(limit = 50, chatId = '') {
        const filtered = chatId === ''
            ? this.ring
            : this.ring.filter((event) => event.chatId === chatId);
        return filtered.slice(-Math.max(1, limit)).reverse();
    }
    /** 启动时把文件尾部读回环形缓冲（重启后面板仍有历史）。 */
    async loadTail(limit = this.capacity) {
        try {
            const text = await readFile(this.file(), 'utf8');
            const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
            const tail = lines.slice(-limit);
            const events = [];
            for (const line of tail) {
                try {
                    const event = JSON.parse(line);
                    if (event !== null && typeof event === 'object' && typeof event.ts === 'number')
                        events.push(event);
                }
                catch {
                    // 坏行只丢一行
                }
            }
            this.ring = events;
            return events.length;
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.log('warn', '事件时间线读取失败（按空开始）: ' + describeError(error));
            }
            return 0;
        }
    }
    /** 今日错误数（ok:false 且是今天）——统计徽标用。 */
    errorsToday(dayStartMs, dayEndMs) {
        let count = 0;
        for (const event of this.ring) {
            if (event.ok === false && event.ts >= dayStartMs && event.ts < dayEndMs)
                count += 1;
        }
        return count;
    }
    append(line) {
        const text = JSON.stringify(line) + '\n';
        this.writeChain = this.writeChain.then(async () => {
            try {
                if (!this.dirEnsured) {
                    await mkdir(this.dir, { recursive: true });
                    this.dirEnsured = true;
                }
                const file = this.file();
                if (await this.fileAtCap(file))
                    await this.rotate();
                await appendFile(file, text, 'utf8');
                if (await this.fileAtCap(file))
                    await this.rotate();
            }
            catch (error) {
                this.stats.writeFailures += 1;
                const now = this.now();
                if (now - this.lastWriteWarnAt >= 5 * 60_000) {
                    this.lastWriteWarnAt = now;
                    this.log('warn', '事件时间线写盘失败（5 分钟内不再重复告警）: ' + describeError(error));
                }
            }
        }).catch(() => undefined);
    }
    async fileAtCap(file) {
        try {
            return (await stat(file)).size >= this.maxBytes;
        }
        catch {
            return false;
        }
    }
    async rotate() {
        const file = this.file();
        for (let i = this.keepRotated - 1; i >= 1; i--) {
            try {
                await rename(join(this.dir, eventsRotatedFile(i)), join(this.dir, eventsRotatedFile(i + 1)));
            }
            catch {
                // 没有旧文件：不用挪
            }
        }
        try {
            await rename(file, join(this.dir, eventsRotatedFile(1)));
            this.stats.rotated += 1;
        }
        catch (error) {
            this.log('warn', '事件文件轮转失败: ' + describeError(error));
        }
    }
    /** 等写链落盘（自测用）。 */
    flush() {
        return this.writeChain;
    }
    getStats() {
        return { ...this.stats };
    }
}
