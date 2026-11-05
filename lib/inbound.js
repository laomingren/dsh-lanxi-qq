/**
 * Inbound pipeline (M2-D1-PR4): the OneBot-11 → agent-turn path. Two pieces:
 * `normalizeOneBot11`, the pure protocol-adaptation seam that reduces one
 * raw message event to a neutral NormalizedInbound (null = not processable),
 * and `InboundPipeline`, which runs the normalized message through the
 * policy gate → mention gate → command router → media resolution →
 * quote/forward expansion → rate limit → turn dispatch. Extracted verbatim
 * from bridge.ts — gate order, prefix assembly, media annotation and
 * rate-limit behavior are identical; the bridge keeps same-name facade
 * methods so the onFrame call site, the command table and the M2-T0
 * pipeline-order overrides keep working unchanged.
 * @module dsh-onebot/inbound
 */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { extForInboundName, imageExtFromBytes } from './media.js';
import { transcriptLabel } from './stt.js';

/** 语音同步听（2026-10-31 蓝汐补丁）：子进程跑语音听写脚本，超时 8 秒。
 * 解释器与脚本路径来自配置 voiceEarPython / voiceEarScript（2026-11-03 脱敏
 * 改造，不再写死本机路径）：任一留空即功能关闭；听不出来/超时一律退回 [语音]。 */
const VOICE_EAR_TIMEOUT_MS = 8000;

/** 群聊自主发言冷却（2026-10-27 蓝汐补丁）：chatId → 上次接话时间 */
const groupReplyAt = new Map();
/** 群聊每日发言预算（2026-10-27 蓝汐补丁）：chatId → { day, n } */
const groupQuota = new Map();
/**
 * 群聊每日预算落盘（2026-10-28 蓝汐补丁）：DSH 重启后当天已用条数继续生效。
 * 文件只存北京时间当天：date=yyyy-MM-dd，counts={群号: 条数}，updatedAt=ISO。
 * 读写在模块顶层完成/收口，任何异常只记日志，不得抛出、不得影响消息收发。
 */
const GROUP_QUOTA_FILE = join(homedir(), '.dsh', 'onebot-group-quota.json');
const GROUP_QUOTA_TMP = GROUP_QUOTA_FILE + '.tmp';
let groupQuotaLoadError = null;
/** 北京时间（UTC+8）自然日 yyyy-MM-dd；与配额判断同一口径。 */
function beijingDayKey(nowMs = Date.now()) {
    return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
/** 北京时间 HH:MM 文本 → 当日分钟数；空值/格式非法返回 null（视为未配置）。 */
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
 * 群聊夜间静默（2026-10-28 蓝汐补丁）：当前是否落在北京时间静默区间 [start, end)。
 * start > end 表示跨午夜（如 23:00→08:00）；任一端为空/非法、或 start === end
 * （零长度窗口）都返回 false，即默认关闭。时区口径与 beijingDayKey 一致。
 */
function inBeijingQuietHours(startText, endText, nowMs = Date.now()) {
    const start = parseBeijingClock(startText);
    const end = parseBeijingClock(endText);
    if (start === null || end === null || start === end)
        return false;
    const bj = new Date(nowMs + 8 * 3600 * 1000);
    const nowMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    return start < end
        ? nowMin >= start && nowMin < end
        : nowMin >= start || nowMin < end;
}
/** 模块加载时读一次：date 不是今天就当 0 重新开始；文件缺失/损坏按空表处理。 */
function loadGroupQuota() {
    const loaded = new Map();
    try {
        const raw = readFileSync(GROUP_QUOTA_FILE, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        const today = beijingDayKey();
        if (data !== null && typeof data === 'object' && data.date === today
            && data.counts !== null && typeof data.counts === 'object') {
            for (const [groupId, raw] of Object.entries(data.counts)) {
                const n = Number(raw);
                if (Number.isFinite(n) && n > 0)
                    loaded.set(String(groupId), { day: today, n: Math.floor(n) });
            }
        }
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            groupQuotaLoadError = describeError(error);
    }
    return loaded;
}
for (const [quotaGroupId, quotaBudget] of loadGroupQuota())
    groupQuota.set(quotaGroupId, quotaBudget);
/** 落盘一次：先写同目录 .tmp，再 rename 原子替换；失败只记日志。 */
async function writeGroupQuota(map, log) {
    try {
        const today = beijingDayKey();
        const counts = {};
        for (const [groupId, budget] of map) {
            if (budget.day === today)
                counts[groupId] = budget.n;
        }
        const payload = JSON.stringify({ date: today, counts, updatedAt: new Date().toISOString() }, null, 2) + '\n';
        await writeFile(GROUP_QUOTA_TMP, payload, 'utf8');
        await rename(GROUP_QUOTA_TMP, GROUP_QUOTA_FILE);
    }
    catch (error) {
        log('warn', 'group quota persist failed: ' + describeError(error));
    }
}
/** 串行写队列：并发加一时不会有两个写者同时操作同一个 .tmp。 */
let groupQuotaSaveChain = Promise.resolve();
function saveGroupQuota(map, log) {
    groupQuotaSaveChain = groupQuotaSaveChain.then(() => writeGroupQuota(map, log));
    return groupQuotaSaveChain;
}
/**
 * 群聊自动静默状态（2026-10-28 蓝汐补丁）：出站命中第一人称晚安类关键词后，
 * 由 outbound.js 原子写 ~/.dsh/onebot-group-silent.json（{until, reason, setAt}）。
 * 这里只读：读盘带 5 秒缓存，避免每条消息都同步读盘。
 * 安全退回：文件缺失、JSON 损坏、until 非法、until 已过、until 距今超过 26 小时
 * （只可能是时钟异常）——一律视为「没在静默」，绝不因状态文件影响正常收发。
 */
const GROUP_SILENT_FILE = join(homedir(), '.dsh', 'onebot-group-silent.json');
/** 出场点最多在今天/明天之间，26 小时以外视为时钟异常。 */
const GROUP_SILENT_MAX_AHEAD_MS = 26 * 3600 * 1000;
/** mtime 缓存：文件没变就不重复读内容（statSync 一次，远轻于每条读盘）。 */
let groupSilentCache = { mtimeMs: -1, until: null, setAt: NaN };
/** 当前自动静默截止时间（epoch ms）；null = 不在静默。 */
function readGroupSilentUntil(nowMs = Date.now()) {
    let mtimeMs;
    try {
        mtimeMs = statSync(GROUP_SILENT_FILE).mtimeMs;
    }
    catch {
        // ENOENT = 从没静默过；stat 失败同样退回「不静默」，不抛错、不打扰收发。
        groupSilentCache = { mtimeMs: -1, until: null, setAt: NaN };
        return null;
    }
    if (mtimeMs !== groupSilentCache.mtimeMs) {
        let until = null;
        let setAt = NaN;
        try {
            const raw = readFileSync(GROUP_SILENT_FILE, 'utf8').replace(/^\uFEFF/, '');
            const data = JSON.parse(raw);
            const parsedUntil = Date.parse(String(data?.until ?? ''));
            const parsedSetAt = Date.parse(String(data?.setAt ?? ''));
            if (Number.isFinite(parsedUntil))
                until = parsedUntil;
            if (Number.isFinite(parsedSetAt))
                setAt = parsedSetAt;
        }
        catch {
            // JSON 损坏/读失败：按「没有静默」处理，下一条消息还会再试一次。
            until = null;
            setAt = NaN;
        }
        groupSilentCache = { mtimeMs, until, setAt };
    }
    const { until, setAt } = groupSilentCache;
    // 每次都按当前时钟复检：过期、超 26 小时（时钟回拨等异常）、until <= setAt
    // 的坏数据一律视为不静默。
    if (until === null || !(until > nowMs) || until - nowMs > GROUP_SILENT_MAX_AHEAD_MS)
        return null;
    if (Number.isFinite(setAt) && until <= setAt)
        return null;
    return until;
}
/** 被管理员叫醒：立刻失效缓存并删状态文件（删除失败重试两次；仍失败只 warn，
 * 并按当前 mtime 记住「已叫醒」，避免进程内反复静默/反复尝试删除）。 */
function clearGroupSilent(log) {
    groupSilentCache = { mtimeMs: -1, until: null, setAt: NaN };
    void (async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                await unlink(GROUP_SILENT_FILE);
                return;
            }
            catch (error) {
                if (error?.code === 'ENOENT')
                    return;
                if (attempt === 2) {
                    log('warn', 'group auto-silence state clear failed: ' + describeError(error));
                    try {
                        groupSilentCache = { mtimeMs: statSync(GROUP_SILENT_FILE).mtimeMs, until: null, setAt: NaN };
                    }
                    catch {
                        // 文件已不可读：缓存保持失效，下次消息重新探测。
                    }
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    })();
}
/** 文本里是否喊到唤醒名（任一名字出现即算，仅管理员消息会被调用方采信）。 */
function namedInText(text, names) {
    const hay = String(text ?? '');
    if (hay === '')
        return false;
    return (Array.isArray(names) ? names : []).some((name) => {
        const needle = String(name ?? '').trim();
        return needle !== '' && hay.includes(needle);
    });
}
/**
 * 静默闸专用「@ 机器人本人」判定（2026-10-28 夜间只认点名补丁）：
 * 与 detectMention 不同，@全体成员（qq === 'all'）不算——只有 at 段明确指向
 * 机器人自己的 QQ 才算唤醒信号。段数组优先，CQ 字符串兜底。
 */
function atBotInSegments(segments, raw, selfId, botQQ) {
    const bot = selfId !== '' ? selfId : botQQ;
    if (bot === '')
        return false;
    if (segments !== undefined && segments.length > 0) {
        return segments.some(seg => seg.type === 'at' && String(seg.data?.qq ?? '') === String(bot));
    }
    for (const m of String(raw ?? '').matchAll(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g)) {
        if (cqUnescape(m[1]) === String(bot))
            return true;
    }
    return false;
}
/**
 * reply 段自带发送者 QQ 时直接比对（2026-10-28 夜间只认点名补丁）。
 * NapCat 的 reply 段通常只有 id，此时这里返回 false，由
 * InboundPipeline.replyTargetsBot 用 get_msg 反查；不把「无法判断」当唤醒。
 */
function replySegmentTargetsBot(segments, selfId, botQQ) {
    const bot = selfId !== '' ? selfId : botQQ;
    if (bot === '' || segments === undefined)
        return false;
    return segments.some((seg) => {
        if (seg.type !== 'reply')
            return false;
        const sender = seg.data?.qq ?? seg.data?.sender_id ?? seg.data?.user_id;
        return sender !== undefined && String(sender) === String(bot);
    });
}
/**
 * 群聊静默生效范围（2026-10-28 蓝汐补丁）：groupSilentGroupIds 为空（默认）=
 * 所有群都吃固定静默与自动静默，行为与加这个键之前完全一致；非空 = 只有列表里
 * 的群才受这两层静默限制，列表外的群当作没开静默，继续走 @ 门控、冷却、每日配额。
 * 群号两侧统一 String(...).trim() 再比——NapCat 的 group_id 可能是数字，配置里
 * 写的是字符串（或反过来）。只由 kind === 'group' 的入站调用，私聊不经过这里。
 */
function silenceAppliesToGroup(groupId, groupSilentGroupIds) {
    const allowed = (Array.isArray(groupSilentGroupIds) ? groupSilentGroupIds : [])
        .map(id => String(id ?? '').trim())
        .filter(id => id !== '');
    if (allowed.length === 0)
        return true;
    return allowed.includes(String(groupId ?? '').trim());
}
import { cqUnescape, detectMention, parseMessage, segmentText } from './cq.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed, RESTRICTED_PREFIX, sanitizeNickname, wrapUserMessage, } from './chat.js';
import { describeError } from './errors.js';
import { GROUP_HISTORY_COUNT, GROUP_HISTORY_TIMEOUT_MS, formatGroupHistoryBlock, mapGroupHistoryMessage } from './group-history.js';
import { currentTrace, TRACE_REASONS } from './trace.js';
/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = Array.isArray(event.message) ? event.message : undefined;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const parsed = parseMessage(segments, raw);
    const sender = event.sender ?? {};
    const nickname = typeof sender.card === 'string' && sender.card !== ''
        ? sender.card
        : typeof sender.nickname === 'string' && sender.nickname !== ''
            ? sender.nickname
            : userId;
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        raw,
        text: parsed.text,
        media: parsed.media,
        replyId: parsed.replyId,
        forwardId: parsed.forwardId,
        messageId,
        nickname,
    };
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export const DEDUP_MAX_ENTRIES = 4096;
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export class InboundPipeline {
    ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    dedupMaxEntries;
    now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    seenMessages = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    async processInbound(inbound) {
        if (this.duplicated(inbound))
            return;
        const { kind, userId, groupId, chatId } = inbound;
        if (this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            // pipeline-hooks.md #5: this drop used to be fully silent.
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        const policy = this.ctx.policy;
        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
                return;
            }
        }
        // 管理员判定复用既有口径（classifyUserRole + policy.adminUsers，
        // adminUsers 已合并 ONEBOT_ALLOWED_USERS），下面静默闸与受限前缀都用它。
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        let mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        // 2026-10-28 蓝汐补丁：引用机器人本人的消息也算点名。NapCat 的 reply 段只有
        // 消息 id、没有 qq，detectMention 按收紧语义判不出来；这里用 get_msg 反查一次
        // 原消息发送者，是机器人就把 mentioned 置真。查不到/失败一律按「不是机器人」。
        // 只在本条消息还没被 @ 命中、且是群聊时查；结果缓存在本条消息内，后面的
        // 静默唤醒复用同一次反查，绝不发第二次请求。
        let replyToBotCache;
        const replyToBotOnce = async () => {
            if (replyToBotCache === undefined)
                replyToBotCache = await this.replyTargetsBot(inbound.replyId);
            return replyToBotCache;
        };
        if (!mentioned && kind === 'group' && inbound.replyId !== undefined
            && await replyToBotOnce()) {
            mentioned = true;
        }
        const wokeByName = namedInText(inbound.text, this.ctx.config.groupQuietWakeNames);
        // 管理员本人的唤醒信号：@ 我、引用我的消息，或文本里喊到唤醒名。只有管理员
        // 算数；冷却豁免沿用这个判断（reply 反查让「引用追问」也享受豁免）。
        const adminWake = isAdmin && (mentioned || wokeByName);
        // 静默闸专用唤醒（2026-10-28「夜间只认点名」补丁）：只认三种明确信号——
        // @ 段指向机器人本人（@全体不算）、reply 段引用机器人的消息、正文喊到
        // groupQuietWakeNames。adminWake 不能直接拿来做静默闸：它对「文本里喊名字」
        // 也放行，而静默闸要求的是明确点名信号；这里独立算一遍，语义更窄更清楚。
        const atBot = atBotInSegments(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        let silenceWake = isAdmin && (atBot || wokeByName
            || replySegmentTargetsBot(inbound.segments, this.ctx.selfId(), this.ctx.config.botQQ));
        // 静默生效范围（2026-10-28 蓝汐补丁）：groupSilentGroupIds 非空时只有列表里
        // 的群才吃下面两层静默；列表外的群两层都跳过，当作没开静默，继续走 @ 门控、
        // 冷却、每日配额。空列表（默认）= 所有群都吃，与加这个键之前完全一致。
        // 私聊在这里恒为 false（kind !== 'group'），所以私聊完全不受影响。
        const groupSilenceOn = kind === 'group'
            && silenceAppliesToGroup(groupId, this.ctx.config.groupSilentGroupIds);
        // 群聊自动静默（2026-10-28 蓝汐补丁）：状态文件的 until 未到就整群静默——
        // 只有管理员本人（管理员）的明确唤醒信号才能穿透并删除状态文件（=被叫醒）；
        // 其他人就算 @、喊名字也照丢。丢弃发生在这里：不占冷却、不加每日配额、
        // 不进 turn，只留一条 debug 日志。
        // groupAutoSilence=false（默认）或本群不在 groupSilentGroupIds 里时完全不读状态文件。
        const silentUntil = groupSilenceOn && this.ctx.config.groupAutoSilence === true
            ? readGroupSilentUntil()
            : null;
        const inQuietHours = groupSilenceOn
            && inBeijingQuietHours(this.ctx.config.groupQuietStart, this.ctx.config.groupQuietEnd);
        // NapCat 的 reply 段只有消息 id、没有发送者 QQ：管理员引用消息时，若其他
        // 信号都没命中且静默确实生效，用 get_msg 反查一次原消息发送者。查不到、
        // 调用失败一律按「不是机器人」——夜里宁可不醒，也不误醒。
        if (isAdmin && !silenceWake && inbound.replyId !== undefined
            && (silentUntil !== null || inQuietHours)) {
            // 复用上面「引用机器人 = 点名」那次反查的结果；没查过才会真的调 get_msg。
            silenceWake = await replyToBotOnce();
        }
        let wokenNow = false;
        // 2026-10-28 蓝汐补丁：自动静默状态文件不在闸中间删。先记下「这条是管理员
        // 叫醒的」，等所有准入闸都过完、确认消息真的要进回合（或已被命令消费 / 忙时
        // 排队）再删文件，避免「状态删了、消息却被后面的峰时/配额/限流丢掉」。
        let pendingSilenceRelease = false;
        if (groupSilenceOn && silentUntil !== null) {
            if (silenceWake) {
                pendingSilenceRelease = true;
                wokenNow = true;
            }
            else {
                this.ctx.log('debug', 'group auto-silence skip in ' + groupId);
                return;
            }
        }
        // 2026-11-03 蓝汐补丁：斜杠命令（/new /stop 等）是管理操作，不属于群聊闲聊。
        // NapCat 有时会把 @ 段吞成纯文本（15:19 群里的 /new 就只收到 "/new"、mentioned=false），
        // 命令消息因此被点名/静默/冷却/峰时/配额这些聊天闸误拦。命令本身只有管理员能执行，放行安全。
        const inboundTrim = (typeof inbound.text === 'string' ? inbound.text : '').trim();
        const inboundRawTrim = (typeof inbound.raw === 'string' ? inbound.raw : '').trim();
        const isSlashCommand = /^[\/／]/.test(inboundTrim) || /^[\/／]/.test(inboundRawTrim);
        // 真正叫醒时才落盘：删状态文件 + 记一条 info。只在确认进回合的路径上调用。
        const releaseSilenceIfWoken = () => {
            if (!pendingSilenceRelease)
                return;
            pendingSilenceRelease = false;
            clearGroupSilent((level, message) => this.ctx.log(level, message));
            this.ctx.log('info', 'group auto-silence released by admin in ' + groupId);
        };
        // 群聊夜间静默（2026-10-28 蓝汐补丁，2026-10-28 收紧为只认点名）：
        // 静默时段内只有管理员本人的明确唤醒信号（@ 机器人本人、引用机器人消息、
        // 喊 groupQuietWakeNames）能穿透，其他管理员普通聊天、其他人的 @ 或点名
        // 一律丢弃——不占冷却、不写每日配额、不进回合，只留一条 debug 日志。
        // groupQuietStart / groupQuietEnd 任一为空或非法 = 功能关闭（默认）；
        // 本群不在 groupSilentGroupIds 里（列表非空时）同样整段跳过，继续往下走。
        if (inQuietHours && !isSlashCommand) {
            if (!silenceWake) {
                this.ctx.log('debug', 'group quiet-hours skip in ' + groupId);
                return;
            }
            wokenNow = true;
        }
        // 被叫醒的这一条要能穿过 requireMention：管理员点名不一定带 @。
        if (kind === 'group' && this.ctx.config.requireMention && !mentioned && !wokenNow && !isSlashCommand) {
            this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
            currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
            return;
        }
        // 群聊自主发言冷却（2026-10-27 蓝汐补丁）：没被 @ 的群消息在冷却窗口内
        // 只接一次，避免群里每句话都插嘴；被 @ / 被引用（引用机器人）的永远不受此限。
        // 管理员本人点名唤醒（adminWake）与刚被叫醒的这条（wokenNow）同样豁免。
        // 2026-10-28 修正：显式 0（或负数）就是关闭冷却，不能再被 `|| 120000` 反转；
        // 只有缺省/非数字等非法值才回退 120000。
        if (kind === 'group' && !mentioned && !adminWake && !wokenNow && !isSlashCommand) {
            const rawCooldown = this.ctx.config.groupReplyCooldownMs;
            const parsedCooldown = rawCooldown === undefined || rawCooldown === null || rawCooldown === ''
                ? 120_000
                : Number(rawCooldown);
            const gapMs = Number.isFinite(parsedCooldown) ? parsedCooldown : 120_000;
            if (gapMs > 0) {
                const nowMs = Date.now();
                const lastMs = groupReplyAt.get(groupId) ?? 0;
                if (nowMs - lastMs < gapMs) {
                    this.ctx.log('debug', 'group cooldown skip in ' + groupId);
                    return;
                }
                groupReplyAt.set(groupId, nowMs);
            }
        }
        // 群聊发言预算（2026-10-27 蓝汐补丁）：谷时限制 + 每日条数上限。
        // 高峰时段（北京时间、工作日 9:00-12:00 与 14:00-18:00）只接被 @ 的；
        // 每天最多接 groupDailyQuota 次（默认 30），按回复次数算、不按气泡数算。
        if (kind === 'group') {
            const dailyQuota = Number(this.ctx.config.groupDailyQuota ?? 30);
            if (groupQuotaLoadError !== null) {
                // 落盘读失败只在首个群消息时提醒一次，计数按 0 重新开始，不影响收发。
                this.ctx.log('warn', 'group quota load failed, counts start from 0: ' + groupQuotaLoadError);
                groupQuotaLoadError = null;
            }
            const bj = new Date(Date.now() + 8 * 3600 * 1000);
            const dayKey = bj.toISOString().slice(0, 10);
            const hour = bj.getUTCHours();
            const weekday = bj.getUTCDay();
            const isWeekend = weekday === 0 || weekday === 6;
            const isPeak = !isWeekend && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
            // 2026-10-28 修正：峰时闸认「点名」——被 @ / 引用机器人（mentioned）、
            // 管理员喊名字（adminWake）、刚从静默里被叫醒（wokenNow），三者任一即放行。
            if (isPeak && this.ctx.config.groupPeakOnlyMention !== false
                && !mentioned && !adminWake && !wokenNow && !isSlashCommand) {
                this.ctx.log('debug', 'group peak-hours skip in ' + groupId);
                return;
            }
            if (dailyQuota > 0) {
                // 2026-10-28 修正（他问「群里艾特你为啥不理我」）：点名（@ 我 / 引用我）、
                // 管理员喊名字、刚从静默里被叫醒——这三种一律不吃每日配额，
                // 配额只限我主动接闲话的量，不能把他叫我这件事拦在门外。
                // 2026-11-01（管理员定）：豁免放宽成「任何人的明确点名」——被 @ / 引用我
                // 消息的都算，谁叫我都能进。起因：鱼鱼小家 60 次额度 13:55 就用满，
                // 之后除管理员外所有人 @ 都被丢，小鲸叫不动我。每日额度只该限我主动
                // 接闲话的量，不能把人叫我这件事拦在门外。静默时段被点名叫醒的那一条
                // 依旧豁免，否则等于叫了也不给回。
                const quotaExempt = mentioned || wokenNow || isSlashCommand;
                let budget = groupQuota.get(groupId);
                if (budget === undefined || budget.day !== dayKey) {
                    budget = { day: dayKey, n: 0 };
                    groupQuota.set(groupId, budget);
                }
                if (!quotaExempt) {
                    if (budget.n >= dailyQuota) {
                        this.ctx.log('debug', 'group daily quota exhausted in ' + groupId);
                        return;
                    }
                    budget.n += 1;
                    // 2026-10-28 蓝汐补丁：加一后落盘（异步、异常不抛出），重启后当天计数继续有效。
                    void saveGroupQuota(groupQuota, (level, message) => this.ctx.log(level, message));
                }
            }
        }
        // M3-D5 identity whitelist: the sanitized nickname feeds the single-line
        // prefix, the <user_message> attribute and lastNickname — one value,
        // provably line-safe and markup-free for all three surfaces.
        const nickname = sanitizeNickname(inbound.nickname);
        // B8c: lazy idle eviction before processing each inbound message (flush →
        // dispose → remove; the mapping is kept so the chat can resume).
        await this.ctx.sweepIdleChats();
        // A new user message starts a fresh reply cycle: drop any unmerged loop
        // residue from the previous cycle so interims never merge across turns.
        const priorChat = this.ctx.getChat(chatId);
        if (priorChat !== undefined) {
            priorChat.loopBuffer = [];
            priorChat.loopPending = null;
        }
        // Fire-and-forget temp cleanup on each inbound.
        void this.ctx.media.cleanupExpired();
        // C6a: route slash commands BEFORE any media/quote I/O — a message that
        // happens to carry media must not pay for downloads or get_msg calls just
        // to be consumed as a command (admin-only; unknown /-words still fall
        // through to the model). The most recent inbound image is registered from
        // parsed.media up front so /ocr still sees it (resolved lazily there).
        for (const ref of inbound.media) {
            if (ref.kind === 'image')
                this.ctx.getSettings(chatId).pendingImageRef = ref;
        }
        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {
            // 命令已经把这条消息消费掉了：此刻才算真正叫醒，删掉自动静默状态。
            releaseSilenceIfWoken();
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        const body = await this.ctx.buildBody(inbound.text, inbound.media, chatId);
        let quote = '';
        if (inbound.replyId !== undefined) {
            quote = await this.ctx.expandQuote(inbound.replyId);
        }
        let forward = '';
        if (inbound.forwardId !== undefined) {
            const expansion = await this.expandForward(inbound.forwardId);
            forward = expansion.text;
            if (expansion.media.length > 0) {
                // Forward-embedded images ride the same buildBody pipeline (their
                // '[图片]' placeholders are inline in the expansion text). Preserve
                // the pre-routing /ocr ref so a direct image in the same message
                // stays the /ocr target.
                const pending = this.ctx.getSettings(chatId).pendingImageRef;
                forward = await this.ctx.buildBody(expansion.text, expansion.media, chatId);
                this.ctx.getSettings(chatId).pendingImageRef = pending;
            }
        }
        if (this.rateLimited(chatId))
            return;
        // M3-D5: the whole sender-controlled payload (body + quote/forward
        // expansions) enters the prompt inside the <user_message> boundary, so
        // forged prefix lines, restricted-member tags and system-prompt-like text
        // stay pure data. The framework-generated group prefix and
        // RESTRICTED_PREFIX remain outside — the only trusted metadata.
        const content = [forward, quote, body].filter(part => part !== '').join('\n');
        if (content.trim() === '') {
            // pipeline-hooks.md #17: this drop used to be fully silent.
            this.ctx.log('debug', '消息展开后无有效文本内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        // 2026-11-02 蓝汐补丁：群回合触发时把群里最近 20 条消息作为上下文档，放在
        // <user_message> 边界内、当前这条消息之前。群会话每轮原本只把触发的那条
        // @ 消息喂给模型，中间没 @ 的群消息不进上下文，模型看不见别人在聊什么；
        // 补上这段历史后它才能接着上下文答。私聊不进这里。
        // buildGroupHistoryBlock 内部已保证：NapCat 不可用、超时（>3 秒）、返回空、
        // 任何异常一律返回 ''，此处按没有历史原样发送，绝不影响正常回复。
        let dispatchContent = content;
        if (kind === 'group') {
            const historyBlock = await this.buildGroupHistoryBlock(groupId, inbound.messageId);
            if (historyBlock !== '') {
                dispatchContent = historyBlock + '\n\n当前这条消息：\n' + content;
            }
        }
        let final = wrapUserMessage(dispatchContent, userId, nickname);
        if (kind === 'group') {
            final = buildGroupMessagePrefix(nickname, userId, mentioned) + final;
            if (!isAdmin && this.ctx.config.restrictedMemberPrefix) {
                final = RESTRICTED_PREFIX + final;
            }
        }
        const role = isAdmin ? 'admin' : 'member';
        // T2 (P1): the busy-turn policy seam runs AFTER every gate above (dedup /
        // self / policy / mention / command / rate-limit) and only around the
        // final dispatch — a queued or steered message has already paid for its
        // rate-limit slot and passed the whole pipeline. `plain` = no media, no
        // quote, no forward: the only shape eligible for steer (media-bearing
        // messages always queue so the full media pipeline runs for their own
        // turn). Seam absent = pre-T2 behavior (straight dispatch).
        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;
        if (this.ctx.interceptBusyTurn !== undefined
            && await this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain)) {
            // 忙时排队/插话也算被接住了：这条回复随后会由运行中的回合并入发出。
            releaseSilenceIfWoken();
            return;
        }
        // 走到这里所有准入闸都已通过、消息确定进回合，才允许删自动静默状态文件。
        releaseSilenceIfWoken();
        await this.ctx.dispatchFollowup(chatId, final, role, nickname);
    }
    /**
     * 引用的消息是不是机器人自己发的（2026-10-28 夜间只认点名补丁）：
     * NapCat 的 reply 段只有 id，只能拿 get_msg 反查原消息 sender。
     * 查不到、返回异常、调用失败一律按「不是」返回——静默期间宁可漏醒，
     * 也不能因为一次失败把管理员随手回复当成唤醒。仅在静默生效且管理员
     * 引用消息时调用，白天与普通群聊零额外请求。
     */
    async replyTargetsBot(messageId) {
        const bot = this.ctx.selfId() !== '' ? this.ctx.selfId() : this.ctx.config.botQQ;
        if (bot === '' || messageId === undefined || messageId === '')
            return false;
        try {
            const data = await this.ctx.call('get_msg', { message_id: Number(messageId) });
            const senderId = String(data?.sender?.user_id ?? data?.user_id ?? '');
            return senderId !== '' && senderId === String(bot);
        }
        catch (error) {
            this.ctx.log('debug', 'reply wake lookup failed: ' + describeError(error));
            return false;
        }
    }
    /**
     * 群聊历史上下文档（2026-11-02 蓝汐补丁）：拉群里最近 GROUP_HISTORY_COUNT+1
     * 条消息（多拉一条，剔除当前触发消息后仍剩 20 条），格式化成
     * '[HH:MM] 昵称(QQ): 正文' 行块，由调用方放进 <user_message> 边界内。
     * 防重复：message_id 等于当前触发消息的那条只出现在「当前这条消息」里，
     * 历史里剔除，同一回合不出现两遍。
     * 失败静默降级：NapCat 不可用、超时、返回空、任何异常一律返回 ''，
     * 本方法绝不抛出；耗时上界 GROUP_HISTORY_TIMEOUT_MS（3 秒）。
     */
    async buildGroupHistoryBlock(groupId, currentMessageId) {
        if (typeof this.ctx.call !== 'function')
            return '';
        const groupNum = Number(groupId);
        if (!Number.isFinite(groupNum) || groupNum <= 0)
            return '';
        let data;
        try {
            data = await this.callGroupHistory(groupNum, GROUP_HISTORY_COUNT + 1);
        }
        catch (error) {
            // 断连/超时/API 报错都只留一条 debug 日志，按没有历史继续发。
            this.ctx.log('debug', 'group history context skipped in ' + groupId + ': ' + describeError(error));
            return '';
        }
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        if (messages.length === 0)
            return '';
        const rows = messages.map(mapGroupHistoryMessage);
        const triggerId = currentMessageId === undefined || currentMessageId === null
            ? ''
            : String(currentMessageId);
        const kept = triggerId !== ''
            ? rows.filter(row => row.message_id !== triggerId)
            : rows;
        // NapCat 返回按时间从早到晚；取末尾 GROUP_HISTORY_COUNT 条 = 最近的 20 条。
        const latest = kept.slice(-GROUP_HISTORY_COUNT);
        if (latest.length === 0)
            return '';
        this.ctx.log('debug', 'group history context attached in ' + groupId + ': ' + latest.length + ' rows');
        return formatGroupHistoryBlock(latest);
    }
    /**
     * get_group_msg_history 的 3 秒硬超时封装。connection.call 自身的
     * callTimeoutMs 可能远大于 3 秒，历史上下文不值得为它多等——超时先 reject，
     * 底层 promise 迟到 settle 时挂空 catch 吞掉，避免 unhandledRejection。
     */
    callGroupHistory(groupId, count) {
        const pending = this.ctx.call('get_group_msg_history', { group_id: groupId, count });
        let timer;
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('get_group_msg_history timed out after '
                + GROUP_HISTORY_TIMEOUT_MS + 'ms')), GROUP_HISTORY_TIMEOUT_MS);
        });
        pending.catch(() => { });
        return Promise.race([pending, timeout]).finally(() => { clearTimeout(timer); });
    }
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
    /** B7: sliding-window inbound rate limit for normal (non-command) messages.
     * Commands consumed by tryHandleCommand never reach this. Returns true when
     * the message must be dropped; at most one notice is sent per window. */
    rateLimited(chatId) {
        const limit = this.ctx.config.rateLimitPerMinute ?? 30;
        if (limit <= 0)
            return false;
        const chat = this.ctx.getChat(chatId);
        if (chat === undefined)
            return false;
        const now = Date.now();
        chat.dispatchTimes = chat.dispatchTimes.filter(t => now - t < 60_000);
        if (chat.dispatchTimes.length < limit) {
            chat.dispatchTimes.push(now);
            return false;
        }
        // pipeline-hooks.md #16: the drop decision itself used to be silent (only
        // the user-facing notice text existed).
        currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateLimited });
        if (chat.rateLimitNoticeAt === undefined || now - chat.rateLimitNoticeAt >= 60_000) {
            chat.rateLimitNoticeAt = now;
            void this.ctx.sendToChat(chatId, '⏳ 消息太频繁，请稍后再试。').catch((error) => {
                this.ctx.log('debug', '限流提示发送失败: ' + describeError(error));
                currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateNoticeFailed });
            });
        }
        return true;
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, chatId) {
        if (media.length === 0)
            return text;
        let out = text;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder);
            const annotation = await this.resolveMediaRef(ref, chatId);
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
            }
            else if (idx >= 0) {
                // pipeline-hooks.md #10: a failed resolution used to leave the
                // placeholder silently unresolved.
                this.ctx.log('debug', '媒体解析失败，占位符保留原文: ' + placeholder);
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.mediaResolveFailed });
            }
        }
        return out;
    }
    /** Resolve one media ref to a text annotation with a local path. */
    async resolveMediaRef(ref, chatId) {
        if (ref.kind === 'file') {
            return await this.resolveNasFile(ref);
        }
        const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.ctx.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image':
                // Remember the most recent inbound image for /ocr (survives /new);
                // consume the pre-routing pending ref so /ocr never re-resolves it.
                const settings = this.ctx.getSettings(chatId);
                settings.lastImagePath = resolved.path;
                settings.pendingImageRef = undefined;
                return '[图片:' + resolved.path + ']';
            case 'voice': {
                // 2026-10-31 语音同步听（蓝汐补丁）：最多花 8 秒听内容，
                // 听不出来再走 M3-D4c 的后台 STT 兜底，最后保持 [语音]。
                const heard = await this.listenVoice(resolved.path);
                if (heard !== '') {
                    return '[语音:' + resolved.path + ']\n' + heard;
                }
                // M3-D4c: dispatch must not wait on STT — the [语音] placeholder ships
                // now and the transcript steers into the turn when it completes. A
                // failure/timeout keeps the placeholder as the final state.
                if (this.ctx.transcriber.enabled) {
                    void this.transcribeLater(resolved.path, chatId);
                }
                return '[语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** 语音同步听（2026-10-31 蓝汐补丁）：起 qq_ear.py 子进程，8 秒超时。
     * 成功返回一行中文听觉描述；失败/超时/空输出返回 ''，由调用方保留 [语音]。
     * 这条路径在消息入口上：任何异常都必须被吃掉，绝不能影响消息收发。 */
    async listenVoice(path) {
        // 2026-11-03：解释器/脚本路径改为配置项（voiceEarPython/voiceEarScript），
        // 任一留空 = 功能关闭，直接退回 [语音]，不再起任何子进程。
        const config = this.ctx.config ?? {};
        const python = typeof config.voiceEarPython === 'string' ? config.voiceEarPython.trim() : '';
        const script = typeof config.voiceEarScript === 'string' ? config.voiceEarScript.trim() : '';
        if (python === '' || script === '')
            return '';
        const suffix = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        const outPath = join(tmpdir(), 'qq-ear-' + suffix + '.txt');
        const workDir = outPath + '.d';
        try {
            const ok = await new Promise((resolve) => {
                let settled = false;
                let timer;
                const finish = (value) => {
                    if (settled)
                        return;
                    settled = true;
                    if (timer !== undefined)
                        clearTimeout(timer);
                    resolve(value);
                };
                let child;
                try {
                    child = spawn(python, [script, '--file', path, '--out', outPath, '--tmpdir', workDir], {
                        windowsHide: true,
                        stdio: ['ignore', 'ignore', 'pipe'],
                        // Python 在 Windows 管道里默认用 cp936；统一成 UTF-8，日志才不是乱码。
                        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                    });
                }
                catch (error) {
                    this.ctx.log('warn', '语音听觉子进程启动失败: ' + describeError(error));
                    finish(false);
                    return;
                }
                let stderr = '';
                child.stderr?.on('data', (chunk) => {
                    if (stderr.length < 2000)
                        stderr += String(chunk);
                });
                child.once('error', (error) => {
                    this.ctx.log('warn', '语音听觉子进程错误: ' + describeError(error));
                    finish(false);
                });
                child.once('close', (code) => {
                    if (code !== 0) {
                        this.ctx.log('debug', '语音听觉失败（exit=' + code + '）: ' + path
                            + (stderr.trim() !== '' ? ' | ' + stderr.trim() : ''));
                        finish(false);
                        return;
                    }
                    finish(true);
                });
                timer = setTimeout(() => {
                    this.ctx.log('warn', '语音听觉超时（' + VOICE_EAR_TIMEOUT_MS + 'ms）: ' + path);
                    try {
                        child.kill();
                    }
                    catch {
                        // 进程已经退出，无需处理
                    }
                    finish(false);
                }, VOICE_EAR_TIMEOUT_MS);
            });
            if (!ok)
                return '';
            const text = (await readFile(outPath, 'utf8')).trim();
            if (text === '') {
                this.ctx.log('debug', '语音听觉输出为空: ' + path);
                return '';
            }
            this.ctx.log('debug', '语音听觉: ' + text);
            return text;
        }
        catch (error) {
            this.ctx.log('warn', '语音听觉读取失败: ' + describeError(error));
            return '';
        }
        finally {
            await unlink(outPath).catch(() => { });
            // 超时被 kill 时 Python 的 finally 来不及跑，这里兜底清掉转码临时目录。
            await rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => { });
        }
    }
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    async expandQuote(messageId) {
        try {
            const data = await this.ctx.call('get_msg', { message_id: Number(messageId) });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            const text = cqUnescape(segmentText(segments, raw));
            if (text.trim() === '')
                return '';
            const name = data.sender?.nickname ?? '';
            return '[引用]' + (name !== '' ? name + ': ' : '') + text;
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，已降级为空引用: ' + describeError(error) });
            return '';
        }
    }
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // The sender-controlled name never becomes the on-disk path (it could
        // otherwise overwrite chat-sessions.json etc.); only a whitelisted
        // extension survives into the fresh media_* name.
        const ext = extForInboundName(name);
        // Streaming size cap for both URL branches below (0 = uncapped).
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        try {
            // 1. Private-chat direct link (works without any container access).
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                try {
                    const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file: with NapCat's file server enabled it returns a `base64`
        //    payload or an http(s) `url`; otherwise a container path we cannot reach.
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                // 2026-11-05 P0：file_size 可能为 0/缺失，不能当唯一依据。解码前
                // 先按 base64 长度预检（膨胀约 4/3，留 16 字节 padding 余量），
                // 超限直接降级为失败占位，绝不把整包解进内存。
                const encoded = String(data.base64);
                if (maxBytes !== undefined && encoded.length > Math.ceil(maxBytes * 4 / 3) + 16) {
                    this.ctx.log('warn', 'qq file base64 too large (' + encoded.length + ' chars), skipping fetch');
                    currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                    return '';
                }
                const localPath = await this.writeMediaFile(Buffer.from(encoded, 'base64'), ext);
                if (localPath !== '') {
                    this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                try {
                    const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    async writeMediaFile(buffer, ext) {
        try {
            // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
            // on a known name (chat-sessions.json etc.) no matter what the sender
            // chose as the file name.
            await this.ctx.media.ensure();
            // 2026-10-28 蓝汐补丁：扩展名以真实字节为准（发送方报的 .jpg 可能
            // 是 PNG/GIF/WebP；错扩展名会让 read_image 直接拒绝）。
            const localPath = this.ctx.media.freshPath(imageExtFromBytes(buffer) ?? ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    async expandForward(forwardId) {
        try {
            // NapCat's get_forward_msg accepts `message_id` or `id`; sending both
            // also covers go-cqhttp-style implementations. Its response nodes are
            // OneBot node segments: { type: 'node', data: { nickname, user_id,
            // message: [...] } } — the flat `sender`/`content` shape is kept as a
            // fallback for other implementations.
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = data.messages ?? [];
            const lines = [];
            const media = [];
            for (const node of nodes) {
                const nodeData = node.data;
                const name = nodeData?.nickname ?? node.sender?.nickname
                    ?? String(nodeData?.user_id ?? node.sender?.user_id ?? '未知');
                const text = nodeContentText(nodeData?.message ?? nodeData?.content ?? node.content, name, media, lines);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0) {
                const reason = nodes.length === 0 ? 'empty-response' : 'no-text-nodes';
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发未展开: ' + reason });
                return { text: '[合并转发 id=' + forwardId + ' 未展开: ' + reason + ']', media };
            }
            return { text: '[合并转发]\n' + lines.join('\n'), media };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败: ' + describeError(error) });
            return { text: '[合并转发 id=' + forwardId + ' 未展开: api-error]', media: [] };
        }
    }
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/**
 * Extract text from a forward-node content (segment array or CQ string).
 * Image segments are collected into `media` and contribute a '[图片]'
 * placeholder (annotated by buildBody like inbound media, `name` carries the
 * owning node's nickname). Nested node segments recurse: their text joins
 * `lines` as their own "name: text" entry instead of being swallowed as
 * '[非文本]'.
 */
function nodeContentText(content, ownerName, media, lines) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            if (s?.type === 'image') {
                media.push({
                    kind: 'image',
                    url: typeof s.data?.url === 'string' && s.data.url !== '' ? s.data.url : undefined,
                    file: typeof s.data?.file === 'string' && s.data.file !== '' ? s.data.file : undefined,
                    name: ownerName,
                });
                return '[图片]';
            }
            if (s?.type === 'node' && typeof s.data === 'object' && s.data !== null) {
                const nested = s.data;
                const nestedName = nested.nickname ?? String(nested.user_id ?? ownerName);
                const nestedText = nodeContentText(nested.message ?? nested.content, nestedName, media, lines);
                if (nestedText !== '')
                    lines.push(nestedName + ': ' + nestedText);
                return '';
            }
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}
