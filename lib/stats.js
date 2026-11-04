/**
 * 每日收发计数（2026-11-01，概览数字）。
 *
 * 每次收发往 `data/onebot-stats/<本地日期>.jsonl` 追加一行，只记**类型**不记内容：
 *   {"t":"2026-11-01T03:31:22.123Z","d":"out","k":"text"}
 * 用 jsonl 而不是单个 JSON：并发追加不会互相覆盖，坏一行也只丢一行。
 * 汇总用 `tools/onebot-stats.mjs` 读。
 * @module dsh-onebot/stats
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 2026-11-02 (fork): 默认目录不再写死 D 盘绝对路径 —— 别人机器上没有 D 盘。
// 改成 <用户目录>/.dsh/data/onebot-stats，跟 inbound.js 的 VOICE_EAR 保持同一套习惯。
/** 默认统计目录（插件配置 statsDir 可覆盖）。 */
export const DEFAULT_STATS_DIR = join(homedir(), '.dsh', 'data', 'onebot-stats');

/** 本地日期 YYYY-MM-DD（按系统时区，不走 UTC——否则北京时间每天 8 点才换日）。 */
export function localDay(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

/** 从 OneBot message 数组推导类型集合（同一段里多个类型各记一次）。 */
export function kindsOfSegments(message) {
    if (!Array.isArray(message)) {
        return typeof message === 'string' && message !== '' ? ['text'] : [];
    }
    const kinds = new Set();
    for (const seg of message) {
        const type = typeof seg?.type === 'string' ? seg.type : '';
        if (type === 'record') kinds.add('voice');
        else if (type === 'mface' || type === 'face') kinds.add('sticker');
        else if (type === 'text' || type === 'image' || type === 'video' || type === 'file' || type === 'forward') kinds.add(type);
        else if (type === 'reply' || type === 'at' || type === 'json' || type === 'xml') continue; // 不算「一条内容」
        else if (type !== '') kinds.add('other');
    }
    return [...kinds];
}

/**
 * 串行追加的日计数记录器。
 * 写失败只 warn，绝不影响消息本身——统计永远不许拖垮通道。
 */
export class DailyStatsRecorder {
    dir;
    log;
    chain = Promise.resolve();
    /** 已确认建好的目录（跨天换文件时目录不变，不用每条都 mkdir）。 */
    readyDir = '';
    /** 同一条失败只 warn 一次——目录写不进去时不该每条消息刷一行。 */
    warned = new Set();
    constructor({ dir, log } = {}) {
        this.dir = typeof dir === 'string' && dir !== '' ? dir : DEFAULT_STATS_DIR;
        this.log = typeof log === 'function' ? log : () => {};
    }
    /** 记一条：direction = 'out' | 'in'，kind = text/image/voice/video/file/forward/sticker/other。 */
    record(direction, kind) {
        const now = new Date();
        const file = join(this.dir, localDay(now) + '.jsonl');
        const line = JSON.stringify({ t: now.toISOString(), d: direction, k: kind }) + '\n';
        this.chain = this.chain
            .then(async () => {
            if (this.readyDir !== this.dir) {
                await mkdir(this.dir, { recursive: true });
                this.readyDir = this.dir;
            }
            await appendFile(file, line, 'utf8');
        })
            .catch((error) => {
            this.readyDir = ''; // 目录可能被删了：下次重新建
            this.warnOnce('统计写入失败（不影响消息）: ' + (error instanceof Error ? error.message : String(error)));
        });
    }
    /** 把 kinds 里的每一种各记一条；空数组按 other 记一条，保证「发过就算一条」。 */
    recordKinds(direction, kinds) {
        const list = kinds.length > 0 ? kinds : ['other'];
        for (const kind of list)
            this.record(direction, kind);
    }
    /** 等当前追加链落盘（自测用）。 */
    flush() {
        return this.chain;
    }
    warnOnce(message) {
        if (this.warned.has(message))
            return;
        this.warned.add(message);
        this.log('warn', message);
    }
}
