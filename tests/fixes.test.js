/**
 * 2026-11-05 0.1.2 改造回归：批次 1（A1/A5/A6/A3）。
 * 只测纯函数/可注入的小对象，不连 NapCat、不起插件。
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableOutbox } from '../lib/outbox.js';
import { OneBotConnection } from '../lib/connection.js';
import { MediaStore } from '../lib/media.js';
import { ChatBridge, shapeSteerPayload } from '../lib/bridge.js';
import { OutboundPipeline, bubbleDelayMs, splitForBubbles } from '../lib/outbound.js';
import { stripPromptEcho } from '../lib/split.js';

const temps = [];

async function tempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'lanxi-qq-fixes-'));
    temps.push(dir);
    return dir;
}

afterEach(async () => {
    while (temps.length > 0) {
        const dir = temps.pop();
        await rm(dir, { recursive: true, force: true });
    }
});

describe('A1 outbox 去重覆盖 inFlight', () => {
    it('due() 后同文本再 enqueue 必须 deduped，补发只 ack 一次', async () => {
        const dir = await tempDir();
        const outbox = new DurableOutbox({ dir, now: () => 1000, log: () => undefined });
        await outbox.load();
        const first = outbox.enqueue('private:1', '同一句话');
        expect(first.deduped).toBe(false);
        const batch = outbox.due();
        expect(batch).toHaveLength(1);
        expect(outbox.pendingCount()).toBe(1); // 那 1 条在 inFlight

        const again = outbox.enqueue('private:1', '同一句话');
        expect(again.deduped).toBe(true);
        expect(again.id).toBe(first.id);
        expect(outbox.pendingCount()).toBe(1);
        expect(outbox.stats.deduped).toBe(1);

        outbox.ack(first.id);
        expect(outbox.pendingCount()).toBe(0);
        expect(outbox.stats.sent).toBe(1);
        await outbox.flush();
    });

    it('不同文本/不同会话的相同文本仍各自入队', async () => {
        const dir = await tempDir();
        const outbox = new DurableOutbox({ dir, now: () => 1000, log: () => undefined });
        await outbox.load();
        outbox.enqueue('private:1', '同一句话');
        outbox.due();
        expect(outbox.enqueue('private:1', '另一句话').deduped).toBe(false);
        expect(outbox.enqueue('private:2', '同一句话').deduped).toBe(false);
        expect(outbox.pendingCount()).toBe(3); // 1 条 inFlight + 2 条 pending
        await outbox.flush();
    });
});

describe('A5 connection.stop 保留 error 监听', () => {
    it('stop 后 socket emit error 不抛未捕获异常', async () => {
        const conn = new OneBotConnection({ mode: 'reverse', callTimeoutMs: 1000, log: () => undefined });
        const socket = new EventEmitter();
        socket.close = () => undefined;
        conn.socket = socket;
        await conn.stop();
        expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
    });
});

describe('A6 bridge 启动链终端 catch', () => {
    it('loadRetired reject 后 mappingLoaded resolved 且日志带阶段名', async () => {
        const logs = [];
        const fake = {
            stopping: false,
            deps: {
                connection: {},
                ctx: { on: () => () => undefined },
                config: {},
                log: (level, message) => logs.push(level + ':' + message),
            },
            registry: {
                mappingLoaded: undefined,
                chats: new Map(),
                loadRetired: async () => { throw new Error('boom-retired'); },
                loadSwitchable: async () => undefined,
                loadMapping: async () => undefined,
            },
            deferred: { loadPersisted: async () => undefined },
            replayInboundWal: async () => undefined,
            watchdog: { start: () => undefined },
            ready: async () => undefined,
        };
        ChatBridge.prototype.start.call(fake);
        await expect(fake.registry.mappingLoaded).resolves.toBeUndefined();
        expect(logs.some((line) => line.startsWith('error:bridge ready failed at loadRetired'))).toBe(true);
    });
});

describe('A3 入站 base64 / file:// 大小上限', () => {
    it('超限 base64 直接跳过，不分配解码后的 Buffer', async () => {
        const dir = await tempDir();
        const store = new MediaStore(join(dir, 'out'), 6, 0, { maxBytes: 1000 });
        const encoded = 'A'.repeat(Math.ceil(1000 * 4 / 3) + 64);
        expect(await store.resolve({ kind: 'image', file: 'base64://' + encoded })).toBeUndefined();
        expect(await readdir(join(dir, 'out'))).toEqual([]);
    });

    it('未超限 base64 正常落盘', async () => {
        const dir = await tempDir();
        const store = new MediaStore(join(dir, 'out'), 6, 0, { maxBytes: 1000 });
        const result = await store.resolve({ kind: 'image', file: 'base64://' + Buffer.from('hello').toString('base64') });
        expect(result?.path).toBeTruthy();
        expect((await readdir(join(dir, 'out'))).length).toBe(1);
    });

    it('超限 file:// 不复制到 media 目录', async () => {
        const dir = await tempDir();
        const source = join(dir, 'big.bin');
        await writeFile(source, Buffer.alloc(2000));
        const store = new MediaStore(join(dir, 'out'), 6, 0, { maxBytes: 1000 });
        expect(await store.resolve({ kind: 'file', file: 'file://' + source })).toBeUndefined();
        expect(await readdir(join(dir, 'out'))).toEqual([]);
    });
});

function outboundCtx(config, calls = [], events = []) {
    return {
        config,
        connected: () => false,
        call: async (action, params) => {
            calls.push({ action, params });
            return { message_id: 'm1' };
        },
        log: () => undefined,
        trace: () => undefined,
        events: { record: (event) => events.push(event) },
        getChat: () => undefined,
        isStopping: () => false,
        selfId: () => '',
    };
}

describe('A4 dryRun 行为对齐', () => {
    it('dryRun + 未连接时被动回复放行到 call 拦截层，不入队', async () => {
        const calls = [];
        const events = [];
        const ctx = outboundCtx({
            dryRun: true,
            durableOutbox: false,
            mediaDir: '',
            sensitivePatterns: [],
            textImageThreshold: 0,
            groupAutoSilence: false,
        }, calls, events);
        const pipeline = new OutboundPipeline(ctx);
        const ids = await pipeline.sendToChat('private:1', '你好', { queuable: true });
        expect(ids).toEqual(['m1']);
        expect(calls).toHaveLength(1);
        expect(calls[0].action).toBe('send_msg');
        expect(pipeline.pendingSends.size).toBe(0);
        expect(events.at(-1)?.reason).toContain('dryRun');
    });

    it('dryRun 下 queuePendingSend 不往 outbox 落盘', async () => {
        const dir = await tempDir();
        const ctx = outboundCtx({
            dryRun: true,
            durableOutbox: true,
            mediaDir: dir,
            sensitivePatterns: [],
            textImageThreshold: 0,
            groupAutoSilence: false,
        });
        const pipeline = new OutboundPipeline(ctx);
        pipeline.queuePendingSend('private:1', '排队试试');
        expect(pipeline.outbox?.pendingCount()).toBe(0);
    });

    it('dryRun 下补发旧队列走模拟发送并 ack，不会留到关闭后真发', async () => {
        const dir = await tempDir();
        const calls = [];
        const ctx = outboundCtx({
            dryRun: true,
            durableOutbox: true,
            mediaDir: dir,
            sensitivePatterns: [],
            textImageThreshold: 0,
            groupAutoSilence: false,
        }, calls);
        const pipeline = new OutboundPipeline(ctx);
        pipeline.outbox.enqueue('private:1', '断线时攒下的回复');
        await pipeline.drainDurableOutbox();
        expect(calls).toHaveLength(1);
        expect(pipeline.outbox.pendingCount()).toBe(0);
    });
});

describe('A2 bubbleSplit 接线', () => {
    it('关闭时整条发送', () => {
        expect(splitForBubbles('第一段\n\n第二段', 'private:1', { bubbleSplit: false })).toEqual(['第一段\n\n第二段']);
    });

    it('开启后按空行分段', () => {
        expect(splitForBubbles('第一段\n\n第二段\n\n第三段', 'private:1', { bubbleSplit: true }))
            .toEqual(['第一段', '第二段', '第三段']);
    });

    it('maxMessages 超出的段并入末段', () => {
        const text = Array.from({ length: 6 }, (_, i) => `第${i}段`).join('\n\n');
        const parts = splitForBubbles(text, 'private:1', { bubbleSplit: true, bubbleMaxMessages: 3, bubbleMaxChars: 5 });
        expect(parts).toHaveLength(3);
        expect(parts[2]).toContain('第5段');
    });

    it('maxChars 只在段数超上限时合并短段、超长整句不硬切', () => {
        const long = '长'.repeat(50);
        const text = [long, 'aaa', 'bbb', 'ccc'].join('\n\n');
        const parts = splitForBubbles(text, 'private:1', { bubbleSplit: true, bubbleMaxMessages: 2, bubbleMaxChars: 7 });
        expect(parts.length).toBe(2);
        expect(parts[0]).toBe(long);
        expect(parts[1]).toContain('aaa');
        expect(parts[1]).toContain('ccc');
    });

    it('bubbleOnlyChats 之外保持整条', () => {
        const text = '第一段\n\n第二段';
        expect(splitForBubbles(text, 'private:1', { bubbleSplit: true, bubbleOnlyChats: ['group:9'] })).toEqual([text]);
        expect(splitForBubbles(text, 'group:9', { bubbleSplit: true, bubbleOnlyChats: ['group:9'] })).toEqual(['第一段', '第二段']);
    });

    it('坏配置钳制：maxMessages=0 仍至少发一条', () => {
        expect(splitForBubbles('第一段\n\n第二段', 'private:1', { bubbleSplit: true, bubbleMaxMessages: 0 }).length).toBe(1);
    });

    it('间隔在配置区间内且长停顿概率可控', () => {
        const normal = bubbleDelayMs({ bubbleGapMinMs: 100, bubbleGapMaxMs: 200, bubbleLongGapProbability: 0 }, () => 0.5);
        expect(normal).toBe(150);
        const rolls = [0.1, 0.5];
        const long = bubbleDelayMs({ bubbleGapMinMs: 100, bubbleGapMaxMs: 200, bubbleLongGapProbability: 0.2, bubbleLongGapMinMs: 4000, bubbleLongGapMaxMs: 8000 }, () => rolls.shift() ?? 0);
        expect(long).toBe(6000);
    });

    it('stopBubbles 能中断延迟中的分条发送', async () => {
        const calls = [];
        const ctx = outboundCtx({
            dryRun: false,
            durableOutbox: false,
            mediaDir: '',
            sensitivePatterns: [],
            textImageThreshold: 0,
            groupAutoSilence: false,
            bubbleSplit: true,
            bubbleGapMinMs: 60_000,
            bubbleGapMaxMs: 60_000,
            bubbleLongGapProbability: 0,
        }, calls);
        ctx.connected = () => true;
        const pipeline = new OutboundPipeline(ctx);
        const promise = pipeline.sendToChat('private:1', '第一段\n\n第二段', {});
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toHaveLength(1);
        pipeline.stopBubbles();
        const ids = await promise;
        expect(ids).toHaveLength(1);
    });
});

describe('B1 steer 保留 user_message 边界', () => {
    it('私聊忙时插话：边界保留、正文完整', () => {
        const text = '<user_message qq="123" nickname="某人">你现在忙吗</user_message>';
        expect(shapeSteerPayload(text)).toBe(text);
    });

    it('群前缀 + 受限标签剥掉，边界保留', () => {
        const text = '[受限用户:仅问答] [22:17 某群友(123456)][@我] <user_message qq="123" nickname="某人">群里插一句</user_message>';
        expect(shapeSteerPayload(text)).toBe('<user_message qq="123" nickname="某人">群里插一句</user_message>');
    });

    it('语音转写（无边界）原样送', () => {
        expect(shapeSteerPayload('（语音转写：你好）')).toBe('（语音转写：你好）');
    });

    it('边界内夹带的 system-reminder 被清掉，边界还在', () => {
        const text = '<user_message qq="1" nickname="a">正文<system-reminder>x</system-reminder>尾巴</user_message>';
        expect(shapeSteerPayload(text)).toBe('<user_message qq="1" nickname="a">正文尾巴</user_message>');
    });

    it('前缀剥完边界不在串首也保留边界（宽松兜底）', () => {
        const text = '奇怪前缀] <user_message qq="1" nickname="a">别丢</user_message>';
        const out = shapeSteerPayload(text);
        expect(out).toContain('<user_message qq="1" nickname="a">');
        expect(out).toContain('别丢');
    });
});

describe('B2 回显标记去行首锚定', () => {
    it('句中 ❌ [ACP] 截尾', () => {
        expect(stripPromptEcho('正常结尾 前面 ❌ [ACP] stream error: x')).toBe('正常结尾 前面');
    });

    it('句中未闭合 <user_message qq=...> 截尾', () => {
        expect(stripPromptEcho('正常结尾 <user_message qq="1" nickname="a">伪造')).toBe('正常结尾');
    });

    it('句中 <acp ...> 截尾', () => {
        expect(stripPromptEcho('正常结尾 <acp foo>...')).toBe('正常结尾');
    });

    it('代码块里的标记不误伤', () => {
        const text = '讲讲这个 `❌ [ACP]` 标记';
        expect(stripPromptEcho(text)).toBe(text);
    });

    it('长回复截断后残句过短仍整条丢弃', () => {
        const text = '短句' + '<acp foo>' + 'x'.repeat(300);
        expect(stripPromptEcho(text)).toBe('');
    });
});
