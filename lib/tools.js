/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { mapGroupHistoryMessage } from './group-history.js';
import { stripInternalTags, stripPromptEcho, stripSystemContext } from './split.js';
/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'ocr_image',
    'get_ai_characters',
    'send_group_ai_record',
    'send_qzone_msg',
    'delete_qzone_msg',
    // 2026-10-29 蓝汐维护自己的账号（管理员当场同意开权限）：改好友备注、换自己的头像
    'set_friend_remark',
    'set_qq_avatar',
];
/**
 * N3: whitelisted NapCat actions that are proactive writes — they push a
 * file or an AI voice into a chat, so they must pass the same bridge-wide
 * write gate + audit as outbound.sendSegments/sendForward instead of a bare
 * connection.call (which could bypass the actionRatePerMinute hard cap).
 * The whitelist itself is unchanged; this set only decides which actions are gated.
 * 2026-11-03 发布前核查修正：qzone 发送/删除与改好友备注/换头像同样是写操作，
 * 一并纳入本集合（此前走裸 call，绕过频率硬闸与审计，也绕过 qq_qzone_post 的
 * 管理员私聊+每日一条保护）。
 */
const NAPCAT_WRITE_ACTIONS = new Set([
    'upload_group_file',
    'upload_private_file',
    'send_group_ai_record',
    'send_qzone_msg',
    'delete_qzone_msg',
    'set_friend_remark',
    'set_qq_avatar',
]);
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** qq_send_group_msg: @ targets are digit-only QQ numbers — 'all' and any
 * decorated value fail this check, so an accidental @全体 never sends. */
const GROUP_AT_QQ_RE = /^[1-9]\d{4,11}$/;
/** qq_send_group_msg: most @ targets in one message. */
const GROUP_AT_MAX_TARGETS = 10;
/** qq_send_group_msg: a reply target is a decimal NapCat message_id. */
const GROUP_REPLY_ID_RE = /^\d{1,20}$/;
/** qq_send_group_msg: text beyond this length is split at break boundaries. */
const GROUP_TEXT_SOFT_LIMIT = 200;
/** qq_send_group_msg: never split into more than this many text segments. */
const GROUP_TEXT_MAX_PARTS = 3;
/**
 * qq_send_group_msg: normalize the `at` argument. Omitted / empty means "no
 * at"; otherwise it must be 1..10 digit-only QQ numbers, de-duplicated in
 * order. Numbers are tolerated (models echo ids back as numbers) but every
 * entry still has to pass the digit check; anything else throws.
 */
function normalizeAtList(raw) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw))
        throw new Error('qq_send_group_msg: at 必须是 QQ 号数组');
    if (raw.length === 0)
        return [];
    if (raw.length > GROUP_AT_MAX_TARGETS)
        throw new Error('qq_send_group_msg: 一条消息最多 @ ' + GROUP_AT_MAX_TARGETS + ' 人');
    const out = [];
    for (const item of raw) {
        const qq = typeof item === 'number' && Number.isSafeInteger(item) ? String(item)
            : typeof item === 'string' ? item.trim() : '';
        if (!GROUP_AT_QQ_RE.test(qq))
            throw new Error('qq_send_group_msg: at 里只能放纯数字 QQ 号（不支持「' + String(item) + '」）');
        if (!out.includes(qq))
            out.push(qq);
    }
    if (out.length === 0)
        throw new Error('qq_send_group_msg: at 不能为空');
    return out;
}
/**
 * qq_send_group_msg: normalize `reply_to`. Omitted / null / '' means "no
 * quote"; otherwise a 1..20 digit message id (string or integer), anything
 * else throws.
 */
function normalizeReplyId(raw) {
    if (raw === undefined || raw === null || raw === '')
        return undefined;
    const id = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw)
        : typeof raw === 'string' ? raw.trim() : '';
    if (!GROUP_REPLY_ID_RE.test(id))
        throw new Error('qq_send_group_msg: reply_to 必须是消息 id（纯数字）');
    return id;
}
/**
 * qq_send_group_msg: split text longer than GROUP_TEXT_SOFT_LIMIT at newline
 * or full-stop boundaries, greedily packing ~200 chars per segment, and cap
 * the result at GROUP_TEXT_MAX_PARTS segments. The tail keeps whatever does
 * not fit, so no character is dropped.
 */
function splitGroupText(text) {
    if (text.length <= GROUP_TEXT_SOFT_LIMIT)
        return [text];
    const pieces = text.split(/(?<=\n)|(?<=。)/).filter(piece => piece !== '');
    const parts = [];
    let current = '';
    for (const piece of pieces) {
        if (current !== '' && current.length + piece.length > GROUP_TEXT_SOFT_LIMIT) {
            parts.push(current);
            current = piece;
        }
        else {
            current += piece;
        }
    }
    if (current !== '')
        parts.push(current);
    if (parts.length <= GROUP_TEXT_MAX_PARTS)
        return parts;
    return [parts[0], parts[1], parts.slice(2).join('')];
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/**
 * N3: the chat a NapCat write is attributed to in gate logs and audit lines
 * (the gate itself is bridge-wide, not per-chat). Prefers the action's own
 * group_id/user_id, then the calling session's chat, else 'unknown'.
 */
function napcatWriteChatId(bridge, exec, params) {
    const p = params;
    if (typeof p.group_id === 'string' || typeof p.group_id === 'number')
        return 'group:' + String(p.group_id);
    if (typeof p.user_id === 'string' || typeof p.user_id === 'number')
        return 'private:' + String(p.user_id);
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    return 'unknown';
}
/** N3 fallback state — same semantics as the outbound write gate, used only
 * when the live bridge does not expose its outbound pipeline (never expected:
 * registerTools receives the ChatBridge instance itself). */
let fallbackWriteTimes = [];
let fallbackDayKey = '';
let fallbackDayCount = 0;
/** Serialized fallback audit-append chain (order discipline, mirrors
 * OutboundPipeline.auditChain). */
let fallbackAuditChain = Promise.resolve();
/**
 * N3 fallback: equivalent of OutboundPipeline.writeGateRejectReason when the
 * bridge's outbound pipeline is unreachable at runtime. Same caps
 * (actionRatePerMinute/actionRatePerDay, defaults 20/500), same sliding-60s
 * window + calendar-day semantics; rejections are audited, allowed slots are
 * consumed. Returns a non-empty rejection reason, or null when allowed.
 */
function fallbackWriteGate(ctx, chatId, action) {
    const perMinute = ctx.config?.actionRatePerMinute ?? 20;
    const perDay = ctx.config?.actionRatePerDay ?? 500;
    if (perMinute <= 0 && perDay <= 0)
        return null;
    const now = Date.now();
    fallbackWriteTimes = fallbackWriteTimes.filter(t => now - t < 60_000);
    const d = new Date(now);
    const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (fallbackDayKey !== dayKey) {
        fallbackDayKey = dayKey;
        fallbackDayCount = 0;
    }
    if (perMinute > 0 && fallbackWriteTimes.length >= perMinute) {
        const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
        fallbackAuditWrite(ctx, chatId, action, false, reason);
        return reason;
    }
    if (perDay > 0 && fallbackDayCount >= perDay) {
        const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
        fallbackAuditWrite(ctx, chatId, action, false, reason);
        return reason;
    }
    fallbackWriteTimes.push(now);
    fallbackDayCount += 1;
    return null;
}
/**
 * N3 fallback audit: the identical jsonl line (ts/chatId/action/ok/reason)
 * appended to mediaDir/qq-actions.log — the same file
 * OutboundPipeline.auditWrite writes. Fire-and-forget; a write failure only
 * warns and never affects the call path. No-op when auditing is disabled or
 * no mediaDir is configured.
 */
function fallbackAuditWrite(ctx, chatId, action, ok, reason) {
    if (ctx.config?.actionAuditEnabled === false)
        return;
    const dir = ctx.config?.mediaDir;
    if (typeof dir !== 'string' || dir === '')
        return;
    const line = JSON.stringify({ ts: Date.now(), chatId, action, ok, reason }) + '\n';
    fallbackAuditChain = fallbackAuditChain.then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, 'qq-actions.log'), line, 'utf8');
    }).catch(() => undefined);
}
/**
 * N3: check + consume one proactive-write slot for a whitelisted NapCat write
 * action. Prefers the live bridge's OutboundPipeline (identical caps, log
 * lines and qq-actions.log audit); falls back to the in-module equivalent so
 * the hard cap can never be bypassed by shape alone. Returns a non-empty
 * rejection reason, or null when the slot is consumed.
 */
function napcatWriteGate(bridge, ctx, chatId, action) {
    const outbound = bridge.outbound;
    if (outbound !== undefined && typeof outbound.writeGateRejectReason === 'function') {
        return outbound.writeGateRejectReason(chatId, action);
    }
    return fallbackWriteGate(ctx, chatId, action);
}
/**
 * N3: append one proactive-write audit line. Prefers the live outbound
 * pipeline (same file, same chain discipline); the fallback writes the
 * identical line itself. Never throws.
 */
function napcatWriteAudit(bridge, ctx, chatId, action, ok, reason) {
    const outbound = bridge.outbound;
    if (outbound !== undefined && typeof outbound.auditWrite === 'function') {
        outbound.auditWrite(chatId, action, ok, reason);
        return;
    }
    fallbackAuditWrite(ctx, chatId, action, ok, reason);
}
/** Qzone: local calendar day key (host clock, same day boundary as the write gate). */
function qzoneDayKey(now = new Date()) {
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}
/** Qzone: state file path inside mediaDir; undefined when no mediaDir (cap disabled). */
function qzoneStatePath(bridge) {
    const dir = bridge.deps?.config?.mediaDir;
    return typeof dir === 'string' && dir !== '' ? join(dir, 'qzone-state.json') : undefined;
}
/** Qzone: last posted day key; a missing or corrupt state file reads as ''. */
async function qzoneLastDay(statePath) {
    if (statePath === undefined)
        return '';
    try {
        const parsed = JSON.parse(await readFile(statePath, 'utf8'));
        return typeof parsed.lastDay === 'string' ? parsed.lastDay : '';
    }
    catch {
        return '';
    }
}
/** Qzone: reject unless the calling session is a private chat with an admin.
 * Reads policy through the bridge deps — a tool context only exposes `config`
 * after an explicit inject declaration, so never touch ctx.config here. */
function qzoneAdminChat(bridge, exec) {
    const sessionId = exec.agent?.session.id;
    const chatId = sessionId !== undefined ? bridge.chatForSession(String(sessionId)) : undefined;
    if (chatId === undefined)
        throw new Error('qq_qzone_post: 无法确定调用会话');
    const parts = splitChatId(chatId);
    const admins = Array.isArray(bridge.deps?.policy?.adminUsers) ? bridge.deps.policy.adminUsers : [];
    if (parts.kind !== 'private' || !admins.includes(parts.target)) {
        throw new Error('qq_qzone_post: 仅管理员私聊可用');
    }
    return chatId;
}
/** Qzone: fence local image paths to the caller's outbound media roots. */
async function qzoneImagePaths(bridge, exec, images) {
    if (images.length === 0)
        return [];
    const roots = (await mediaRoots(bridge, exec)).map(r => r.replace(/[\\/]+$/, ''));
    const out = [];
    for (const raw of images) {
        if (typeof raw !== 'string' || raw === '')
            throw new Error('qq_qzone_post: images 里只能放本地路径字符串');
        if (!isAbsolute(raw))
            throw new Error('qq_qzone_post: 图片必须是绝对路径：' + raw);
        let real;
        try {
            real = await realpath(raw);
        }
        catch {
            throw new Error('qq_qzone_post: 图片不存在：' + raw);
        }
        const allowed = roots.some(r => real === r || real.startsWith(r + '\\') || real.startsWith(r + '/'));
        if (!allowed)
            throw new Error('qq_qzone_post: 图片不在允许的媒体目录内：' + raw);
        out.push(real);
    }
    return out;
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(tool));
    };
    // 2026-10-31: a legal "stay quiet" action. Without it a turn had no silent
    // exit: DSH treats an empty assistant message as EMPTY_RESPONSE and retries
    // up to 5 times, while every assistant text is shipped to QQ as an interim
    // message. The only way out was to write a "I'm staying quiet" line, which
    // then got posted verbatim. This tool concludes the turn without emitting
    // any QQ text.
    register(defineTool({
        name: 'qq_no_reply',
        description: '这一轮不回复。群里的消息跟你无关、或者你确实没话可接时调用它结束回合——不要改用文字说明自己在保持安静（那些文字会被原样发到 QQ）。同一轮里不要再输出任何正文。',
        parameters: {},
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const e = exec;
            if (e !== undefined && e !== null && typeof e.concludeTurn === 'function')
                e.concludeTurn();
            return { replied: false };
        },
    }));
    register(defineTool({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                // #12: sendSegments pushes raw segments — only sendToChat cleans
                // outbound text. Strip the internal host/session markup and the
                // system-context tail here, exactly like outbound.js does for
                // every other outbound text, so an echoed <user_message> block
                // or a `Time sampled while preparing` line never reaches QQ.
                const caption = stripSystemContext(stripInternalTags(stripPromptEcho(a.caption)));
                if (caption !== '')
                    segments.push({ type: 'text', data: { text: caption } });
            }
            for (const source of sources) {
                if (isUrl(source)) {
                    segments.push({ type: 'image', data: { url: source } });
                }
                else {
                    segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } });
                }
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_voice: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            // #11: split on both separators — on Windows a path like
            // D:\media\x.png has no '/', so the old split('/') left the whole
            // path as the QQ file name.
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split(/[\\/]/).pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_group_msg',
        description: '在群里发一条文本消息，可同时 @ 群成员（1~10 个纯数字 QQ 号）和/或引用回复某条群消息。只能在群聊里用，目标群固定为当前会话，不能指定别的会话；用这条发过之后，本轮不要再把同样的正文重复一遍。',
        parameters: {
            text: {
                type: 'string',
                required: true,
                description: '消息正文（纯文本，1~2000 字；超过 200 字会按换行/句号自动拆成最多 3 段）',
            },
            at: {
                type: 'array',
                items: { type: 'string' },
                description: '要 @ 的群成员 QQ 号（纯数字，1~10 个，自动去重；不支持 all），省略或空数组表示不 @ 人',
            },
            reply_to: {
                oneOf: [{ type: 'string' }, { type: 'number' }],
                description: '要引用的群消息 message_id（纯数字；字符串或数字都接受，取自 qq_group_history 返回的 message_id），省略表示不引用',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            // No chat_id parameter by design: the target can only come from
            // the calling session, so a cross-chat send is physically
            // impossible (stricter than the guard's pin-chat check).
            let chatId;
            try {
                chatId = resolveChat(bridge, exec, undefined);
            }
            catch {
                throw new Error('qq_send_group_msg: 当前会话没有绑定 QQ 群，这个只能在群里用');
            }
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('这个只能在群里用');
            // 2026-11-02 蓝汐补丁：模型可能把喂给它的上下文（群前缀 + 群历史块 +
            // 思考过程）当成正文塞进这个参数——stripInternalTags 吃得掉边界内的
            // <user_message>，边界外的前缀/回显要靠 stripPromptEcho 截掉。
            const rawText = typeof a.text === 'string' ? a.text : '';
            const text = stripSystemContext(stripInternalTags(stripPromptEcho(rawText))).trim();
            if (text === '')
                throw new Error(rawText.trim() === ''
                    ? 'qq_send_group_msg: text 不能为空'
                    : 'qq_send_group_msg: text 整条都是系统上下文/历史记录的回显，已拦下；只发你自己的回复正文');
            if (text.length > 2000)
                throw new Error('qq_send_group_msg: text 过长（上限 2000 字）');
            const targets = normalizeAtList(a.at);
            const replyTo = normalizeReplyId(a.reply_to);
            const segments = [];
            // reply first, then at, then text. sendSegments(chatId, segments)
            // takes no options, so the quote is built here in the exact shape
            // outbound.js:341 prepends for sendToChat's replyTo path.
            if (replyTo !== undefined)
                segments.push({ type: 'reply', data: { id: replyTo } });
            for (const qq of targets)
                segments.push({ type: 'at', data: { qq } });
            for (const part of splitGroupText(text))
                segments.push({ type: 'text', data: { text: part } });
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                // N4: merged-forward nodes go straight to send_forward_msg with
                // no cleaning — the same leak surface as the caption (#12).
                // stripInternalTags also drops '[图片:<local path>]' placeholder
                // lines, so an echoed media placeholder never exposes a local
                // path. A node whose content is pure internal markup now fails
                // the non-empty check below instead of shipping the leak.
                const content = typeof node.content === 'string'
                    ? stripSystemContext(stripInternalTags(stripPromptEcho(node.content)))
                    : '';
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content,
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    register(defineTool({
        name: 'qq_qzone_post',
        description: '在 QQ 空间（Qzone）发一条说说：正文 + 最多 9 张本地图片。仅管理员私聊可用，同一天最多一条，confirm 必须为 true 才真正发出。',
        parameters: {
            content: { type: 'string', required: true, description: '说说正文（纯文本，上限 2000 字）' },
            images: { type: 'array', items: { type: 'string' }, description: '本地图片绝对路径，最多 9 张（可选，必须在允许的媒体目录内）' },
            visibility: { type: 'string', description: '可见范围：public 所有人 / friends 好友（默认）/ private 仅自己' },
            confirm: { type: 'boolean', description: '必须显式传 true，表示确实是本人要求发这条说说' },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: value.tid != null ? '已发说说（tid=' + value.tid + '）' : '已发说说' }] },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const a = args;
            if (a.confirm !== true)
                throw new Error('qq_qzone_post: 需要 confirm: true（防止误发）');
            const content = typeof a.content === 'string' ? a.content.trim() : '';
            if (content === '')
                throw new Error('qq_qzone_post: content 不能为空');
            if (content.length > 2000)
                throw new Error('qq_qzone_post: content 过长（上限 2000 字）');
            const rawImages = Array.isArray(a.images) ? a.images.filter(i => typeof i === 'string') : [];
            if (rawImages.length > 9)
                throw new Error('qq_qzone_post: 一次最多 9 张图片');
            qzoneAdminChat(bridge, exec);
            const statePath = qzoneStatePath(bridge);
            const today = qzoneDayKey();
            if (await qzoneLastDay(statePath) === today)
                throw new Error('qq_qzone_post: 今天（' + today + '）已经发过一条说说了，一天一条上限');
            const images = await qzoneImagePaths(bridge, exec, rawImages);
            const visibility = a.visibility === 'public' ? 1 : a.visibility === 'private' ? 64 : 4;
            const chatId = 'qzone:' + (typeof a.visibility === 'string' && a.visibility !== '' ? a.visibility : 'friends');
            const outbound = bridge.outbound;
            if (outbound !== undefined && typeof outbound.writeGateRejectReason === 'function') {
                const reject = outbound.writeGateRejectReason(chatId, 'send_qzone_msg');
                if (reject !== null)
                    throw new Error('qq_qzone_post: ' + reject);
            }
            const audit = (ok, reason) => {
                if (outbound !== undefined && typeof outbound.auditWrite === 'function')
                    outbound.auditWrite(chatId, 'send_qzone_msg', ok, reason);
            };
            try {
                const result = await connection.call('send_qzone_msg', { content, images, ugc_right: visibility });
                audit(true, '调用成功');
                const tid = typeof result?.tid === 'string' ? result.tid : null;
                if (statePath !== undefined) {
                    await writeFile(statePath, JSON.stringify({ lastDay: today, tid, visibility: chatId, at: new Date().toISOString() }) + '\n', 'utf8').catch(() => undefined);
                }
                return { sent: true, tid, visibility: chatId };
            }
            catch (error) {
                audit(false, '调用失败: ' + (error instanceof Error ? error.message : String(error)));
                throw error;
            }
        },
    }));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action 参数（JSON 对象）',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            if (!NAPCAT_WRITE_ACTIONS.has(a.action)) {
                return await connection.call(a.action, params);
            }
            // N3: upload_group_file / upload_private_file / send_group_ai_record
            // are proactive writes — they go through the same write gate and
            // audit as outbound.sendSegments/sendForward, never a bare
            // connection.call that could bypass the 20/min hard cap.
            const chatId = napcatWriteChatId(bridge, exec, params);
            const reject = napcatWriteGate(bridge, ctx, chatId, a.action);
            if (reject !== null) {
                throw new Error('qq_napcat_api: ' + reject);
            }
            try {
                const result = await connection.call(a.action, params);
                napcatWriteAudit(bridge, ctx, chatId, a.action, true, '调用成功');
                return result;
            }
            catch (error) {
                napcatWriteAudit(bridge, ctx, chatId, a.action, false, '调用失败: ' + (error instanceof Error ? error.message : String(error)));
                throw error;
            }
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                if (list.length === 0)
                    return [{ type: 'text', text: '这附近没有消息。' }];
                const pad = (n) => String(n).padStart(2, '0');
                const clock = (raw) => {
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n <= 0)
                        return '--:--';
                    const d = new Date(n * 1000);
                    return pad(d.getHours()) + ':' + pad(d.getMinutes());
                };
                const lines = [];
                let used = 0;
                for (const item of list) {
                    const row = item;
                    let body = String(row.text ?? '').replace(/\s+/g, ' ').trim();
                    if (body === '')
                        body = '（无文本）';
                    if (body.length > 300)
                        body = body.slice(0, 300) + '…';
                    // Degenerate rows (system notices without sender/id) must
                    // not render as a bare '#' or empty '()': drop the missing
                    // pieces, fall back nickname → user_id → 某人. When the
                    // name IS the id (execute's own fallback chain produces
                    // exactly that), the id is not repeated in parens.
                    let name = String(row.nickname ?? '');
                    let uid = String(row.user_id ?? '');
                    if (name === '' || name === uid) {
                        if (uid !== '') {
                            name = uid;
                            uid = '';
                        }
                        else {
                            name = '某人';
                        }
                    }
                    const mid = String(row.message_id ?? '');
                    let line = '[' + clock(row.time) + '] ' + name;
                    if (uid !== '')
                        line += '(' + uid + ')';
                    if (mid !== '')
                        line += ' #' + mid;
                    line += ': ' + body;
                    if (used + line.length > 6000) {
                        lines.push('…（还有 ' + (list.length - lines.length) + ' 条，需要更早的用 message_seq 往前翻）');
                        break;
                    }
                    lines.push(line);
                    used += line.length + 1;
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            if (typeof a.message_seq === 'number')
                params.message_seq = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            // 2026-11-02：映射逻辑抽到 lib/group-history.js，与入站的群历史上下文
            // （群回合自动注入最近 20 条）共用同一套 NapCat 响应解析口径。
            return messages.map(mapGroupHistoryMessage);
        },
    }));
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
