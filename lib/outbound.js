/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue. 2026-11-02 P0 改造：断线排队从「内存 per-chat FIFO（cap 20 /
 * TTL 5 分钟 / 超了丢最旧）」升级为持久 Outbox（lib/outbox.js：JSONL 落盘 +
 * at-least-once + 幂等键 + 重启续投 + 失败离队）；durableOutbox=false 时
 * 走旧内存队列，行为与改造前逐字节一致。
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { extractForwardBlocks, scanSensitive, stripInternalTags, stripMarkdown, stripPromptEcho, stripSystemContext } from './split.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { TRACE_REASONS } from './trace.js';
import { DurableOutbox } from './outbox.js';
/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20;
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/**
 * 群聊自动静默（2026-10-28 蓝汐补丁）：群消息发送成功后，若文本命中第一人称
 * 晚安类关键词，就算出下一个北京时间出场点，原子写状态文件（先 .tmp 再
 * rename）。inbound.js 读同一个文件决定整群静默与管理员唤醒。
 */
const GROUP_SILENT_FILE = join(homedir(), '.dsh', 'onebot-group-silent.json');
const GROUP_SILENT_TMP = GROUP_SILENT_FILE + '.tmp';
const DEFAULT_SILENCE_KEYWORDS = ['晚安', '我去睡', '我去躺', '下线了', '睡了睡了'];
const DEFAULT_SILENCE_RELEASE_TIMES = ['12:10', '18:10'];
/**
 * 静默打卡句过滤（2026-10-28 蓝汐补丁，管理员点头的窄版本）：只吃「整条消息
 * 就是一句括号里的自我交代」且带这些状态词的情况，比如「（本轮无话要跟你说，
 * 回屋待着。）」。正常聊天里的括号玩笑、正经括号补充一律不拦。
 */
const SILENT_STATUS_KEYWORDS = ['本轮', '这一轮', '这轮', '静默', '安静待', '先不接', '不接了', '先不回', '不回话', '不发言', '不出声', '空回合', '没新消息', '摘要', '不发消息', '不打扰', '按规则', '无需回话', '已更新', '回屋待着', '不冒泡', '不折腾', '先等', '存档', '停在这', '停在这里', '不加消息', '不再附加', '无需更新', '无新消息', '没有新消息', '暂无更新', '安静看', '插不上', '不说话', '不插嘴', '只看着', '观望', '围观', '没我事', '没我的事'];
export function isSilentStatusOnlyMessage(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '' || trimmed.length > 80)
        return false;
    if (!/^[（(][\s\S]*[）)]$/.test(trimmed))
        return false;
    return SILENT_STATUS_KEYWORDS.some((kw) => trimmed.includes(kw));
}
/**
 * 静默轮汇报句过滤（2026-10-29 蓝汐补丁，管理员抓包）：跨窗摘要/备份检查这类
 * 定时活在「两边都没新消息」时本该一个字符都不吐，模型却常憋出一句汇报体，
 * 比如「无新消息，无需更新。」——它不是括号句，逃过了上面那道窄筛子，于是
 * 真发到了群里。这里只吃「整条就是一个纯汇报语」的短句，正常聊天不受影响。
 */
const SILENT_REPORT_PATTERNS = [
    /^(无|没有|暂无)?新消息[，,。.！!\s]*(无需|不用|不需要)?(更新|同步)?[。.！!]?$/u,
    /^(无|没有|暂无)(新)?消息[，,。.！!\s]+(无需|不用|不需要)(更新|同步)[。.！!]?$/u,
    /^(无需|不用|不需要)(更新|同步)[。.！!]?$/u,
    /^(跨窗闲话|摘要|记忆|日记|备份)(已|无)(更新|变化|新内容|完成)[。.！!]?$/u,
    /^(这轮|本轮|这一轮|这一回合)[\s\S]{0,12}(完[了成]?|结束|就这样|先这样|不动|先不动)[。.！!]?$/u,
    /^(这轮|本轮|这一轮|这一回合)[\s\S]{0,10}(没有|无)(新)?(内容|话说|消息)[。.！!]?$/u,
];
export function isSilentReportOnlyMessage(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '' || trimmed.length > 40)
        return false;
    return SILENT_REPORT_PATTERNS.some((re) => re.test(trimmed));
}
/**
 * 占位符过滤（2026-10-28 蓝汐补丁）：模型偶尔把「这轮没话说」写成一个占位符
 * 再发出去——真实事故是群里的我输出了字面量「[空]」，群里因此冒出两个空气泡。
 * 所以整条只有一个括起来的占位词时直接吞掉，不进发送队列。
 */
const PLACEHOLDER_TOKENS = ['空', '无', '略', '省略', '沉默', '暂无', '没话说', '待补', '同上', 'silent', '静默'];
export function isPlaceholderOnlyMessage(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '' || trimmed.length > 20)
        return false;
    if (!/^[[【（(〔][\s\S]*[\]】）)〕]$/u.test(trimmed))
        return false;
    const core = trimmed.replace(/[[\]【】（）()〔〕{}〈〉《》\s]/gu, '');
    return core !== '' && PLACEHOLDER_TOKENS.includes(core);
}
/**
 * 按空行把正文拆成多条消息（2026-10-28 蓝汐补丁，管理员点头）：模型回复里
 * 用空行分段，每一段单独发一条，贴近真人聊天节奏。只有能拆出 2~12 段时才
 * 拆；单段、空文本、或段数过多（像报告/清单）都保持整条发送，避免刷屏。
 */
const MAX_PARAGRAPH_PARTS = 12;
export function splitParagraphs(text) {
    const whole = String(text ?? '');
    if (whole.trim() === '')
        return [whole];
    const parts = whole.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length < 2 || parts.length > MAX_PARAGRAPH_PARTS)
        return [whole.trim()];
    return parts;
}
/** 数直钳制：坏配置回退默认值，合法值夹在 [min,max]。 */
function clampBubbleNumber(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
/**
 * bubble* 九键归一化（2026-11-05 A2）：schema 允许任意数字，运行时必须钳住，
 * 否则 maxMessages=0 会把整条回复吞掉、gapMin>gapMax 会算出负间隔。
 */
export function normalizeBubbleConfig(config = {}) {
    const maxMessages = Math.round(clampBubbleNumber(config.bubbleMaxMessages, 4, 1, 12));
    const maxChars = Math.round(clampBubbleNumber(config.bubbleMaxChars, 120, 1, 10000));
    let gapMin = Math.round(clampBubbleNumber(config.bubbleGapMinMs, 800, 0, 600_000));
    let gapMax = Math.round(clampBubbleNumber(config.bubbleGapMaxMs, 2500, 0, 600_000));
    if (gapMin > gapMax)
        [gapMin, gapMax] = [gapMax, gapMin];
    let longGapMin = Math.round(clampBubbleNumber(config.bubbleLongGapMinMs, 4000, 0, 600_000));
    let longGapMax = Math.round(clampBubbleNumber(config.bubbleLongGapMaxMs, 8000, 0, 600_000));
    if (longGapMin > longGapMax)
        [longGapMin, longGapMax] = [longGapMax, longGapMin];
    const longGapProbability = clampBubbleNumber(config.bubbleLongGapProbability, 0.2, 0, 1);
    const onlyChats = Array.isArray(config.bubbleOnlyChats)
        ? config.bubbleOnlyChats.filter((chatId) => typeof chatId === 'string' && chatId !== '')
        : [];
    return { maxMessages, maxChars, gapMin, gapMax, longGapMin, longGapMax, longGapProbability, onlyChats };
}
/**
 * 分条发送的真正接线（2026-11-05 A2）：bubbleSplit=false → 整条一条；
 * bubbleOnlyChats 过滤；按空行分段后先按 maxChars 合并短段（超长整句不硬切），
 * 再按 maxMessages 把溢出段合并进末段。返回至少要发出去的文本数组。
 */
export function splitForBubbles(text, chatId, config = {}) {
    const whole = String(text ?? '');
    if (whole.trim() === '')
        return [whole];
    if (config.bubbleSplit !== true)
        return [whole.trim()];
    const settings = normalizeBubbleConfig(config);
    if (settings.onlyChats.length > 0 && !settings.onlyChats.includes(chatId))
        return [whole.trim()];
    const paragraphs = whole.split(/\n[ \t]*\n+/).map((part) => part.trim()).filter((part) => part !== '');
    if (paragraphs.length === 0)
        return [whole.trim()];
    // 段数没超上限就按段发（3 段回复 → 3 条气泡，符合「分条」直觉）；
    // 只有段数超过 bubbleMaxMessages 时才需要打包：先按 maxChars 合并相邻
    // 短段（超长整句不硬切，单独成段），再把溢出段并入末段。
    if (paragraphs.length <= settings.maxMessages)
        return paragraphs;
    const merged = [];
    for (const part of paragraphs) {
        if (merged.length === 0) {
            merged.push(part);
            continue;
        }
        const last = merged[merged.length - 1];
        if (last.length + 1 + part.length <= settings.maxChars) {
            merged[merged.length - 1] = last + '\n' + part;
        }
        else {
            merged.push(part);
        }
    }
    if (merged.length > settings.maxMessages) {
        const head = merged.slice(0, settings.maxMessages - 1);
        const tail = merged.slice(settings.maxMessages - 1).join('\n');
        merged.length = 0;
        merged.push(...head, tail);
    }
    return merged;
}
/** 相邻两条气泡之间的等待：普通间隔 + 按概率抽长停顿（0~1 钳制在前）。 */
export function bubbleDelayMs(config = {}, random = Math.random) {
    const settings = normalizeBubbleConfig(config);
    const long = settings.longGapProbability > 0 && random() < settings.longGapProbability;
    const min = long ? settings.longGapMin : settings.gapMin;
    const max = long ? settings.longGapMax : settings.gapMax;
    return min + Math.round(random() * Math.max(0, max - min));
}
/** 北京时间 HH:MM → 当日分钟数；非法/空返回 null。 */
function parseBeijingClock(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
    if (m === null)
        return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59)
        return null;
    return hour * 60 + minute;
}
/**
 * 下一个出场点（epoch ms）：groupSilenceReleaseTimes 里最近的未来北京时间时刻；
 * 今天已过（严格 <= now 才算过）就顺延到明天，多个时刻取最早。列表全非法 → null。
 */
function nextBeijingReleaseAt(times, nowMs) {
    const list = Array.isArray(times) && times.length > 0 ? times : DEFAULT_SILENCE_RELEASE_TIMES;
    const bj = new Date(nowMs + 8 * 3600 * 1000);
    const dayStartUtc = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600 * 1000;
    let next = null;
    for (const raw of list) {
        const minutes = parseBeijingClock(raw);
        if (minutes === null)
            continue;
        let at = dayStartUtc + minutes * 60_000;
        if (at <= nowMs)
            at += 24 * 3600 * 1000;
        if (next === null || at < next)
            next = at;
    }
    return next;
}
/** 转述别人说的话不算（"你说晚安""他说我去睡了"）：关键词前一个字若落在
 * 这些字符里就跳过该分句——只认第一人称。 */
const NON_FIRST_PERSON_CHARS = new Set(['你', '他', '她', '它', '谁', '哥', '姐', '妈', '爸', '说', '道', '句']);
/**
 * 第一人称晚安类关键词匹配：按句读切分，关键词必须出现在分句开头 6 字以内，
 * 且前一个字不是第二/第三人称或"说/道/句"。命中返回关键词，否则 null。
 */
function matchSilenceKeyword(text, keywords) {
    const flat = String(text ?? '').replace(/[\s\u3000]+/g, ' ').trim();
    if (flat === '')
        return null;
    const list = Array.isArray(keywords) && keywords.length > 0 ? keywords : DEFAULT_SILENCE_KEYWORDS;
    for (const raw of list) {
        const keyword = String(raw ?? '').trim();
        if (keyword === '')
            continue;
        for (const clause of flat.split(/[。！？!?，,；;、\n]+/)) {
            const c = clause.trim().replace(/^[~～…\.\s]+/, '');
            const idx = c.indexOf(keyword);
            if (idx < 0 || idx > 6)
                continue;
            if (idx > 0 && NON_FIRST_PERSON_CHARS.has(c[idx - 1]))
                continue;
            return keyword;
        }
    }
    return null;
}
/** 原始 segment 发送（qq_send_group_msg 等工具路径）里的文本部分。 */
function segmentsText(segments) {
    if (!Array.isArray(segments))
        return '';
    return segments
        .map(seg => seg?.type === 'text' ? String(seg.data?.text ?? '') : '')
        .join('\n')
        .trim();
}
/** 串行写队列：并发命中时不会有两个写者抢同一个 .tmp。 */
let groupSilentWriteChain = Promise.resolve();
/** 原子落盘状态文件：mkdir → 写 .tmp → rename；任何失败只 warn，不影响发送。 */
function writeGroupSilence(untilMs, reason, log) {
    const stamp = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
    const payload = JSON.stringify({
        until: stamp(untilMs),
        reason,
        setAt: stamp(Date.now()),
    }, null, 2) + '\n';
    groupSilentWriteChain = groupSilentWriteChain.then(async () => {
        await mkdir(join(homedir(), '.dsh'), { recursive: true });
        await writeFile(GROUP_SILENT_TMP, payload, 'utf8');
        await rename(GROUP_SILENT_TMP, GROUP_SILENT_FILE);
        log('info', 'group auto-silence armed: until=' + stamp(untilMs) + ' reason=' + reason);
    }).catch((error) => {
        log('warn', 'group auto-silence persist failed: ' + describeError(error));
    });
    return groupSilentWriteChain;
}
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). durableOutbox 关闭时的旧路径；开启时
     * 排队走 this.outbox（落盘），本 Map 不再使用。 */
    pendingSends = new Map();
    /** 2026-11-02 P0：持久 Outbox（durableOutbox=true 且配了 mediaDir 时建）。 */
    outbox;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
        this.outbox = this.buildOutbox();
    }
    /** 建持久 Outbox：durableOutbox !== false（默认开）且有 mediaDir 才建；
     *  建好立即 Kick off load()——断线排队可能比加载更快到来（启动即断线
     *  的场景），load() 的合并逻辑保证内存条目不丢。 */
    buildOutbox() {
        const config = this.ctx.config;
        if (config?.durableOutbox === false)
            return undefined;
        const dir = config?.mediaDir;
        if (typeof dir !== 'string' || dir === '') {
            this.ctx.log('warn', 'durableOutbox 已开启但未配置 mediaDir，回退为内存离线队列');
            return undefined;
        }
        const outbox = new DurableOutbox({
            dir,
            log: (level, message) => this.ctx.log(level, message),
            now: () => this.now(),
            maxEntries: config.outboxMaxEntries,
            maxAttempts: config.outboxMaxAttempts,
        });
        void outbox.load().catch(() => undefined);
        return outbox;
    }
    /** 待补发条数（/status 与设置页徽标同源；0 = 队列空）。 */
    outboxStats() {
        return this.outbox?.getStats() ?? { enabled: false, pending: 0, failed: 0, sent: 0, dropped: 0, deduped: 0 };
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
        return this.enqueue(chatId, async () => {
            // Internal host/session markup (system reminders, user_message
            // wrappers, [图片:…] placeholders) must never reach QQ: strip it
            // here, before the queue park and any downstream shaping, so every
            // caller (final replies, interim.js, deferred.js, commands) shares
            // the same cleaned text. The time-context fallback runs here too so
            // no send path can leak a `Time sampled while preparing` line.
            // 2026-11-02 蓝汐补丁：模型把喂给它的上下文原样吐回来时（群前缀 +
            // 群历史块 + 思考过程），stripInternalTags 只吃得掉 <user_message>
            // 边界内的正文，边界外的前缀和回显出来的思考过程会漏到群里——这里
            // 先截掉回显（必须在 stripInternalTags 之前，否则看不出那是回显）。
            const unEchoed = stripPromptEcho(text);
            if (unEchoed !== text) {
                this.ctx.log('warn', '出站文本里发现模型回显的输入上下文（prompt echo），已截掉: ' + chatId
                    + '（' + text.length + ' → ' + unEchoed.length + ' 字）');
                this.ctx.trace?.(chatId, {
                    stage: 'outbound', ok: true, reason: '已截掉模型回显的输入上下文',
                    data: { before: text.length, after: unEchoed.length },
                });
            }
            if (unEchoed.trim() === '' && text.trim() !== '') {
                // 整条都是回显（模型只把输入贴了回来，没有正文）：一个字都不发。
                this.ctx.log('warn', '整条回复都是输入回显，已丢弃: ' + chatId);
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEchoOnly });
                this.ctx.events?.record({ direction: 'out', chatId, kind: 'text', ok: false, reason: TRACE_REASONS.outboundEchoOnly });
                return [];
            }
            const clean = stripSystemContext(stripInternalTags(unEchoed));
            if (isSilentStatusOnlyMessage(clean)) {
                this.ctx.log('debug', '静默打卡句已拦下，不发送: ' + chatId);
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '静默打卡句已拦下', data: { length: clean.length } });
                return [];
            }
            if (isSilentReportOnlyMessage(clean)) {
                this.ctx.log('debug', '静默轮汇报句已拦下，不发送: ' + chatId);
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '静默轮汇报句已拦下', data: { length: clean.length } });
                return [];
            }
            // dryRun 例外：试运行的承诺是「没有 NapCat 也能完整试跑」，被动回复
            // 必须放行到 connection.call() 的 dryRun 拦截层（那里才写日志），
            // 不能在这里被连通性门拦下、转去等一个永远不会来的重连。
            if (!this.ctx.connected() && this.ctx.config.dryRun !== true) {
                if (options.queuable === true) {
                    // pipeline-hooks.md #23: the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, clean, options.outboxId);
                    // P0：排队也是一次「未送达」——进事件时间线（不记正文）。
                    this.ctx.events?.record({ direction: 'out', chatId, kind: 'text', ok: false, reason: TRACE_REASONS.outboundQueued });
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                this.ctx.events?.record({ direction: 'out', chatId, kind: 'text', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(clean, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            const { body, nodes } = extractForwardBlocks(clean, '助手');
            if (nodes.length > 0) {
                // Passive reply path: [[qq_forward]] blocks inside a turn reply are
                // NOT gated as proactive writes (see the W2-③ 口径 note).
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            const threshold = this.ctx.config.textImageThreshold;
            if (threshold > 0 && body.length > threshold) {
                try {
                    const chat = this.ctx.getChat(chatId);
                    const title = chat !== undefined && chat.lastNickname !== ''
                        ? 'To ' + chat.lastNickname
                        : undefined;
                    const png = renderTextImage(body, {
                        title,
                        footerBrand: this.ctx.config.cardFooter,
                        fontFiles: this.ctx.config.fontFiles,
                        fontFamilies: this.ctx.config.fontFamilies,
                    });
                    const b64 = 'base64://' + png.toString('base64');
                    if (b64.length <= this.ctx.config.maxImageBytes) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                        sentCard = true;
                    }
                    else {
                        this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                }
            }
            if (!sentCard) {
                // A2（2026-11-05）：bubbleSplit 真正接线。先分段再 stripMarkdown
                // （后者会把空行全删掉，拆完再清洗，否则永远只有一段）。关闭
                // bubbleSplit 时 splitForBubbles 返回整条，行为回到「一条发完」。
                const generation = this.bubbleGeneration;
                const parts = splitForBubbles(body, chatId, this.ctx.config)
                    .map((part) => stripMarkdown(part))
                    .filter((part) => part !== '' && !isPlaceholderOnlyMessage(part));
                if (parts.length > 0) {
                    for (let i = 0; i < parts.length; i += 1) {
                        if (i > 0) {
                            if (generation !== this.bubbleGeneration || this.ctx.isStopping()) {
                                this.ctx.log('debug', '分条发送已中止（插件已停止）: ' + chatId);
                                break;
                            }
                            const wait = bubbleDelayMs(this.ctx.config);
                            if (!(await this.waitBubbles(wait, generation))) {
                                this.ctx.log('debug', '分条发送已中止（等待被取消）: ' + chatId);
                                break;
                            }
                        }
                        const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: parts[i] } }], options);
                        if (id !== undefined)
                            ids.push(id);
                    }
                }
                else {
                    // pipeline-hooks.md #30: the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            // 群聊自动静默（2026-10-28 蓝汐补丁）：这是群文本发送成功的收口点
            // （最终回复/interim/deferred/命令提示都经过 sendToChat，且必须真的
            // 发出至少一条消息）。命中第一人称晚安类关键词时，按北京时间算出
            // 下一个出场点并原子落盘；groupAutoSilence 默认 false = 完全不启用。
            this.armGroupSilence(chatId, body, ids.length > 0);
            const dryRun = this.ctx.config.dryRun === true;
            const sentReason = dryRun ? '回复已模拟发送（dryRun）' : '回复已发送';
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: sentReason, data: { segments: ids.length } });
            // P0：出站成功也进时间线（kind 区分文字图卡片/合并转发/文本）。
            this.ctx.events?.record({
                direction: 'out',
                chatId,
                kind: ids.includes('forward') ? 'forward' : sentCard ? 'card' : 'text',
                ok: true,
                reason: sentReason,
                messageId: ids.find((id) => id !== 'forward'),
            });
            return ids;
        });
    }
    /** 群文本发送成功后按需布置自动静默（2026-10-28 蓝汐补丁）。发送失败/没发出
     * 任何消息、非群聊、开关关闭都直接跳过；匹配与出场点算法见模块顶部。 */
    armGroupSilence(chatId, text, sent) {
        // 试运行不改变真实状态：模拟发送不算「我说话了」，绝不布置群自动静默。
        if (this.ctx.config.dryRun === true)
            return;
        if (!sent || this.ctx.config.groupAutoSilence !== true
            || splitChatId(chatId).kind !== 'group')
            return;
        const keyword = matchSilenceKeyword(text, this.ctx.config.groupSilenceKeywords);
        if (keyword === null)
            return;
        const until = nextBeijingReleaseAt(this.ctx.config.groupSilenceReleaseTimes, this.now());
        if (until === null) {
            this.ctx.log('warn', 'group auto-silence skipped: groupSilenceReleaseTimes 无有效时刻');
            return;
        }
        void writeGroupSilence(until, '命中关键词「' + keyword + '」', (level, message) => this.ctx.log(level, message));
    }
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap.
     *  2026-11-02 P0：durableOutbox 开启时改走落盘队列（幂等键 outboxId 可选，
     *  补发瞬间又断线的重投带原 id 回来，保序且不重复入队）；关闭时保持旧
     *  内存行为不变。 */
    queuePendingSend(chatId, text, outboxId) {
        // dryRun 的模拟发送没有「等重连补发」的语义：入队只会在关闭 dryRun、
        // 恢复连接后被当成真消息补发出去。直接丢掉，不落盘也不占内存。
        if (this.ctx.config.dryRun === true) {
            this.ctx.log('debug', 'dryRun 打开，模拟发送不进入断线补发队列: ' + chatId);
            return;
        }
        if (this.outbox !== undefined) {
            // 补发中又断线：同 id 回队（requeue），而不是当新消息再入一次。
            if (outboxId !== undefined && this.outbox.requeue(outboxId)) {
                this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                return;
            }
            const result = this.outbox.enqueue(chatId, text, outboxId !== undefined ? { id: outboxId } : {});
            if (result.dropped !== undefined) {
                // 总上限挤掉最旧一条：warn + trace + 给被挤掉的 chat 补一条说明
                // （承 #3 sat-a：队列丢弃不静默）。
                const victim = result.dropped;
                this.ctx.log('warn', 'pending send outbox full (maxEntries=' + (this.ctx.config.outboxMaxEntries ?? '?') + '), dropped oldest for ' + victim.chatId);
                this.ctx.trace?.(victim.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
                this.ctx.events?.record({ direction: 'out', chatId: victim.chatId, kind: 'text', ok: false, reason: TRACE_REASONS.queueFull });
                const notice = '⚠️ 断线期间排队的回复太多（超过 ' + (this.ctx.config.outboxMaxEntries ?? '上限') + ' 条），有 ' + 1 + ' 条最早的排队回复被丢弃，未能补发；如需要结果请重新发送消息。';
                void this.sendToChat(victim.chatId, notice, { queuable: true }).catch(() => undefined);
            }
            this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
            return;
        }
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, sentAt: this.now() });
        this.pendingSends.set(chatId, queue);
    }
    // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
    // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
    // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
    // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
    // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
    // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
    // 约束。两类计数都是全桥合计（不分会话）。
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    writeActionTimes = [];
    /** Calendar-day (local) counter of allowed proactive writes. */
    writeDayKey = '';
    writeDayCount = 0;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats() {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        const now = this.now();
        const minuteUsed = perMinute > 0
            ? this.writeActionTimes.filter(t => now - t < 60_000).length
            : 0;
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0;
        return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay };
    }
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    writeGateRejectReason(chatId, action) {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        if (perMinute <= 0 && perDay <= 0)
            return null;
        const now = this.now();
        this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000);
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (this.writeDayKey !== dayKey) {
            this.writeDayKey = dayKey;
            this.writeDayCount = 0;
        }
        if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
            const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        if (perDay > 0 && this.writeDayCount >= perDay) {
            const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        this.writeActionTimes.push(now);
        this.writeDayCount += 1;
        return null;
    }
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start).
     *  2026-11-02 P0：durableOutbox 开启时从落盘队列补发（at-least-once：
     *  重启后 load() 重建的条目也在这里投出去；补发瞬间又断线 → 同 id 回队；
     *  连续失败 outboxMaxAttempts 次 → 移入 failed 队列进 /doctor 诊断包）。 */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        if (this.outbox !== undefined) {
            void this.drainDurableOutbox();
            return;
        }
        const now = this.now();
        const batch = [];
        const dropped = new Map();
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text });
                }
                else {
                    // pipeline-hooks.md #25: the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                    dropped.set(chatId, (dropped.get(chatId) ?? 0) + 1);
                }
            }
        }
        for (const { chatId, text } of batch) {
            void this.sendToChat(chatId, text, { queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
        // #3（sat-a）：TTL 丢弃不再只写 debug/trace——给 chat 补一条简短说明，
        // 避免「回复莫名少了」零感知。可排队：重连瞬间可能再次断连，借 B6 续投；
        // 每 chat 聚合一条，跟在重投批次之后（同一 send chain 保序）。
        for (const [chatId, count] of dropped) {
            const notice = '⚠️ 断线期间排队的回复中有 ' + count + ' 条超过 5 分钟未能补发，已丢弃；如需要结果请重新发送消息。';
            void this.sendToChat(chatId, notice, { queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued drop notice failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队丢弃通知发送失败: ' + describeError(error) });
            });
        }
    }
    /** P0：持久 Outbox 的补发。先确保 load()（重启后首次补发要重建队列），
     *  再按全局 FIFO 逐条投递；TTL（outboxTtlMs，默认 0=不过期）过期条目
     *  丢弃并通知。ack 判定：sendToChat 返回后条目仍在 inFlight = 真发成功
     *  （被静默过滤/空正文也算处理完，ack 掉不再重试）；已被 queuable 门
     *  requeue 回 pending = 又断线了，等下一轮。抛错 = 真发送失败，进
     *  fail() 计 attempts。 */
    async drainDurableOutbox() {
        const outbox = this.outbox;
        if (outbox === undefined)
            return;
        try {
            await outbox.load();
        }
        catch {
            return;
        }
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const ttlMs = this.ctx.config.outboxTtlMs ?? 0;
        const simulated = this.ctx.config.dryRun === true;
        const batch = outbox.due();
        const droppedByChat = new Map();
        for (const entry of batch) {
            if (ttlMs > 0 && now - entry.queuedAt >= ttlMs) {
                outbox.drop(entry.id, 'ttl expired');
                droppedByChat.set(entry.chatId, (droppedByChat.get(entry.chatId) ?? 0) + 1);
                this.ctx.log('debug', '持久队列回复超过 TTL 未送达，已丢弃: ' + entry.chatId);
                this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                this.ctx.events?.record({ direction: 'out', chatId: entry.chatId, kind: 'text', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                continue;
            }
            try {
                await this.sendToChat(entry.chatId, entry.text, { queuable: true, outboxId: entry.id });
                if (outbox.inFlight.has(entry.id)) {
                    outbox.ack(entry.id);
                    this.ctx.events?.record({
                        direction: 'out',
                        chatId: entry.chatId,
                        kind: 'text',
                        ok: true,
                        reason: simulated ? '断线补发已模拟发送（dryRun）' : '断线补发已送达',
                    });
                }
                //  else：又断线了，条目已被 queuable 门 requeue 回队列，等下一轮
            }
            catch (error) {
                const detail = describeError(error);
                const outcome = outbox.fail(entry.id, detail);
                this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + detail });
                this.ctx.events?.record({
                    direction: 'out',
                    chatId: entry.chatId,
                    kind: 'text',
                    ok: false,
                    reason: outcome === 'failed'
                        ? '补发连续失败，已移入 failed 队列: ' + detail
                        : '排队回复补发失败: ' + detail,
                });
                this.ctx.log('warn', 'queued resend failed (' + outcome + '): ' + detail);
            }
        }
        // TTL 丢弃通知（承 #3 sat-a：不静默）；每 chat 聚合一条。
        for (const [chatId, count] of droppedByChat) {
            const minutes = Math.round((this.ctx.config.outboxTtlMs ?? 0) / 60_000);
            const notice = '⚠️ 断线期间排队的回复中有 ' + count + ' 条超过 ' + minutes + ' 分钟未能补发，已丢弃；如需要结果请重新发送消息。';
            void this.sendToChat(chatId, notice, { queuable: true }).catch(() => undefined);
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, async () => {
            const reject = this.writeGateRejectReason(chatId, 'send_msg');
            if (reject !== null) {
                this.ctx.events?.record({ direction: 'out', chatId, kind: 'segments', ok: false, reason: reject });
                throw new OneBotActionError(reject);
            }
            try {
                const id = await this.sendMsg(chatId, segments, {});
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                // 工具主动发群文本也算「我说话了」：晚安类关键词同样开启自动静默。
                this.armGroupSilence(chatId, segmentsText(segments), true);
                this.ctx.events?.record({ direction: 'out', chatId, kind: 'segments', ok: true, reason: '主动发送成功', messageId: id });
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                this.ctx.events?.record({ direction: 'out', chatId, kind: 'segments', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** A2：正在等待的分条间隔（stopBubbles 一次性清掉，避免 dispose 后还在发）。 */
    bubbleWaiters = new Set();
    /** A2：代际号。stopBubbles 自增，正在跑的发送循环看到变化就停。 */
    bubbleGeneration = 0;
    /** A2：可中断的等待；返回 false = 插件已停/等待被取消。 */
    waitBubbles(ms, generation) {
        if (ms <= 0)
            return Promise.resolve(generation === this.bubbleGeneration);
        return new Promise((resolve) => {
            const entry = { timer: undefined, resolve };
            entry.timer = setTimeout(() => {
                this.bubbleWaiters.delete(entry);
                resolve(generation === this.bubbleGeneration);
            }, ms);
            if (typeof entry.timer.unref === 'function')
                entry.timer.unref();
            this.bubbleWaiters.add(entry);
        });
    }
    /** A2：ChatBridge.stop() 调用——取消所有分条等待，后续循环看到代际变化即退出。 */
    stopBubbles() {
        this.bubbleGeneration += 1;
        for (const entry of this.bubbleWaiters) {
            clearTimeout(entry.timer);
            entry.resolve(false);
        }
        this.bubbleWaiters.clear();
    }
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.ctx.call('send_msg', params, chatId);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    async sendForward(chatId, nodes) {
        const reject = this.writeGateRejectReason(chatId, 'send_forward_msg');
        if (reject !== null) {
            this.ctx.events?.record({ direction: 'out', chatId, kind: 'forward', ok: false, reason: reject });
            throw new OneBotActionError(reject);
        }
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
            this.ctx.events?.record({ direction: 'out', chatId, kind: 'forward', ok: true, reason: '合并转发已发送' });
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            this.ctx.events?.record({ direction: 'out', chatId, kind: 'forward', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId);
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId);
        }
    }
}
