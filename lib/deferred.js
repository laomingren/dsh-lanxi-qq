/**
 * Deferred delivery（T3/P2 超时后结果补发）：等待模型回复超时后不放弃回合——
 * 把仍在运行的回合登记进补发注册表（chatId/sessionId/traceId/超时时刻），
 * 继续监听该会话的 assistant/message（静音捕获最终文字，不再插播 interim/
 * 交互卡片）与 turn/end（兑现补发）；完成后向原聊天补发最终文字
 * （「（超时补发）」前缀，走既有 outbound 管线的分段/t2i 规则）。
 *
 * 语义对齐 dsh-im「超时后的结果补发」（research/dsh-im-readme-fetched.md
 * L91-95）：
 * - 发送明确失败最多尝试 3 次（退避 2s/10s）；OneBot 动作超时或非网关错误
 *   视为「结果不确定」（消息可能已到达 QQ），保留记录并停止自动重试防重复。
 * - 注册表逐行 JSONL 落盘 mediaDir（deferred-delivery.jsonl），写纪律对齐
 *   registry.ts：唯一 tmp 后缀 + rename 原子写、逐行损坏降级（坏行跳过不炸
 *   宿主）、文件缺失 = 全新启动。插件启动加载未完结条目恢复跟踪（该会话的
 *   下一次 turn/end 兑现补发；/stop 显式终止该聊天的跟踪）。
 * - 边界：只补最终文字与终态通知——不重放审批/提问卡/文件工具调用/图片；
 *   回合正常完成（未超时）零注册表写入、零补发（对基线无行为差异面）。
 *
 * 时钟与定时器经构造器注入（vitest 时序纪律：假时钟注入 + vi.waitFor 文本
 * 确定性等待），默认回落到全局 setTimeout/Date.now。
 * @module dsh-onebot/deferred
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TRACE_REASONS } from './trace.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { describeError } from './errors.js';
import { failureRefSuffix } from './ref.js';
import { visibleAssistantText } from './split.js';
/** The registry file name inside the media dir (one JSON entry per line). */
export const DEFERRED_REGISTRY_FILE = 'deferred-delivery.jsonl';
/** Default wait-for-model-reply timeout (ms): conservative 10 minutes. */
export const DEFAULT_DEFERRED_TIMEOUT_MS = 600_000;
/** Max total send attempts per entry（含首次；第 4 次永不尝试）。 */
export const DEFERRED_MAX_SEND_ATTEMPTS = 3;
/** Backoff before retry attempts 2 and 3 (ms). */
export const DEFERRED_RETRY_BACKOFF_MS = [2_000, 10_000];
/** Cap of tracked entries; the oldest terminal entries are pruned beyond it. */
export const DEFERRED_MAX_ENTRIES = 200;
/** Pending entries older than this are auto-cancelled at load（宿主进程级
 * 重启后原回合已不存在，超过该时长仍未兑现的条目视为死回合）。 */
export const DEFERRED_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The「（超时补发）」prefix prepended to every deferred delivery. */
export const DEFERRED_PREFIX = '（超时补发）\n';
/** Send-failure classification: 'retryable' = the message definitively did
 * NOT reach QQ（断连 / 网关明确拒绝）→ bounded retry; 'uncertain' = the
 * action timed out or failed outside the gateway — the message may still
 * have arrived, so the record is kept and auto-retry stops（防重复消息）. */
export function classifySendError(error) {
    if (error instanceof OneBotNotConnectedError)
        return 'retryable';
    if (error instanceof OneBotActionError) {
        return /timed out/i.test(error.message) ? 'uncertain' : 'retryable';
    }
    return 'uncertain';
}
/** Text-only extraction（不重放媒体/工具调用/卡片：只取可见正文 text 块；
 * 推理块、思考块与系统时间戳上下文一律丢弃）. */
function textOnly(message) {
    try {
        return visibleAssistantText(message);
    }
    catch {
        return '';
    }
}
/** Build the deferred delivery text for a finished turn. T4 (P3): an error
 * ending carries the turn's MF- reference so the补发 terminal notice and the
 * trace/log/healthcheck surfaces share one number. */
export function buildDeferredText(entry, reason) {
    if (reason?.kind === 'error') {
        return DEFERRED_PREFIX + '任务已结束：运行出错：' + (reason.error?.message ?? '未知错误') + failureRefSuffix(entry.ref);
    }
    const text = (entry.resultText ?? '').trim();
    if (text === '')
        return DEFERRED_PREFIX + '任务已完成，但没有产生文字结果。';
    return DEFERRED_PREFIX + text;
}
/** Strict-ish loader validation: a line that is not a usable entry is skipped
 * （损坏降级）instead of failing the whole file. */
function sanitizeEntry(raw) {
    if (raw === null || typeof raw !== 'object')
        return null;
    const rec = raw;
    if (typeof rec.chatId !== 'string' || rec.chatId === '')
        return null;
    if (typeof rec.sessionId !== 'string' || rec.sessionId === '')
        return null;
    const states = ['pending', 'delivered', 'failed', 'uncertain', 'cancelled'];
    if (typeof rec.state !== 'string' || !states.includes(rec.state))
        return null;
    const registeredAt = typeof rec.registeredAt === 'number' && Number.isFinite(rec.registeredAt) ? rec.registeredAt : 0;
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : registeredAt;
    const entry = {
        chatId: rec.chatId,
        sessionId: rec.sessionId,
        registeredAt,
        updatedAt,
        attempts: typeof rec.attempts === 'number' && Number.isFinite(rec.attempts) ? rec.attempts : 0,
        state: rec.state,
    };
    if (typeof rec.traceId === 'string' && rec.traceId !== '')
        entry.traceId = rec.traceId;
    if (typeof rec.ref === 'string' && rec.ref !== '')
        entry.ref = rec.ref;
    if (typeof rec.reason === 'string' && rec.reason !== '')
        entry.reason = rec.reason;
    if (typeof rec.resultText === 'string' && rec.resultText !== '')
        entry.resultText = rec.resultText;
    return entry;
}
/**
 * The deferred-delivery tracker: timeout timers, the JSONL registry, bounded
 * send retries and the restart-recovery load. Created by the ChatBridge
 * constructor; the bridge feeds it session events and the /stop command
 * cancels a chat's tracking.
 */
export class DeferredDelivery {
    ctx;
    now;
    scheduleFn;
    cancelFn;
    /** Tracked entries by session id（一个会话同一时刻至多一个运行回合）。 */
    entries = new Map();
    /** Per-chat current session as observed at turn/start（B3 兑现前校验用：
     * 重启恢复的 pending 条目若已不属于该 chat 的当前会话，兑现即错配）。 */
    chatSessions = new Map();
    /** Per-session silent-wait timers（每次模型输出重置；turn/end 解除）。 */
    timers = new Map();
    /** Serialized registry-write chain（并发 save 不交错）。 */
    saveChain = Promise.resolve();
    /** Session ids with a delivery loop in flight（防双发 in-flight 守卫：
     * 重试退避窗口内新回合 turn/end 不得再起第二条重试循环）。 */
    delivering = new Set();
    /** loadPersisted 恢复的 pending 条目的 session ids（旧进程残留标记）：
     * 这些条目的原回合已随上次宿主进程消亡，同会话新回合一开始即按死回合
     * 终止（B3 闭环，见 onTurnStart）——否则新回合 turn/end 会把死回合的旧
     * 文字补到不相关回合，而会话 id 不变时 onTurnEnd 的 chatSessions 校验
     * 闸拦不住这一错配。纯运行时标记，不落盘（save 只序列化 entry 本体）。 */
    restoredPending = new Set();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.now = options.now ?? (() => Date.now());
        this.scheduleFn = options.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());
        this.cancelFn = options.cancel ?? (handle => clearTimeout(handle));
    }
    // ------------------------------------------------------------ turn wiring
    /** turn/start: arm (or re-arm) the silent-wait window for the session.
     * #7（sat-a）：曾有「pending 条目不 re-arm」早退——补发重试退避窗口
     * （delivering，2s/10s 约 12s）或重启恢复的 pending 条目期间新开的回合
     * 不 arm，退避窗口结束后该回合再无超时保护。现一律 arm：onTimeout 对
     * pending 条目自带早退（不重复登记、不重复提醒），arm 无副作用；条目
     * 转终态后仍在跑的新回合超时，仍能登记新条目。
     * B3（sat-b2）闭环：重启恢复的 pending 条目带旧进程标记，同会话新回合
     * 一开始即取消（cancelRestoredPending）——原回合已随上次进程消亡，旧
     * 文字绝无正确兑现可能。置于 timeoutMs 检查之前：补发功能被关闭时
     * 同样不得补投旧进程文字。 */
    onTurnStart(chatId, sessionId) {
        this.clearTimer(sessionId);
        this.cancelRestoredPending(chatId, sessionId);
        if (this.ctx.timeoutMs <= 0)
            return;
        this.chatSessions.set(chatId, sessionId);
        this.armTimer(chatId, sessionId);
    }
    /** B3 闭环：终止 loadPersisted 恢复的（旧进程）pending 条目——该回合的
     * 文字属于已消亡的上个进程，同会话新回合开始后绝不允许被补发到不相关
     * 回合。无标记 / 条目已不存在 / 已终态时安全 no-op（/stop 先行取消的
     * 条目只消费标记，不重复 trace/save）。 */
    cancelRestoredPending(chatId, sessionId) {
        if (!this.restoredPending.has(sessionId))
            return;
        this.restoredPending.delete(sessionId);
        const entry = this.entries.get(sessionId);
        if (entry === undefined || entry.state !== 'pending')
            return;
        entry.state = 'cancelled';
        entry.reason = '该补发跟踪来自上一个进程（重启恢复），原回合已不存在；同会话已开始新回合，按死回合终止，避免旧文字补到不相关回合';
        entry.updatedAt = this.now();
        this.ctx.log('warn', '超时补发条目为旧进程残留且同会话已开新回合，已终止: chat=' + chatId + ' session=' + sessionId);
        this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredCancelled, data: { sessionId } });
        void this.save();
    }
    /** assistant/message: returns true when the message is consumed by deferred
     * tracking（静音：不插播 interim、不转卡片，只捕获 text 块作为最终文字）。
     * Otherwise resets the silent-wait window（模型有输出 = 用户并非在干等）。
     * N1（sat-a，中·消息不丢）：delivering（首发失败后的 2s/10s 重试退避，
     * 约 12s）期间不认领同会话新回合的文字——在途补发循环只持有回合 A 收尾
     * 时构建的 text 副本，覆写 resultText 毫无意义还会把回合 B 的文字吞进
     * 一个永不被投递的字段；故 delivering 期间直接走下方基线分支：不静音
     * （bridge 转交 interim 正常插播/转卡）、turn/end 时 interim 的 final
     * 路径正常刷新回合 B 的最终文字（sendToChat queuable 既有链路），错误
     * ⚠️ 也照常走基线。零双发：回合 A 的文字仍只由在途循环的那一份副本投递。 */
    onAssistantMessage(chatId, sessionId, message) {
        const entry = this.entries.get(sessionId);
        if (entry !== undefined && entry.state === 'pending' && !this.delivering.has(sessionId)) {
            const text = textOnly(message).trim();
            if (text !== '')
                entry.resultText = text;
            return true;
        }
        if (this.ctx.timeoutMs > 0 && this.timers.has(sessionId)) {
            this.armTimer(chatId, sessionId);
        }
        return false;
    }
    /** turn/end: cancel the silent-wait timer; complete a pending entry by
     * delivering the final text (async, bounded retries). `ref` is the turn's
     * fault reference（T4：bridge 在错误回合 mint 的 MF- 号——终态补发文本与
     * trace 携带同号；正常回合为 undefined）. Returns true when
     * the turn was under deferred tracking AND its ending is success-class
     * （bridge 据此抑制常规错误通知——终态通知由补发通道送达，避免同一故障
     * 双消息）。两类例外一律返回 false、错误照常走基线 ⚠️ 通知（不静默吞
     * 掉）：terminal entries（delivered/failed/uncertain/cancelled，只是可
     * 观测快照）；以及 in-flight 让位路径上的收尾——delivering 期间同会话
     * 新回合已自 assistant/message 起整体交还基线管线（见 onAssistantMessage
     * 的 N1 说明），其最终文字与错误 ⚠️ 都不经补发通道，本函数不再认领。 */
    onTurnEnd(chatId, sessionId, reason, ref) {
        this.clearTimer(sessionId);
        const entry = this.entries.get(sessionId);
        if (entry === undefined)
            return false;
        if (entry.state !== 'pending')
            return false;
        // B3（sat-b2）：兑现前校验条目仍属于该 chat 的当前会话。重启恢复的
        // pending 条目其原回合已随上次进程消亡，一旦该 chat 的当前会话已切换
        // （/new、/session、恢复失败重建），旧条目的文字绝不补发到不相关回合
        // ——按错配置 cancelled。当前会话取 tracker 在 onTurnStart 的观测值；
        // bridge 派发前已校验 chat.sessionId===session.id，此闸为纵深防御
        // （无观测值即跳过，不误杀）。
        const currentSessionId = this.chatSessions.get(chatId);
        if (currentSessionId !== undefined && currentSessionId !== entry.sessionId) {
            entry.state = 'cancelled';
            entry.reason = '补发跟踪的会话（' + entry.sessionId + '）已不是该聊天的当前会话（' + currentSessionId + '），按错配终止，避免补发到不相关回合';
            entry.updatedAt = this.now();
            this.ctx.log('warn', '超时补发条目会话错配，已终止: chat=' + chatId + ' entry.session=' + entry.sessionId + ' current=' + currentSessionId);
            this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredCancelled, data: { sessionId: entry.sessionId } });
            void this.save();
            return false;
        }
        if (ref !== undefined)
            entry.ref = ref;
        if (this.delivering.has(sessionId)) {
            // 防双发 in-flight 守卫：首发失败后的重试退避窗口内同会话新回合收尾，
            // 让位给在途补发循环——不并发启动第二条重试循环（否则同一 entry 双发、
            // attempts/终态互相覆写）。
            // N1（sat-a）配套：该新回合（回合 B）自 assistant/message 起已整体交还
            // 基线管线（不静音、不覆写 resultText，见 onAssistantMessage），其最终
            // 文字由 interim 的 final 路径送达、错误 ⚠️ 照常走基线——在途循环只
            // 持有回合 A 收尾时构建的 text 副本，绝不能用它冒充回合 B 的终态。
            // 故本分支不再认领回合 B：一律返回 false（成功类收尾也不再声称
            // tracked，避免把回合 B 的终态绑到回合 A 的补发通道上）。
            entry.updatedAt = this.now();
            return false;
        }
        const text = buildDeferredText(entry, reason);
        entry.updatedAt = this.now();
        void this.deliverWithRetry(entry, text);
        return true;
    }
    /** /stop：显式终止该聊天的补发跟踪（pending 条目转 cancelled、计时器解除）；
     * 其他聊天不受影响。无运行中生成时也安全（清理陈旧条目）。 */
    cancelChat(chatId) {
        this.chatSessions.delete(chatId);
        for (const [sessionId, timer] of [...this.timers]) {
            if (timer.chatId === chatId)
                this.clearTimer(sessionId);
        }
        let changed = false;
        for (const entry of this.entries.values()) {
            if (entry.chatId !== chatId || entry.state !== 'pending')
                continue;
            entry.state = 'cancelled';
            entry.reason = '用户已停止该聊天的生成（/stop），补发跟踪终止';
            entry.updatedAt = this.now();
            this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredCancelled, data: { sessionId: entry.sessionId } });
            changed = true;
        }
        if (changed) {
            this.ctx.log('info', '已终止该聊天的超时补发跟踪: ' + chatId);
            void this.save();
        }
    }
    /** Plugin stop: disarm every timer; entries stay as-is（pending 条目已
     * 落盘，重启后恢复跟踪）。 */
    stopAll() {
        for (const sessionId of [...this.timers.keys()])
            this.clearTimer(sessionId);
    }
    // ------------------------------------------------------------ timeout
    armTimer(chatId, sessionId) {
        this.clearTimer(sessionId);
        const record = { chatId, handle: undefined, cancelled: false };
        record.handle = this.scheduleFn(() => {
            if (record.cancelled)
                return;
            this.timers.delete(sessionId);
            this.onTimeout(chatId, sessionId);
        }, this.ctx.timeoutMs);
        if (!record.cancelled)
            this.timers.set(sessionId, record);
    }
    clearTimer(sessionId) {
        const timer = this.timers.get(sessionId);
        if (timer === undefined)
            return;
        timer.cancelled = true;
        this.cancelFn(timer.handle);
        this.timers.delete(sessionId);
    }
    /** The silent window elapsed while the turn is still running: register the
     * entry, tell the chat, and mute the turn（takePendingText 清空 loopPending，
     * 正常终局路径不再有内容可刷）。 */
    onTimeout(chatId, sessionId) {
        if (this.ctx.isStopping())
            return;
        if (this.entries.get(sessionId)?.state === 'pending')
            return;
        if (!this.ctx.isTurnRunning(chatId))
            return;
        const at = this.now();
        const entry = {
            chatId,
            sessionId,
            registeredAt: at,
            updatedAt: at,
            attempts: 0,
            state: 'pending',
        };
        const traceId = this.ctx.traceIdFor?.(chatId);
        if (traceId !== undefined)
            entry.traceId = traceId;
        const pending = this.ctx.takePendingText(chatId);
        if (pending !== null && pending.trim() !== '')
            entry.resultText = pending;
        this.entries.set(sessionId, entry);
        this.prune();
        void this.save();
        this.ctx.log('info', '等待模型回复超时，已登记超时补发跟踪: chat=' + chatId + ' session=' + sessionId);
        this.ctx.trace?.(chatId, { stage: 'notice', ok: true, reason: TRACE_REASONS.deferredRegistered, data: { sessionId } });
        const seconds = Math.round(this.ctx.timeoutMs / 1000);
        const notice = '⏳ 等待模型回复超时（已静默等待约 ' + seconds + ' 秒），任务仍在后台运行；完成后将自动补发最终结果。如需停止请发送 /stop。';
        void this.ctx.sendToChat(chatId, notice, { queuable: true }).catch((error) => {
            this.ctx.log('debug', '超时提醒发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'notice', ok: false, reason: TRACE_REASONS.deferredNoticeFailed + ': ' + describeError(error) });
        });
    }
    // ------------------------------------------------------------ delivery
    async deliverWithRetry(entry, text) {
        this.delivering.add(entry.sessionId);
        try {
            for (let attempt = 1; attempt <= DEFERRED_MAX_SEND_ATTEMPTS; attempt += 1) {
                if (this.ctx.isStopping())
                    return; // 条目保持 pending：重启后恢复跟踪续投
                entry.attempts = attempt;
                try {
                    // #2（sat-a B1）：补发改 queuable——断连时不再立即抛错走
                    // 2s/10s 三次重试后 failed，而是借 B6 离线队列续投（重连后
                    // drainPendingSends 补投，TTL 5 分钟）。
                    await this.ctx.sendToChat(entry.chatId, text, { queuable: true });
                }
                catch (error) {
                    const described = describeError(error);
                    if (classifySendError(error) === 'uncertain') {
                        entry.state = 'uncertain';
                        entry.reason = '发送结果不确定（' + described + '），已保留记录并停止自动重试，避免重复消息';
                        entry.updatedAt = this.now();
                        this.ctx.log('warn', '超时补发第 ' + attempt + ' 次发送结果不确定，停止自动重试: chat=' + entry.chatId + ' ' + described);
                        this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredUncertain + ': ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                        void this.save();
                        // #2（sat-a B1）：uncertain 是终态，仅落日志/trace/注册表时
                        // 用户侧零感知（bridge 对 deferredTracked 回合还会抑制常规
                        // ⚠️，错误回合双静默）。可排队：补发失败常伴断连，借 B6 续投。
                        void this.ctx.sendToChat(entry.chatId, '⚠️ 有一条任务结果的超时补发发送结果不确定（消息可能已到达 QQ），已停止自动重试；若始终没有收到，请重新发送消息。', { queuable: true }).catch((noticeError) => {
                            this.ctx.log('debug', '超时补发终态通知发送失败: ' + describeError(noticeError));
                            this.ctx.trace?.(entry.chatId, { stage: 'notice', ok: false, reason: TRACE_REASONS.deferredNoticeFailed + ': ' + describeError(noticeError) });
                        });
                        return;
                    }
                    if (attempt < DEFERRED_MAX_SEND_ATTEMPTS) {
                        const backoff = DEFERRED_RETRY_BACKOFF_MS[attempt - 1] ?? DEFERRED_RETRY_BACKOFF_MS[DEFERRED_RETRY_BACKOFF_MS.length - 1] ?? 10_000;
                        this.ctx.log('debug', '超时补发第 ' + attempt + ' 次发送明确失败，' + Math.round(backoff / 1000) + 's 后重试: ' + described);
                        this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredRetryable + '（第 ' + attempt + '/' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次）: ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                        await this.sleep(backoff);
                        continue;
                    }
                    entry.state = 'failed';
                    entry.reason = '发送明确失败，已尝试 ' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次（最后错误: ' + described + '）';
                    entry.updatedAt = this.now();
                    this.ctx.log('warn', '超时补发连续 ' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次发送失败，停止自动重试: chat=' + entry.chatId + ' ' + described);
                    this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.deferredExhausted + ': ' + described, data: { sessionId: entry.sessionId, attempt, ...(entry.ref !== undefined ? { ref: entry.ref } : {}) } });
                    void this.save();
                    // #2（sat-a B1）：failed 同为终态，补一条简短告警，避免承诺的
                    // 「（超时补发）」永不到达且用户零感知。
                    void this.ctx.sendToChat(entry.chatId, '⚠️ 有一条任务结果的超时补发连续 ' + DEFERRED_MAX_SEND_ATTEMPTS + ' 次发送失败，未能送达；请重新发送消息重新获取结果。', { queuable: true }).catch((noticeError) => {
                        this.ctx.log('debug', '超时补发终态通知发送失败: ' + describeError(noticeError));
                        this.ctx.trace?.(entry.chatId, { stage: 'notice', ok: false, reason: TRACE_REASONS.deferredNoticeFailed + ': ' + describeError(noticeError) });
                    });
                    return;
                }
                entry.state = 'delivered';
                entry.reason = '超时补发已送达';
                entry.updatedAt = this.now();
                this.ctx.log('info', '超时补发已送达: chat=' + entry.chatId + ' session=' + entry.sessionId);
                this.ctx.trace?.(entry.chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.deferredDelivered, data: { sessionId: entry.sessionId, attempt } });
                void this.save();
                return;
            }
        }
        finally {
            this.delivering.delete(entry.sessionId);
        }
    }
    sleep(ms) {
        return new Promise(resolve => {
            this.scheduleFn(() => resolve(), ms);
        });
    }
    // ------------------------------------------------------------ registry
    /** Prune the oldest terminal entries beyond the cap（pending 永不裁剪）。 */
    prune() {
        if (this.entries.size <= DEFERRED_MAX_ENTRIES)
            return;
        const terminal = [...this.entries.values()]
            .filter(entry => entry.state !== 'pending')
            .sort((a, b) => a.updatedAt - b.updatedAt);
        for (const entry of terminal) {
            if (this.entries.size <= DEFERRED_MAX_ENTRIES)
                break;
            this.entries.delete(entry.sessionId);
        }
    }
    registryPath() {
        return join(this.ctx.mediaDir, DEFERRED_REGISTRY_FILE);
    }
    /** Atomic full rewrite（唯一 tmp 后缀 + rename，对齐 registry.ts 纪律）。 */
    save() {
        const run = this.saveChain.then(async () => {
            if (this.ctx.mediaDir === '')
                return;
            await mkdir(this.ctx.mediaDir, { recursive: true });
            const lines = [...this.entries.values()].map(entry => JSON.stringify(entry));
            const tmpPath = this.registryPath() + '.tmp-' + this.now() + '-' + Math.random().toString(36).slice(2, 8);
            await writeFile(tmpPath, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8');
            try {
                await rename(tmpPath, this.registryPath());
            }
            finally {
                // #16（sat-a）：rename 失败（目标被占用/跨设备等）时残留 tmp 会
                // 无限累积；成功后 tmp 已不存在，ENOENT 吞掉。
                await unlink(tmpPath).catch(() => undefined);
            }
        });
        this.saveChain = run.catch(() => undefined);
        return run.catch(error => {
            this.ctx.log('warn', '超时补发注册表写入失败: ' + describeError(error));
        });
    }
    /** Startup recovery: load every persisted entry; pending ones resume
     * tracking（该会话的下一次 turn/end 兑现）并打上旧进程标记
     * （restoredPending：同会话新回合一开始即取消，B3 闭环）。Per-line
     * corrupt degrade: 坏行跳过并告警，其余条目照常恢复；文件缺失 = 全新启动。 */
    async loadPersisted() {
        let content;
        try {
            content = await readFile(this.registryPath(), 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.ctx.log('warn', '超时补发注册表读取失败；按空注册表继续: ' + describeError(error));
            }
            return;
        }
        let restored = 0;
        let skipped = 0;
        let pending = 0;
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            try {
                const entry = sanitizeEntry(JSON.parse(trimmed));
                if (entry === null) {
                    skipped += 1;
                    continue;
                }
                if (entry.state === 'pending' && this.now() - entry.registeredAt > DEFERRED_PENDING_MAX_AGE_MS) {
                    entry.state = 'cancelled';
                    entry.reason = '补发跟踪超过 24 小时未兑现（原回合已随上次进程结束），自动终止';
                    entry.updatedAt = this.now();
                }
                if (entry.state === 'pending') {
                    // B3（sat-b2）闭环：恢复的 pending 条目全部来自上一个宿主
                    // 进程——打上旧进程标记，同会话新回合一开始即由 onTurnStart
                    // 取消（cancelRestoredPending），绝不让死回合的旧文字补到
                    // 不相关的新回合（会话 id 不变时 chatSessions 校验闸不触发）。
                    this.restoredPending.add(entry.sessionId);
                    pending += 1;
                }
                this.entries.set(entry.sessionId, entry);
                restored += 1;
            }
            catch {
                skipped += 1;
            }
        }
        if (skipped > 0) {
            this.ctx.log('warn', '超时补发注册表有 ' + skipped + ' 行损坏，已跳过（损坏降级，不影响其余条目）');
        }
        if (restored > 0) {
            this.ctx.log('info', '已恢复 ' + restored + ' 条超时补发跟踪（其中 ' + pending + ' 条等待兑现）');
            void this.save();
        }
    }
    /** Test/diagnostic snapshot: the live entries (registry order). */
    snapshot() {
        return [...this.entries.values()];
    }
}
