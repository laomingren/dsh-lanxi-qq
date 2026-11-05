/**
 * 断线重连补拉（2026-11-05）。
 *
 * NapCat 在 WS 断线期间不会把消息补推给客户端：连接一断，那段时间收到的
 * 私聊/群聊就只剩服务端历史，不主动拉就永远丢了。本模块在 WS 重连后按
 * 「断开时刻」向 NapCat 的 get_friend_msg_history / get_group_msg_history
 * 拉最近的历史，只把断开之后收到、且不是自己发的消息重新交给入站管线。
 *
 * 边界：只补已有会话的聊天（不新建会话）；群聊只补 @ 了机器人的消息，
 * 免得把整段群聊灌进来；单会话最多 20 条、一次最多 12 个会话。任何一步
 * 失败都只记日志，绝不影响连接本身。
 *
 * @module dsh-lanxi-qq/backfill
 */
import { splitChatId } from './chat.js';
/** 单会话最多补多少条。 */
const MAX_MESSAGES_PER_CHAT = 20;
/** 一次重连最多扫描多少个会话（按最近活跃排序取前 N）。 */
const MAX_CHATS = 12;
/** 断线不足 5 秒不补：这个长度基本漏不了消息，省掉每次重连的一串调用。 */
const MIN_GAP_MS = 5_000;
/** 历史最多回溯 12 小时，断很久也不去翻几十页。 */
const MAX_GAP_MS = 12 * 3600 * 1000;
/** 重连后稍等一下再拉，等 NapCat 的连接状态稳一稳。 */
const START_DELAY_MS = 1_200;
/** 一周没动静的会话不补（早就不看的聊天不替它补历史）。 */
const IDLE_CHAT_MS = 7 * 24 * 3600 * 1000;
/** 拉历史时多要几条：窗口边缘的、自己的、别人的都可能被过滤掉。 */
const HISTORY_SLACK = 10;
/** 一条群消息是否 @ 了机器人（array 格式看 at 段，CQ 字符串兜底）。 */
function mentionsSelf(message, selfId) {
    const id = String(selfId);
    if (id === '')
        return false;
    const segments = Array.isArray(message?.message) ? message.message : [];
    if (segments.some(segment => segment !== null && typeof segment === 'object'
        && segment.type === 'at' && String(segment.data?.qq ?? '') === id))
        return true;
    return typeof message?.raw_message === 'string' && message.raw_message.includes('[CQ:at,qq=' + id);
}
/** 历史消息 → 入站事件：补上 normalize 需要的字段，其余原样带过去。 */
function toEvent(message, kind, target, selfId) {
    const senderId = String(message?.sender?.user_id ?? message?.user_id ?? '');
    const event = {
        ...message,
        post_type: 'message',
        message_type: kind,
        user_id: senderId,
        self_id: selfId === '' || !Number.isFinite(Number(selfId)) ? undefined : Number(selfId),
    };
    if (kind === 'group')
        event.group_id = String(message?.group_id ?? target);
    return event;
}
/**
 * 把断线期间漏掉的消息补回来。
 * @param ctx.connection - OneBot 连接（call(action, params)）。
 * @param ctx.chats - 当前已有会话的聊天表（Map<chatId, chat>）。
 * @param ctx.selfId - 机器人 QQ。
 * @param ctx.since - WS 断开时刻（epoch ms）。
 * @param ctx.handleInbound - 入站入口，第二个参数带 { backfill: true }。
 * @param ctx.log - 日志函数。
 * @param ctx.isStopping - 插件是否正在停止。
 * @returns { skipped: boolean, text: string, scanned?: number, delivered?: number }。
 */
export async function backfillMissedMessages(ctx) {
    const { connection, chats, selfId, since, handleInbound, log, isStopping, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), } = ctx;
    const stamp = now();
    if (!Number.isFinite(since))
        return { skipped: true, text: '没有断线锚点' };
    const gapMs = Math.min(Math.max(0, stamp - since), MAX_GAP_MS);
    if (gapMs < MIN_GAP_MS)
        return { skipped: true, text: '断线 ' + Math.round(gapMs / 1000) + 's，太短不补' };
    if (connection === undefined || connection === null || connection.connected !== true)
        return { skipped: true, text: '连接还没好' };
    // 只补最近 12 小时内收到的（断开更久也只拉这段）。
    const cutoff = Math.max(since, stamp - MAX_GAP_MS);
    const candidates = [];
    for (const [chatId, chat] of chats) {
        const { kind } = splitChatId(chatId);
        if (kind !== 'private' && kind !== 'group')
            continue;
        if (!chatId.startsWith('private:') && !chatId.startsWith('group:'))
            continue;
        if (typeof chat?.lastActivityAt === 'number' && stamp - chat.lastActivityAt > IDLE_CHAT_MS)
            continue;
        candidates.push({ chatId, lastActivityAt: typeof chat?.lastActivityAt === 'number' ? chat.lastActivityAt : 0 });
    }
    candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const picked = candidates.slice(0, MAX_CHATS);
    if (picked.length === 0)
        return { skipped: true, text: '没有可补的会话' };
    await wait(START_DELAY_MS);
    let delivered = 0;
    const detail = [];
    for (const { chatId } of picked) {
        if (isStopping?.() === true)
            break;
        const { kind, target } = splitChatId(chatId);
        const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
        const params = kind === 'group'
            ? { group_id: target, count: MAX_MESSAGES_PER_CHAT + HISTORY_SLACK }
            : { user_id: target, count: MAX_MESSAGES_PER_CHAT + HISTORY_SLACK };
        let data;
        try {
            data = await connection.call(action, params);
        }
        catch (error) {
            log('debug', 'backfill: ' + chatId + ' 拉历史失败: ' + String(error?.message ?? error));
            continue;
        }
        const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
        if (list.length === 0)
            continue;
        const missed = [];
        for (const message of list) {
            const timeMs = Number(message?.time) * 1000;
            if (!Number.isFinite(timeMs) || timeMs <= cutoff)
                continue;
            const senderId = String(message?.sender?.user_id ?? message?.user_id ?? '');
            if (String(selfId) !== '' && senderId === String(selfId))
                continue;
            if (kind === 'group' && !mentionsSelf(message, selfId))
                continue;
            missed.push({ timeMs, message });
        }
        if (missed.length === 0)
            continue;
        missed.sort((a, b) => a.timeMs - b.timeMs);
        const take = missed.slice(-MAX_MESSAGES_PER_CHAT);
        let sent = 0;
        for (const { message } of take) {
            if (isStopping?.() === true)
                break;
            try {
                await handleInbound(toEvent(message, kind, target, String(selfId)), { backfill: true });
                sent += 1;
            }
            catch (error) {
                log('warn', 'backfill: ' + chatId + ' 补投失败: ' + String(error?.message ?? error));
            }
        }
        if (sent > 0) {
            delivered += sent;
            detail.push(chatId + '×' + sent);
        }
    }
    const text = delivered === 0
        ? '断线 ' + Math.round(gapMs / 1000) + 's，扫描 ' + picked.length + ' 个会话，没有漏掉的消息'
        : '断线 ' + Math.round(gapMs / 1000) + 's，补回 ' + delivered + ' 条（' + detail.join('、') + '）';
    return { skipped: false, text, scanned: picked.length, delivered };
}
