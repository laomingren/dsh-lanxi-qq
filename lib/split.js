/**
 * Outbound text shaping: Markdown stripping for
 * QQ, [[qq_forward]] block parsing, and the sensitive-intent audit.
 * Ported from the Hermes onebot_utils.py split/markdown half.
 * @module dsh-onebot/split
 */
/**
 * Strip Markdown into QQ-friendly plain text. QQ does not render Markdown;
 * headings, emphasis, links, code fences, and tables are flattened. The
 * internal [[qq_forward]] markers are preserved (handled before this runs).
 * @param text - model-produced Markdown text.
 * @returns plain text for QQ.
 */
export function stripMarkdown(text) {
    let out = text
        // Code fences: keep the inner text, drop the fence lines.
        .replace(/\x60\x60\x60[^\n]*\n([\s\S]*?)\x60\x60\x60/g, (_, body) => body + '\n')
        .replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '$1')
        // Inline code: keep content, drop backticks.
        .replace(/\x60([^\x60\n]+)\x60/g, '$1')
        // Headings.
        .replace(/^#{1,6}[ \t]+/gm, '')
        // Emphasis.
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1$2$3')
        .replace(/~~([^~]+)~~/g, '$1')
        // Links and images.
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '[图片]')
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')
        // Blockquote markers.
        .replace(/^[ \t]*>[ \t]?/gm, '')
        // Table rows: keep cell text separated by spaces; drop divider rows.
        .split('\n')
        .map(line => {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|') && !line.includes('\n')) {
            const cells = line.split('|').filter(c => c.trim() !== '');
            if (cells.every(c => /^:?-{2,}:?$/.test(c.trim())))
                return '';
        }
        if (line.trim().startsWith('|')) {
            return line.split('|').map(c => c.trim()).filter(c => c !== '').join(' ');
        }
        return line;
    })
        .filter(line => line !== '')
        .join('\n')
        // Horizontal rules.
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
        // Collapse 3+ blank lines.
        .replace(/\n{3,}/g, '\n\n');
    return out.trim();
}
/** Host/session wrappers that must never reach a chat. */
const INTERNAL_TAGS = ['system-reminder', 'system_reminder', 'user_message'];
/**
 * Strip internal host/session markup that leaks into model-produced text:
 * <system-reminder>…</system-reminder>, <system_reminder>…</system_reminder>
 * and <user_message …>…</user_message> blocks (complete or unclosed tails,
 * attributes allowed), plus '[图片/语音/视频/文件:<local path>]' placeholder
 * lines.
 * @param text - model-produced or relayed text.
 * @returns text with the internal markup removed.
 */
export function stripInternalTags(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    // Inline code and closed fences are literal text. Mask them first so a tag
    // name quoted inside code (e.g. `<user_message>` in a reply about this
    // plugin) is never mistaken for markup — the old unclosed-opener rule would
    // delete everything after it, truncating the whole rest of the message.
    const held = [];
    let out = text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60|\x60[^\x60\n]*\x60/g, (segment) => {
        held.push(segment);
        return '\x00QQCODE' + (held.length - 1) + '\x00';
    });
    for (const name of INTERNAL_TAGS) {
        // A block that owns whole lines takes its line break with it.
        out = out.replace(new RegExp('^[ \\t]*<' + name + '\\b[^>]*>[\\s\\S]*?<\\/' + name + '\\s*>[ \\t]*(?:\\r?\\n|$)', 'gim'), '');
        // Complete blocks first (opening tag may carry attributes).
        out = out.replace(new RegExp('<' + name + '\\b[^>]*>[\\s\\S]*?<\\/' + name + '\\s*>', 'gi'), '');
        // Unclosed opening tag: the rest of the text is internal payload.
        out = out.replace(new RegExp('<' + name + '\\b[^>]*>[\\s\\S]*$', 'gi'), '');
        // Stray openers/closers left over (e.g. closing tag without opener).
        out = out.replace(new RegExp('<\\/?' + name + '\\b[^>]*>', 'gi'), '');
    }
    // '[dsh-…]' markers are host lifecycle notes (e.g. the silent-wake
    // tombstone `[dsh-proactive: silent wake … exchange folded]`). They are
    // never chat content. This runs BEFORE the code-span restore, so a marker
    // quoted inside backticks survives — same protection the XML tags get.
    // A line whose first non-space token is the marker is dropped whole: the
    // real tombstone carries a trailing note after the bracket (… exchange
    // folded / … now <time>), so stopping at the closing bracket leaves a
    // stray tail in the chat.
    out = out.replace(/^[ \t]*\[dsh-[^\r\n]*(?:\r?\n|$)/gim, '');
    out = out.replace(/\[dsh-[^\]\r\n]*\]/gi, '');
    // Restore the literal code spans untouched.
    out = out.replace(/\x00QQCODE(\d+)\x00/g, (_, index) => held[Number(index)] ?? '');
    // '[图片/语音/视频/文件:<local path>]' placeholders: drop the whole line
    // first, then any inline leftovers, so the local media path never leaks
    // into the chat.
    out = out.replace(/^[ \t]*\[(?:图片|语音|视频|文件)[:：][^\]\r\n]*\][ \t]*(?:\r?\n|$)/gm, '');
    out = out.replace(/\[(?:图片|语音|视频|文件)[:：][^\]\r\n]*\]/g, '');
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
/**
 * 输入回显（prompt echo）拦截（2026-11-02 蓝汐补丁）：模型偶尔把喂给它的那一段
 * user message 原样吐进 text 块——群前缀、受限标签、群历史块，后面还接着它的英文
 * 思考过程。这些只属于模型输入，一个字都不该进聊天。
 * 事故样本（2026-11-02 22:17，某群）：群里冒出一条以
 * 「[受限用户:仅问答] [22:17 某群友(<QQ号>)]」开头、后面跟
 * 「Hmm. 某群友 says: …」的消息——stripInternalTags 只吃掉了 <user_message> 边界里
 * 的正文，边界外的框架前缀和回显出来的思考过程全留在外面。
 * 命中任一框架元数据标记就从那一行整段截掉：标记之前若还有正文（模型先答完再
 * 贴输入）保留正文；标记在开头则整条变空串，由调用方按「没有正文」丢弃。
 * 只能靠这些标记判定——回显里的思考过程和普通聊天正文本身无法区分；代码块里的
 * 标记不算（私聊里引用原文讲解时不该被截断）。要在 stripInternalTags 之前调用：
 * 边界包裹整个删掉之后，就看不出这段文本原本是回显了。
 * @param text - 模型产出的原始文本（还没过 stripInternalTags）。
 * @returns 截掉回显尾部的文本。
 */
const PROMPT_ECHO_MARKERS = [
    // 群消息前缀：[HH:MM 昵称(QQ)] / [HH:MM 昵称(QQ)][@我]，后面可以紧跟正文
    /^\[[0-2]\d:[0-5]\d [^\]\r\n]{0,48}\(\d{5,12}\)\](?:\[@我\])?[ \t]*/m,
    // 受限用户软上限标签（只可能由 RESTRICTED_PREFIX 拼出来）
    /^\[受限用户[:：]仅问答\][ \t]*/m,
    // 群历史上下文块标题（formatGroupHistoryBlock 的固定开头）
    /^最近的群聊记录[（(]共 \d+ 条/m,
    // 历史块与当前消息之间的分隔行
    /^当前这条消息：[ \t]*$/m,
    // 私聊那条真的边界开标签（带 qq/nickname 属性的才算；正文里顺口提一句
    // 「<user_message>」不带属性，不会误伤）
    /^[ \t]*<user_message\b[^>\r\n]*\b(?:qq|nickname)="[^"]*"[^>]*>/m,
    // 2026-11-03 蓝汐 P0 补丁：剩下三种「不是聊天内容」的回显形态（报告
    // reports\上下文混淆泄漏全面排查-2026-11-03.md §5.2 定的止血名单）。
    // harness 风格的英文收尾指令：模型把注入的执行框架当成自己的话吐出来。
    /^[ \t]*Now,\s+briefly explain what you just did\b/im,
    // 宿主注入的 <system-reminder> / <system_reminder> 开标签（含属性）。
    /^[ \t]*<system[-_]reminder\b[^>\r\n]*>/im,
    // bili / ACP 压缩插件注入的 <acp …> 标签。
    /^[ \t]*<acp\b[^>\r\n]*>/im,
    // ACP 时间线标记（❌ [ACP] stream error / 📦 [ACP] Compressed / ❌ FAILED）。
    /^[ \t]*(?:❌|📦)\s*\[ACP\]/m,
];
/** 用等长 NUL 遮住代码段：只做判定，索引仍对得上原文。 */
function maskCodeSpans(text) {
    return text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60|\x60[^\x60\n]*\x60/g, seg => seg.replace(/[^\n]/g, '\u0000'));
}
/** 带 qq/nickname 属性的 <user_message> 完整块（回显时才可信，正文里顺口
 * 提一句没有属性的不算）。 */
const USER_ECHO_BLOCK = /<user_message\b[^>]*\b(?:qq|nickname)="[^"]*"[^>]*>[\s\S]*?<\/user_message\s*>/gi;
/** 同上，但只看开标签（判断有没有未闭合的回显块）。 */
const USER_ECHO_OPENER = /<user_message\b[^>]*\b(?:qq|nickname)="[^"]*"[^>]*>/i;
/** 回显尾巴里常见的思维链元叙述（开头或行首）。 */
const REASONING_LINE = /^[ \t]*(?:Hmm[.。,，:：\s]|The user\b|Let me\b|Wait[,.。\s]|他贴出了|我写的是|差异[:：])/im;
/** 只删完整的 <user_message …>…</user_message> 回显块，块外正文原样留下。 */
export function stripEchoBlocks(text) {
    return text.replace(USER_ECHO_BLOCK, '');
}
/** 2026-11-03 蓝汐 P0 补丁：宿主注入的 <system-reminder>…</system-reminder> 与
 * <acp …>…</acp> 完整回显块也只删块，块外正文保留（11-02 04:16 三条回答被
 * 「从第一个标记切到尾」整段切掉，这个教训不能再犯）。 */
function stripFrameworkBlocks(text) {
    const held = [];
    const shielded = text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60|\x60[^\x60\n]*\x60/g, (seg) => {
        held.push(seg);
        return `\u0000QQFW${held.length - 1}\u0000`;
    });
    const cut = shielded
        .replace(/<system[-_]reminder\b[^>]*>[\s\S]*?<\/system[-_]reminder\s*>/gi, '')
        .replace(/<acp\b[^>]*>[\s\S]*?<\/acp\s*>/gi, '');
    if (cut === shielded)
        return text;
    return cut.replace(/\u0000QQFW(\d+)\u0000/g, (_, index) => held[Number(index)] ?? '');
}
/** 未闭合的 <user_message …> 开标签：从它起到结尾都算模型输入（与
 * stripInternalTags 的 unclosed 规则一致），直接砍掉。后面其实有闭合就把
 * 它留给 stripEchoBlocks。 */
function cutUnclosedEcho(text) {
    const open = USER_ECHO_OPENER.exec(text);
    if (open === null)
        return text;
    const rest = text.slice(open.index + open[0].length);
    if (/<\/user_message\s*>/i.test(rest))
        return text;
    return text.slice(0, open.index);
}
/** 其余框架标记（群前缀、受限标签、群历史标题、「当前这条消息：」）：从最早
 * 出现的那一行截到尾。 */
function cutFrameworkTail(text) {
    const masked = maskCodeSpans(text);
    let cut = -1;
    for (const re of PROMPT_ECHO_MARKERS) {
        const found = re.exec(masked);
        if (found !== null && (cut < 0 || found.index < cut))
            cut = found.index;
    }
    if (cut < 0)
        return text;
    return text.slice(0, cut).trim();
}
/** 正文后面粘着的思维链尾巴（「他贴出了…」「Hmm. …」）从第一处切开。 */
function cutReasoningTail(text) {
    const found = REASONING_LINE.exec(text);
    if (found === null || found.index === 0)
        return text;
    return text.slice(0, found.index).trim();
}
export function stripPromptEcho(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    const masked = maskCodeSpans(text);
    let hit = -1;
    for (const re of PROMPT_ECHO_MARKERS) {
        const found = re.exec(masked);
        if (found !== null && (hit < 0 || found.index < hit))
            hit = found.index;
    }
    if (hit < 0)
        return text;
    // 2026-11-03 蓝汐补丁：不再「从第一个标记切到结尾」——那样会把写在回显块
    // 之后的正文一起切掉（11-02 04:16 三条回答就是这么没的）。改成只删回显块，
    // 块外的正文留着；删完只剩思维链或零头就不发，免得蹦出一句残句。
    let out = stripEchoBlocks(text);
    out = stripFrameworkBlocks(out);
    const beforeUnclosed = out;
    out = cutUnclosedEcho(out);
    const cutOpen = out !== beforeUnclosed;
    const beforeTail = out;
    out = cutFrameworkTail(out).trim();
    // 只有真从尾巴砍掉东西才算「截断」；只删回显块时正文是完整的，不该按残句丢掉。
    const truncated = cutOpen || out !== beforeTail.trim();
    if (out === '')
        return '';
    if (REASONING_LINE.test(out) && REASONING_LINE.exec(out)?.index === 0)
        return '';
    out = cutReasoningTail(out);
    if (out === '')
        return '';
    const before = text.trim().length;
    const after = out.length;
    // 砍太狠就别发残句：长回复只剩零头，宁可整条不发（调用方按「整条回显」丢弃）。
    if (truncated && before >= 200 && after < 80)
        return '';
    if (truncated && before >= 80 && after < 20)
        return '';
    return out;
}
/**
 * Remove one <user_message …>…</user_message> wrapper while keeping its body
 * (the steer path needs the bare text, not the boundary tags).
 * @param text - possibly wrapped inbound text.
 * @returns the inner text, or the text with stray boundary tags removed.
 */
export function unwrapUserMessage(text) {
    const whole = /^\s*<user_message\b[^>]*>([\s\S]*)<\/user_message\s*>\s*$/i.exec(text);
    if (whole !== null)
        return whole[1].trim();
    return text.replace(/<\/?user_message\b[^>]*>/gi, '').trim();
}
/** The host's time-context injection starts with this line; it is model
 * context, never part of a chat reply. */
const SYSTEM_CONTEXT_LINE = /^[ \t]*Time sampled while preparing\b/i;
/**
 * Drop host system context that leaked into model-produced text. The time
 * reading is appended after the user's message, so a text block that echoes
 * it carries context (often followed by the reasoning spill) — the marker
 * line and everything after it in that block are not visible body text.
 * @param text - model-produced or relayed text.
 * @returns text with the system-context tail removed.
 */
export function stripSystemContext(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        if (SYSTEM_CONTEXT_LINE.test(lines[i]))
            return lines.slice(0, i).join('\n');
    }
    return text;
}
/**
 * The visible body of one assistant message: text blocks only. Reasoning /
 * thinking / tool-call blocks are never chat text, and the system-context
 * fallback above removes any time-context line that slipped into a text block.
 * @param message - the assistant message from an `assistant/message` event.
 * @returns the visible text, or '' when the message carries none.
 */
export function visibleAssistantText(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    let out = '';
    for (const block of content) {
        if (block === null || typeof block !== 'object')
            continue;
        if (block.type !== 'text')
            continue;
        // Defensive: a provider may tag a text block as reasoning.
        if (block.reasoning === true || block.thinking === true)
            continue;
        if (typeof block.text !== 'string')
            continue;
        // Per block: only the block that echoed the system context loses its
        // tail; a later visible text block is untouched.
        out += stripSystemContext(block.text);
    }
    return out;
}
/** The [[qq_forward]] marker regex (imported from cq.ts for single sourcing). */
import { FORWARD_BLOCK_RE } from './cq.js';
export { FORWARD_BLOCK_RE };
/** Explicit sender-name markers for a [[qq_forward]] block's first line:
 * `name:` / `name：` (colon form — the text before the first colon is the
 * name) or a `[name]` tag (bracket form — the tag's inner text is the name).
 * A bare first line is body text, never a name: the old "short line without
 * a colon" heuristic ate the block's first content line as the sender name
 * (sat-a #9). */
const FORWARD_NAME_MARK_RE = /^(?:\[([^[\]\r\n]{1,24})\]|([^:：\r\n]{1,24})[:：])/;
/**
 * Extract [[qq_forward]] blocks from reply text. The blocks are removed from
 * the returned body text; a block whose first line carries an explicit name
 * marker (colon or [tag]) splits name from content, everything else keeps
 * its whole text as content and defaults the sender name.
 * @param text - the reply text (before Markdown stripping).
 * @param defaultName - node name when the block omits one.
 * @returns body text without blocks, plus the parsed nodes.
 */
export function extractForwardBlocks(text, defaultName) {
    const nodes = [];
    const body = text.replace(FORWARD_BLOCK_RE, (_, block) => {
        const trimmed = block.trim();
        if (trimmed === '')
            return '';
        const lines = trimmed.split('\n');
        const first = lines[0].trim();
        let name = defaultName;
        let content = trimmed;
        // First line is a sender name ONLY when explicitly marked; otherwise
        // it stays body text (no more short-line guessing).
        const marked = FORWARD_NAME_MARK_RE.exec(first);
        if (marked !== null) {
            const markedName = (marked[1] ?? marked[2]).trim();
            if (markedName !== '') {
                name = markedName;
                const rest = first.slice(marked[0].length).replace(/^[ \t]*[:：][ \t]*/, '');
                content = (rest + '\n' + lines.slice(1).join('\n')).trim();
            }
        }
        if (content !== '')
            nodes.push({ name, content });
        return '';
    });
    return { body, nodes };
}
/** Sensitive-intent audit: log a WARNING when outbound text matches. */
const DEFAULT_SENSITIVE_PATTERNS = [
    /(?:rm\s+-rf|format\s+[a-z]:|diskpart|mkfs\.)/i,
    /(?:shutdown|reboot|poweroff|init\s+0)/i,
    /(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)/i,
    /(?:sk-|ghp_|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/i,
];
/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export function scanSensitive(text, patterns) {
    const list = patterns.length > 0 ? patterns : DEFAULT_SENSITIVE_PATTERNS;
    const hits = [];
    for (const p of list) {
        const re = p instanceof RegExp ? p : new RegExp(p, 'i');
        if (re.test(text))
            hits.push(String(p));
    }
    return hits;
}
