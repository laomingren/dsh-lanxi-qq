/**
 * 冒烟测试：出站纯函数（2026-11-03 补，P0-6）。
 * 覆盖 splitParagraphs（分条/分段）与 stripEchoBlocks（输入回显块拦截）。
 */
import { describe, expect, it } from 'vitest';
import { splitParagraphs } from '../lib/outbound.js';
import { stripEchoBlocks, stripPromptEcho } from '../lib/split.js';

describe('splitParagraphs', () => {
    it('单段原样返回一段', () => {
        expect(splitParagraphs('只有一段话')).toEqual(['只有一段话']);
    });

    it('按空行拆成多段并保留顺序', () => {
        const text = '第一段\n\n第二段\n\n第三段';
        expect(splitParagraphs(text)).toEqual(['第一段', '第二段', '第三段']);
    });

    it('恰好 2~12 段才拆；超过 12 段防刷屏保持整条', () => {
        const twelve = Array.from({ length: 12 }, (_, i) => `第${i}段`).join('\n\n');
        expect(splitParagraphs(twelve).length).toBe(12);
        const twenty = Array.from({ length: 20 }, (_, i) => `第${i}段`).join('\n\n');
        expect(splitParagraphs(twenty).length).toBe(1);
        expect(splitParagraphs(twenty)[0]).toContain('第19段');
    });

    it('空文本/纯空白按原文返回单条', () => {
        expect(splitParagraphs('')).toEqual(['']);
        expect(splitParagraphs('\n\n\n').length).toBe(1);
    });
});

describe('stripEchoBlocks', () => {
    it('删掉完整的 <user_message> 回显块，块外正文保留', () => {
        const text = '正常回复在这里\n\n<user_message qq="123" nickname="某人">被回显的输入</user_message>';
        expect(stripEchoBlocks(text)).toBe('正常回复在这里\n\n');
    });

    it('没有回显块时原文不动', () => {
        const text = '普通聊天\n第二行';
        expect(stripEchoBlocks(text)).toBe(text);
    });
});

describe('stripPromptEcho', () => {
    it('命中框架标记时从该行截掉，之前的正文保留', () => {
        const text = '模型先答完\n\n[22:17 某群友(123456)] Hmm.';
        const out = stripPromptEcho(text);
        expect(out).toContain('模型先答完');
        expect(out).not.toContain('Hmm');
    });

    it('纯正文不误伤', () => {
        const text = '今天天气不错';
        expect(stripPromptEcho(text)).toBe(text);
    });
});
