/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type Z from '@deepseek-ai/schemastery';
import type { OneBotEvent } from './connection.js';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentDefaultModel: {
        currentSelection(): ModelSelection | undefined;
        saveSelection(next: ModelSelection): Promise<void>;
    };
    agentPresets: {
        readonly defaultId: string;
        resolve(id?: string): Promise<{
            id: string;
        }>;
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence: {
        /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
         * undefined when the id owns no durable log (the retired `inspect`
         * convenience no longer exists on the host service). */
        stat(id: string): Promise<object | undefined>;
        /** /session list previews: open a stored session read-only (never takes
         * write ownership), read the header + a small event prefix, then close. */
        open(id: string, access: 'read'): Promise<{
            header: {
                createdAt?: number;
                agentPreset?: string;
            };
            read(offset?: number, length?: number): Promise<{
                events: readonly {
                    type?: string;
                    data?: {
                        agentPreset?: string;
                        source?: {
                            kind?: string;
                        };
                        content?: readonly {
                            type?: string;
                            text?: string;
                        }[];
                    };
                }[];
            }>;
            close(): Promise<void>;
        }>;
    };
    workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        }>;
        list(): Array<{
            id: string;
            path: string;
            sessionIds: readonly string[];
        }>;
    };
    commands: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    };
};
export declare const name = "dsh-lanxi-qq";
export declare const inject: string[];
/** Plugin configuration (validated by schemastery). */
export interface Config {
    mode: 'reverse' | 'forward';
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Forward-mode reconnect attempt limit; 0 = retry forever. */
    reconnectMaxAttempts: number;
    botQQ: string;
    requireMention: boolean;
    /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
    unknownCommand: 'intercept' | 'passthrough';
    /** T2 (P1): 任务运行中的新消息处理策略：queue=排队（默认）；steer=插话进当前任务。 */
    newMessagePolicy: 'queue' | 'steer';
    /** T9-B (用户裁决 2026-10-12)：steer 模式下自动插话资格：admin=仅管理员（默认）；all=不限。 */
    autoSteerPolicy: 'admin' | 'all';
    /** T3 (P2): 等待模型回复超时阈值（毫秒）——超时后登记补发跟踪、回合完成后向原聊天补发最终文字；0=关闭。 */
    deferredTimeoutMs: number;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    /** 群聊自主接话冷却（毫秒）：没被 @ 的群消息同群冷却窗口内只接一次；0=禁用。 */
    groupReplyCooldownMs: number;
    /** 群聊每日发言预算（次，按北京时间）：到量当天不接话，次日重置；0=不限。 */
    groupDailyQuota: number;
    /** 高峰时段（工作日 9-12、14-18）只有被 @ 才接话。 */
    groupPeakOnlyMention: boolean;
    /** 夜间静默开始时间 HH:MM（北京时间）；与 groupQuietEnd 成对，任一为空即关闭。 */
    groupQuietStart: string;
    /** 夜间静默结束时间 HH:MM（北京时间）；start > end 表示跨午夜。 */
    groupQuietEnd: string;
    /** 自动静默：回复命中第一人称晚安类关键词后静默到下一个出场点。 */
    groupAutoSilence: boolean;
    /** 自动静默关键词（只认第一人称）。 */
    groupSilenceKeywords: string[];
    /** 自动静默出场点（北京时间 HH:MM 列表）。 */
    groupSilenceReleaseTimes: string[];
    /** 静默唤醒名：静默时段内只有管理员 @ 或喊到这些名字才放行；默认空。 */
    groupQuietWakeNames: string[];
    /** 静默生效群（群号字符串列表）；空数组=所有群。 */
    groupSilentGroupIds: string[];
    /** 群聊工具硬闸：inherit（默认）=不设防；guard=非管理员回合只放行 groupMemberTools 白名单。 */
    groupToolPolicy: 'inherit' | 'guard';
    /** guard 档下群内非管理员回合仍可调用的工具名白名单。 */
    groupMemberTools: string[];
    /** guard 档下非管理员回合的 qq_* 工具只允许发给当前群。 */
    groupMemberPinChat: boolean;
    adminUsers: string[];
    allowAllUsers: boolean;
    ignoreSelf: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion. */
    interimRecallMs: number;
    /** M3-D2b: interim recall degrade switch (false = send-only interims). */
    interimRecall: boolean;
    sendErrorNotice: boolean;
    /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
    rateLimitPerMinute: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: string[];
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    /** @deprecated D4a alias of inboundImageMaxPx; honored for one release. */
    imageMaxSize?: number;
    /** @deprecated D4a alias of outboundImageMaxBytes; honored for one release. */
    maxImageBytes?: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: string[];
    fontFamilies: string[];
    agentPreset: string;
    workspacePath: string;
    inboundFileMaxBytes: number;
    /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
    maxInboundFileBytes?: number;
    /** B8c: chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** W2-③: bridge-wide proactive-write (qq_send_* tools) cap per minute; 0 disables. */
    actionRatePerMinute: number;
    /** W2-③: bridge-wide proactive-write cap per calendar day; 0 disables. */
    actionRatePerDay: number;
    /** W2-③: proactive-write audit jsonl (mediaDir/qq-actions.log). */
    actionAuditEnabled: boolean;
    /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — zero
     * file, zero behavior difference vs 0.6.0. */
    traceEnabled: boolean;
    /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
    recordInbound: boolean;
    /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
    inboxRedact: boolean;
    /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
    injectEnabled: boolean;
    /** W1/T5: intercept all outbound writes of injected rounds (default true). */
    injectDryRun: boolean;
    /** W1/T5: inject queue poll interval in ms (min 500). */
    injectIntervalMs: number;
    /** 试运行开关：true=所有出站写不调 NapCat API，只写 dryRunLogFile 日志。 */
    dryRun: boolean;
    /** 试运行日志文件路径（仅 dryRun=true 时写入）。 */
    dryRunLogFile: string;
    /** 每日收发计数目录（<statsDir>/YYYY-MM-DD.jsonl，只记类型不记内容）。 */
    statsDir: string;
    /** 持久 Outbox：断线排队的外发回复落盘，at-least-once 投递、重启后续投。 */
    durableOutbox: boolean;
    /** 持久 Outbox 总条数上限；超过丢最旧一条（不静默）。 */
    outboxMaxEntries: number;
    /** 持久 Outbox 单条补发尝试上限；0=失败无限回队重试。 */
    outboxMaxAttempts: number;
    /** 持久 Outbox 排队有效期（毫秒）；0=不过期。 */
    outboxTtlMs: number;
    /** 入站 WAL：处理前写盘、完成后确认，进程崩溃后未确认消息按 inboundWalReplay 处理。 */
    inboundWal: boolean;
    /** 入站 WAL 自动重放开关。 */
    inboundWalReplay: boolean;
    /** 分条发送：把一条回复按空行拆成几个气泡逐条发。 */
    bubbleSplit: boolean;
    /** 分条发送：单次回复最多分成几段。 */
    bubbleMaxMessages: number;
    /** 分条发送：单段参考长度上限（超长整句不硬切）。 */
    bubbleMaxChars: number;
    /** 分条发送：相邻两条最短间隔（毫秒）。 */
    bubbleGapMinMs: number;
    /** 分条发送：相邻两条最长间隔（毫秒）。 */
    bubbleGapMaxMs: number;
    /** 分条发送：插一次长停顿的概率（0~1）。 */
    bubbleLongGapProbability: number;
    /** 分条发送：长停顿最短毫秒数。 */
    bubbleLongGapMinMs: number;
    /** 分条发送：长停顿最长毫秒数。 */
    bubbleLongGapMaxMs: number;
    /** 分条发送：只对哪些会话生效（chatId 列表）；空数组=所有会话。 */
    bubbleOnlyChats: string[];
    /** 语音同步听的 Python 解释器路径；留空=关闭（2026-11-03 改为配置项）。 */
    voiceEarPython: string;
    /** 语音同步听脚本路径（配合 voiceEarPython）；任一留空即关闭。 */
    voiceEarScript: string;
    /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export declare function resolveDeprecatedConfig(config: Config): Config;
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export declare function logMetaEvent(selfId: string, event: OneBotEvent, minLevel?: Config['logLevel']): void;
/** Mount the plugin. */
export declare function apply(ctx: Context, config: Config): void;
export {};
