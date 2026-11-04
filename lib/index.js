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
import { homedir } from 'node:os';
import { join } from 'node:path';
// R1 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let z;
let OneBotConnection;
let ChatBridge;
let MediaStore;
let IMAGE_MAX_BYTES;
let VOICE_MAX_BYTES;
let MEDIA_MAX_BYTES;
let Transcriber;
let TraceSink;
let InboundRecorder;
let InjectChannel;
let StatusStore;
let EventLog;
let InboundWal;
let redactSnapshot;
let describeError;
let DEFAULT_DRYRUN_LOG_FILE;
let DEFAULT_STATS_DIR;
try {
    ;
    ({ default: z } = await import('@deepseek-ai/schemastery'));
    ({ OneBotConnection, DEFAULT_DRYRUN_LOG_FILE, DEFAULT_STATS_DIR } = await import('./connection.js'));
    ({ ChatBridge } = await import('./bridge.js'));
    ({ MediaStore, IMAGE_MAX_BYTES, VOICE_MAX_BYTES, MEDIA_MAX_BYTES } = await import('./media.js'));
    ({ Transcriber } = await import('./stt.js'));
    ({ TraceSink } = await import('./trace.js'));
    ({ InboundRecorder } = await import('./record.js'));
    ({ InjectChannel } = await import('./inject.js'));
    ({ StatusStore } = await import('./status.js'));
    ({ EventLog } = await import('./events.js'));
    ({ InboundWal } = await import('./wal.js'));
    ({ redactSnapshot } = await import('./health.js'));
    ({ describeError } = await import('./errors.js'));
}
catch (error) {
    console.error('[dsh-onebot] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)));
    throw error;
}
export const name = 'dsh-lanxi-qq';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm'];
const ENV = (name) => process.env[name] ?? '';
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir() {
    // os.homedir() reads $HOME first and falls back to the passwd entry — the
    // systemd service runs without HOME, so `?? '/tmp'` used to resolve to
    // /tmp/.dsh and preset enumeration hit ENOENT (web log line 14429).
    const home = ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
    return join(home, 'media', 'onebot');
}
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome() {
    return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh');
}
/** D4a: schema defaults for the renamed fields (referenced by the deprecated-name fallback). */
const INBOUND_IMAGE_MAX_PX = 2048;
const OUTBOUND_IMAGE_MAX_BYTES = IMAGE_MAX_BYTES;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const Config = z.object({
    mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse')
        .description('连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务'),
    host: z.string().default('127.0.0.1')
        .description('reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0'),
    port: z.number().default(8643)
        .description('reverse 模式监听端口'),
    url: z.string().default('ws://127.0.0.1:3001')
        .description('forward 模式的 NapCat ws 地址'),
    accessToken: z.string().role('secret').default('')
        .description('OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer）'),
    reconnectMaxAttempts: z.number().default(100)
        .description('forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s）'),
    botQQ: z.string().default('')
        .description('机器人自身 QQ 号；留空则从 meta 事件自动学习'),
    requireMention: z.boolean().default(true)
        .description('群聊是否仅在 @机器人（或回复其消息）时响应'),
    unknownCommand: z.union([z.const('intercept'), z.const('passthrough')]).default('intercept')
        .description('未知斜杠命令处理：intercept（默认）=拦截并提示相近命令或 /help；passthrough=透传给模型（旧行为）'),
    newMessagePolicy: z.union([z.const('queue'), z.const('steer')]).default('queue')
        .description('任务运行中的新消息处理策略（P1）：queue（默认）=排队——新消息在当前任务结束后按序处理为后续回合，等待期间至多提示一次；steer=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示；图片/文件/语音/带引用消息与 [受限用户:仅问答] 消息两种模式下都按排队处理，/steer 命令两种模式下均可用'),
    autoSteerPolicy: z.union([z.const('admin'), z.const('all')]).default('admin')
        .description('steer 模式下自动插话的发送者资格（T9-B 用户裁决 2026-10-12）：admin（默认）=仅管理员可自动插话；all=所有非受限发送者均可。不具备资格的消息按排队处理；/steer 命令始终仅管理员、不受本项影响；queue 模式行为不变'),
    deferredTimeoutMs: z.number().default(600_000)
        .description('等待模型回复超时阈值（毫秒，T3/P2 超时补发）：回合超过该时长没有任何模型输出时提示超时并登记补发跟踪，任务完成后向原聊天自动补发最终文字（走既有出站管线）；发送明确失败最多尝试 3 次（退避），结果不确定时保留记录停止自动重试；/stop 终止该聊天的补发跟踪；0=关闭超时补发'),
    dmPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊'),
    groupPolicy: z.union([z.const('open'), z.const('allowlist'), z.const('disabled')]).default('open')
        .description('群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群'),
    allowFrom: z.array(z.string()).default([])
        .description('dmPolicy=allowlist 时允许私聊的 QQ 号'),
    groupAllowFrom: z.array(z.string()).default([])
        .description('groupPolicy=allowlist 时允许的群号'),
    adminUsers: z.array(z.string()).default([])
        .description('管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定）'),
    allowAllUsers: z.boolean().default(false)
        .description('放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true）'),
    ignoreSelf: z.boolean().default(true)
        .description('忽略机器人自己发出的消息（防自循环）'),
    interimMessages: z.boolean().default(true)
        .description('是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复。true 时：中间消息实时可见、每条在 interimRecallMs 后自动单独撤回、回合结束先发一张整轮 t2i 小结卡再发最终回复'),
    interimRecallMs: z.number().default(90_000)
        .description('中间消息各自发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000）'),
    interimRecall: z.boolean().default(true)
        .description('中间消息撤回开关：true（默认）=每条中间消息在 interimRecallMs 后自动撤回，回合结束先发整轮 t2i 小结卡再立即撤回原消息；false=只发不撤——中间消息照常实时发出但保留在聊天里：不排自动撤回定时器、回合结束不发小结卡也不撤回原消息，只发最终回复'),
    sendErrorNotice: z.boolean().default(true)
        .description('一轮运行出错时向用户发送 ⚠️ 错误提示'),
    rateLimitPerMinute: z.number().default(30)
        .description('每 chat 每分钟允许的普通消息条数上限（60 秒滑动窗口）；命令消息不计入也不受限；超限时每窗口最多提示一次；0=禁用频控'),
    groupReplyCooldownMs: z.number().default(120_000)
        .description('群聊自主发言冷却（毫秒）：没被 @ 的群消息在同一群冷却窗口内只接一次，避免每句都插嘴；被 @ 或被引用（引用机器人消息）的消息不受限；0=禁用（蓝汐 2026-10-27 补丁）'),
    groupDailyQuota: z.number().default(30)
        .description('群聊每日发言预算（次）：同一群按北京时间每天最多接多少次，按回复次数算不按气泡数；到量后当天不再接话，次日零点重置；0=不限（蓝汐 2026-10-27 补丁）'),
    groupPeakOnlyMention: z.boolean().default(true)
        .description('群聊高峰时段只说被 @ 的（蓝汐 2026-10-27 补丁）：true=北京时间工作日 9:00-12:00 与 14:00-18:00 期间，没被 @ 的群消息一律不接；false=高峰照常参与'),
    groupQuietStart: z.string().default('').pattern(/^$|^([01]\d|2[0-3]):[0-5]\d$/, '时间格式必须是 HH:MM（24 小时制，如 01:00 或 23:30），留空表示不启用')
        .description('群聊夜间静默开始时间（蓝汐 2026-10-28 补丁）：格式 HH:MM，北京时间 UTC+8，与 groupQuietEnd 成对使用；任一为空即关闭该功能。start > end 表示跨午夜（如 23:00 到 08:00）'),
    groupQuietEnd: z.string().default('').pattern(/^$|^([01]\d|2[0-3]):[0-5]\d$/, '时间格式必须是 HH:MM（24 小时制，如 01:00 或 23:30），留空表示不启用')
        .description('群聊夜间静默结束时间（蓝汐 2026-10-28 补丁）：格式 HH:MM，北京时间 UTC+8；静默区间为 [start, end)，到点自动恢复。静默时段内只有管理员的 @ 或点名 groupQuietWakeNames 能穿透，其他人 @、喊名字一律丢弃（2026-10-28 收紧）'),
    groupAutoSilence: z.boolean().default(false)
        .description('群聊自动静默（蓝汐 2026-10-28 补丁）：true 时，群消息发送成功后若文本命中 groupSilenceKeywords（第一人称晚安类），自动静默到下一个 groupSilenceReleaseTimes 出场点，状态落 ~/.dsh/onebot-group-silent.json；静默期间只有管理员 @ 或点名 groupQuietWakeNames 才能唤醒；默认关闭'),
    groupSilenceKeywords: z.array(z.string()).default(['晚安', '我去睡', '我去躺', '下线了', '睡了睡了'])
        .description('自动静默关键词（蓝汐 2026-10-28 补丁）：只认第一人称（出现在分句开头附近、且不是"你说/他说/说晚安"这类转述），命中即静默'),
    groupSilenceReleaseTimes: z.array(z.string()).default(['12:10', '18:10'])
        .description('自动静默出场点（蓝汐 2026-10-28 补丁）：北京时间 HH:MM 列表；静默后取最近的未来时刻作为 until，今天都过完就顺延到明天，多个时刻取最早；全部非法则不静默（安全退回）'),
    groupQuietWakeNames: z.array(z.string()).default([])
        .description('静默唤醒名（蓝汐 2026-10-28 补丁）：自动静默与固定静默时段内，只有管理员 @ 机器人、或在文本里喊到这些名字才放行并删除自动静默状态；其他人 @、喊名字一律丢弃。默认空数组=只有管理员 @ 能穿透，按需自填'),
    groupSilentGroupIds: z.array(z.string()).default([])
        .description('静默生效群（蓝汐 2026-10-28 补丁）：群号字符串列表（如 ["<群号>"]，数字也会被统一成字符串比较）。空数组（默认）=所有群都吃 groupQuietStart/groupQuietEnd 固定静默与 groupAutoSilence 自动静默，与加这个键之前完全一致；非空时只有列表里的群受这两层静默限制，列表外的群当作没开静默，照常走 @ 门控、冷却与每日配额。私聊不受任何影响'),
    restrictedMemberPrefix: z.boolean().default(true)
        .description('群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制）'),
    groupToolPolicy: z.union([z.const('inherit'), z.const('guard')]).default('inherit')
        .description('群聊工具硬闸（蓝汐 2026-10-28 补丁）：inherit（默认）=保持现状不设防；guard=群内非管理员回合除 groupMemberTools 白名单外一切工具调用直接拒绝，管理员回合不受限；只对 group:* 会话生效，私聊与其他通道不受影响'),
    groupMemberTools: z.array(z.string()).default(['qq_send_image', 'qq_send_voice', 'qq_send_forward'])
        .description('群聊工具硬闸白名单（蓝汐 2026-10-28 补丁）：groupToolPolicy=guard 时群内非管理员回合仍可调用的工具名；不要加入 subagent 等会开子 agent 作用域的工具（父 agent 的 guard 不继承到子 agent，等于开后门）'),
    groupMemberPinChat: z.boolean().default(true)
        .description('群聊工具硬闸钉死本群（蓝汐 2026-10-28 补丁）：群内非管理员回合的 qq_* 工具只允许发给当前群（chat_id 指向私聊或其他群一律拒绝）；false=放行跨会话发送'),
    sensitivePatterns: z.array(z.string()).default([])
        .description('出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认）'),
    mediaDir: z.string().default('')
        .description('入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot'),
    tempTtlHours: z.number().default(6)
        .description('入站临时媒体文件保留时长（小时），到期自动清理'),
    outboundImageMaxBytes: z.number().default(OUTBOUND_IMAGE_MAX_BYTES)
        .description('出站图片大小上限（字节）'),
    maxImageBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 outboundImageMaxBytes）：出站图片大小上限（字节）；本版兼容读取，新配置请用新名'),
    inboundImageMaxPx: z.number().default(INBOUND_IMAGE_MAX_PX)
        .description('入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用'),
    imageMaxSize: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundImageMaxPx）：入站图片长边上限（像素）；本版兼容读取，新配置请用新名'),
    maxVoiceBytes: z.number().default(VOICE_MAX_BYTES)
        .description('出站语音大小上限（字节）'),
    maxFileBytes: z.number().default(MEDIA_MAX_BYTES)
        .description('出站视频/文件大小上限（字节）'),
    sttEnabled: z.boolean().default(true)
        .description('入站语音是否转写（需要 ffmpeg 和 whisper CLI；失败时降级为 [语音] 占位）'),
    sttEngine: z.union([z.const('auto'), z.const('openai'), z.const('whisper-cpp'), z.const('custom')]).default('auto')
        .description('STT 引擎：auto 自动探测 whisper-cli / whisper / mlx_whisper'),
    sttCommand: z.string().default('')
        .description('custom 引擎的程序名/路径'),
    sttArgs: z.array(z.string()).default([])
        .description('custom 引擎参数模板，{file} 与 {out} 会被替换'),
    sttModel: z.string().default('small')
        .description('whisper 模型（openai: small/base/medium...；whisper.cpp: 模型名或 .bin 绝对路径）'),
    sttTimeoutMs: z.number().default(60_000)
        .description('单次转写超时（毫秒，默认 60000）；超时后占位即终态，不追加转写'),
    voiceEarPython: z.string().default('')
        .description('语音同步听的 Python 解释器路径（2026-11-03 改造）：入站语音先尝试用它跑语音听写脚本，拿到一行中文听觉描述；留空（默认）=关闭语音同步听，语音消息直接走 STT 转写或 [语音] 占位'),
    voiceEarScript: z.string().default('')
        .description('语音同步听脚本路径（qq_ear.py 之类，配合 voiceEarPython 使用）：两个键都填好才启用，任一留空即关闭。脚本须支持 --file <音频> --out <结果txt> --tmpdir <临时目录> 参数；8 秒超时，失败/超时/空输出一律静默退回 [语音] 占位，不影响消息收发'),
    textImageThreshold: z.number().default(150)
        .description('回复正文超过该长度（字符数）时渲染为文字图卡片发送；<=0 禁用卡片路径'),
    cardFooter: z.string().default('dsh')
        .description('文字图卡片页脚品牌文字（"Powered by <brand>"）'),
    fontFiles: z.array(z.string()).default([])
        .description('t2i 渲染器注册的字体文件路径（Linux/自定义字体；macOS 自动用系统字体）'),
    fontFamilies: z.array(z.string()).default([])
        .description('t2i 渲染器优先使用的字体家族名（覆盖平台默认）'),
    agentPreset: z.string().default('')
        .description('QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设'),
    workspacePath: z.string().default('')
        .description('QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失'),
    inboundFileMaxBytes: z.number().default(INBOUND_FILE_MAX_BYTES)
        .description('QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制）'),
    maxInboundFileBytes: z.number().deprecated()
        .description('[deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名'),
    allowPrivateHosts: z.boolean().default(false)
        .description('下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查'),
    chatIdleEvictDays: z.number().default(7)
        .description('会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用'),
    dedupWindowSeconds: z.number().default(300)
        .description('入站消息去重窗口（秒，W2-②）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重'),
    actionRatePerMinute: z.number().default(20)
        .description('主动写操作每分钟全桥合计上限（W2-③）：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；0 = 禁用分钟限额'),
    actionRatePerDay: z.number().default(500)
        .description('主动写操作每日（本地自然日）全桥合计上限（W2-③）：口径同 actionRatePerMinute；超限拒发并记 warn 与审计，次日自动恢复；0 = 禁用日限额'),
    actionAuditEnabled: z.boolean().default(true)
        .description('主动写审计（W2-③）：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 mediaDir/qq-actions.log（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送'),
    traceEnabled: z.boolean().default(false)
        .description('链路追踪（W1）：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致'),
    traceLevel: z.union([z.const('debug'), z.const('warn')]).default('debug')
        .description('追踪事件级别（W1）：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件'),
    recordInbound: z.boolean().default(false)
        .description('入站录制（W1）：把收到的每条入站事件（含被门控跳过的，附当时决策 reason）按可回放形状逐行 JSON 追加写 mediaDir/qq-inbox.jsonl（2MiB 改名轮转，保留 qq-inbox.1/2.jsonl；注入的帧不会被二次录制）；纯旁路：写失败仅 warn 限频，绝不影响回复管线；默认关闭——零文件零开销'),
    inboxRedact: z.boolean().default(false)
        .description('录制脱敏（W1）：落盘前把帧中 6 位以上的数字串（QQ 号/群号等）脱敏为前 3 位+****（数字型 id 字段一并处理），便于把录制文件发给别人离线回放；默认关闭'),
    injectEnabled: z.boolean().default(false)
        .description('事件注入通道（W1，仅调试用——信任边界：注入是调试通道，默认全关，勿在生产开启）：开启后按 injectIntervalMs 轮询 mediaDir/qq-inject.jsonl，把新行喂进真实入站管线（trace 事件标 stage=inject）；启动时已存在的历史行跳过并记一条说明；默认关闭'),
    injectDryRun: z.boolean().default(true)
        .description('注入干跑（W1）：true（默认，强烈建议保持）=注入回合触发的全部出站写操作（发消息/撤回等，含异步模型回合的最终回复——拦截点在出站动作层）被拦截计数、原文进 trace 事件、绝不真发 QQ；false=注入内容会真实发送，仅限隔离环境实验'),
    injectIntervalMs: z.number().default(2000)
        .description('注入队列轮询间隔（毫秒，W1；最小 500）'),
    dryRun: z.boolean().default(false)
        .description('试运行开关（2026-11-01）：true=所有出站写操作（文本/图片/语音/视频/文件/合并转发/群消息/主动发/撤回/正在输入）不调 NapCat API，改为向 dryRunLogFile 追加一行日志（ISO 时间、目标会话、消息类型、内容前 120 字）并返回模拟成功——没有 NapCat 也能完整试跑；false（默认）=真实发送'),
    dryRunLogFile: z.string().default(DEFAULT_DRYRUN_LOG_FILE)
        .description('试运行日志文件路径（仅 dryRun=true 时写入；每行=ISO 时间+目标会话+消息类型+内容前 120 字）'),
    statsDir: z.string().default(DEFAULT_STATS_DIR)
        .description('每日收发计数目录（2026-11-01）：每次收发按本地日期往 <statsDir>/YYYY-MM-DD.jsonl 追加一行，只记类型不记内容（文本/图片/语音/视频/文件/合并转发/表情包/其他）；默认落工作区 data/onebot-stats，换机器或换盘符时改这里'),
    // ── 2026-11-02 P0 改造：持久 Outbox + 入站 WAL（对齐 dsh-lark-link） ──
    // 这两个键本期不进设置面板（与 dedupWindowSeconds/actionRatePerMinute 同一
    // 取舍）：属于可靠投递的运维档位，默认值就是推荐值；要改走 patch config。
    durableOutbox: z.boolean().default(true)
        .description('持久 Outbox（P0 改造）：true（默认）=断线排队的外发回复落盘 mediaDir/qq-outbox.jsonl——at-least-once 投递、幂等键防重复、重启后续投、连续失败移入 failed 队列（随 /doctor 导出）；false=回到改造前的内存队列（per-chat cap 20 / TTL 5 分钟 / 超了丢最旧），行为与旧版逐字节一致'),
    outboxMaxEntries: z.number().default(500)
        .description('持久 Outbox 总条数上限：所有聊天排队中的回复合计数；超过后丢最旧一条（warn + 给被丢的聊天补一条说明，不静默）'),
    outboxMaxAttempts: z.number().default(5)
        .description('持久 Outbox 单条补发尝试上限：连续失败这么多次后移入 failed 队列不再自动重试；0=失败无限回队重试（不推荐）'),
    outboxTtlMs: z.number().default(0)
        .description('持久 Outbox 排队有效期（毫秒）：超过未送达的条目在下次补发时丢弃并通知；0（默认）=不过期，排队多久都等着补发，不丢消息'),
    inboundWal: z.boolean().default(true)
        .description('入站 WAL（P0 改造）：true（默认）=每条真实入站消息处理前写 mediaDir/qq-inbox-wal.jsonl、同步处理完成后确认；进程被杀导致未确认的消息在重启后按 inboundWalReplay 处理；false=关闭（纯旁路，关闭后行为与改造前一致）'),
    inboundWalReplay: z.boolean().default(true)
        .description('入站 WAL 自动重放：true（默认）=重启后把未确认的入站消息自动重投一遍（确认点在实际派发之后，已回复过的不会重放；崩溃恰好落在派发后、确认前时最多多重投一条）；false=只在状态面板显示未确认条数，不自动重投'),
    bubbleSplit: z.boolean().default(false)
        .description('分条发送：把一条回复按句子切成几个气泡逐条发；默认关闭，关闭时行为与原来完全一致'),
    bubbleMaxMessages: z.number().default(4)
        .description('分条发送：单次回复最多分成几段，多出来的句子合并进末段'),
    bubbleMaxChars: z.number().default(120)
        .description('分条发送：单段的参考长度上限（超长的整句不硬切，直接单独成段）'),
    bubbleGapMinMs: z.number().default(800)
        .description('分条发送：相邻两条之间的最短间隔（毫秒）'),
    bubbleGapMaxMs: z.number().default(2500)
        .description('分条发送：相邻两条之间的最长间隔（毫秒）'),
    bubbleLongGapProbability: z.number().default(0.2)
        .description('分条发送：插一次长停顿的概率（0~1）'),
    bubbleLongGapMinMs: z.number().default(4000)
        .description('分条发送：长停顿的最短毫秒数'),
    bubbleLongGapMaxMs: z.number().default(8000)
        .description('分条发送：长停顿的最长毫秒数'),
    bubbleOnlyChats: z.array(z.string()).default([])
        .description('分条发送：只对哪些会话生效（chatId 列表）；空数组表示所有会话都生效'),
    logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info')
        .description('控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误'),
});
/** D4a: the deprecated config names kept for one release, mapped onto their
 * renamed fields. */
const DEPRECATED_CONFIG_ALIASES = [
    ['imageMaxSize', 'inboundImageMaxPx', INBOUND_IMAGE_MAX_PX],
    ['maxImageBytes', 'outboundImageMaxBytes', OUTBOUND_IMAGE_MAX_BYTES],
    ['maxInboundFileBytes', 'inboundFileMaxBytes', INBOUND_FILE_MAX_BYTES],
];
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export function resolveDeprecatedConfig(config) {
    const resolved = { ...config };
    for (const [oldName, newName, defaultValue] of DEPRECATED_CONFIG_ALIASES) {
        const legacy = resolved[oldName];
        if (legacy === undefined)
            continue;
        console.warn('[dsh-onebot] config "' + oldName + '" is deprecated; rename it to "' + newName + '"');
        delete resolved[oldName];
        if (resolved[newName] === defaultValue)
            resolved[newName] = legacy;
    }
    return resolved;
}
/** Resolve env-var fallbacks into the effective access policy. */
function resolvePolicy(config) {
    const envAdmins = ENV('ONEBOT_ALLOWED_USERS')
        .split(',')
        .map(v => v.trim())
        .filter(v => v !== '');
    const adminUsers = [...new Set([...config.adminUsers, ...envAdmins])];
    return {
        dmPolicy: config.dmPolicy,
        groupPolicy: config.groupPolicy,
        allowFrom: config.allowFrom,
        groupAllowFrom: config.groupAllowFrom,
        adminUsers,
        allowAllUsers: config.allowAllUsers || ENV('ONEBOT_ALLOW_ALL_USERS').toLowerCase() === 'true',
        requireMention: config.requireMention,
    };
}
/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId, event, minLevel = 'info') {
    const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : '';
    if (metaType === 'heartbeat')
        return;
    if (LOG_LEVEL_RANK.info < LOG_LEVEL_RANK[minLevel])
        return;
    console.log('[dsh-onebot] meta event; bot QQ: ' + selfId + '; ' + metaType);
}
/** Mount the plugin. */
export function apply(ctx, config) {
    // D4a: honor the deprecated config names before any consumer reads them.
    config = resolveDeprecatedConfig(config);
    const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir();
    const policy = resolvePolicy(config);
    /** Console log line callback (level, message) — shared by the bridge deps,
     * the connection log port and the host-ready boot gate below (M2-C5b). */
    const log = (level, message) => {
        if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel])
            return;
        const prefix = '[dsh-onebot] ';
        if (level === 'error')
            console.error(prefix + message);
        else if (level === 'warn')
            console.warn(prefix + message);
        else
            console.log(prefix + message);
    };
    // T3 方案 B: the host exposes no queryable default workspace —
    // WorkspaceRegistry has no default getter and the session controller's
    // defaultCwd is assembly-internal — so the unconfigured fallback stays the
    // host process cwd. Say so once at mount so a /root surprise is explainable.
    if (config.workspacePath === '') {
        log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录');
    }
    const connection = new OneBotConnection({
        mode: config.mode,
        host: config.host,
        port: config.port,
        url: config.url,
        accessToken: config.accessToken,
        reconnectMaxAttempts: config.reconnectMaxAttempts,
        callTimeoutMs: 30_000,
        dryRun: config.dryRun,
        dryRunLogFile: config.dryRunLogFile,
        statsDir: config.statsDir,
        log,
    });
    if (config.dryRun === true) {
        log('warn', 'dryRun 试运行模式已开启：所有出站写操作不会真正发送到 QQ，仅写入日志 ' + config.dryRunLogFile);
    }
    const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts });
    // W1: the trace sink exists only when explicitly enabled — default off
    // means no sink, no traceIds, no jsonl, zero behavior difference.
    const traceSink = config.traceEnabled
        ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
        : undefined;
    // W1/T5: the inbound recorder exists only when recordInbound is on (pure
    // bypass: its own writer, failures only warn); the inject channel only
    // when injectEnabled is on (DEBUG-ONLY) — both absent by default.
    const recorder = config.recordInbound
        ? new InboundRecorder({ dir: mediaDir, redact: config.inboxRedact, log: (level, message) => log(level, message) })
        : undefined;
    const injectChannel = config.injectEnabled
        ? new InjectChannel({
            dir: mediaDir,
            dryRun: config.injectDryRun,
            intervalMs: config.injectIntervalMs,
            handleEvent: async (event) => bridge.handleInbound(event, { injected: true }),
            trace: traceSink,
            log: (level, message) => log(level, message),
        })
        : undefined;
    // 2026-11-02 P0：连接状态/事件时间线/入站 WAL——设置页徽标与「最近事件」
    // 面板的数据面（StatusStore 周期性原子写 mediaDir/qq-status.json；
    // EventLog 落 qq-events.jsonl 只记元数据不记正文；WAL 落 qq-inbox-wal.jsonl）。
    // 三者都是纯旁路：写失败只 warn，绝不影响收发。
    const statusStore = new StatusStore({ dir: mediaDir, log });
    const eventLog = new EventLog({
        dir: mediaDir,
        log,
        // ok:false 事件自动计入「今日错误数」徽标。
        onRecord: (event) => {
            if (event.ok === false)
                statusStore.noteError();
        },
    });
    const inboundWal = config.inboundWal !== false
        ? new InboundWal({ dir: mediaDir, log })
        : undefined;
    // 重启后把事件文件尾部读回环形缓冲：面板「重启后仍在」。
    void eventLog.loadTail().catch(() => undefined);
    const transcriber = new Transcriber({
        enabled: config.sttEnabled,
        engine: config.sttEngine,
        command: config.sttCommand,
        args: config.sttArgs,
        model: config.sttModel,
        timeoutMs: config.sttTimeoutMs,
    });
    connection.onMessage = (event) => {
        void bridge.handleInbound(event);
    };
    connection.onMeta = (event) => {
        logMetaEvent(connection.selfId, event, config.logLevel);
    };
    // W2-②③ gate keys: BridgeConfig (bridge.ts) keeps its declared shape; the
    // pipelines read them off the runtime object via optional intersection
    // members (see InboundContext/OutboundContext.config), so the spread here
    // is the wiring — no bridge.ts change.
    const gateConfig = {
        dedupWindowSeconds: config.dedupWindowSeconds,
        actionRatePerMinute: config.actionRatePerMinute,
        actionRatePerDay: config.actionRatePerDay,
        actionAuditEnabled: config.actionAuditEnabled,
    };
    const bridge = new ChatBridge({
        ctx,
        // M2-C5b: the bridge sees only explicit ports — the session-event feed
        // (this context's own `on`) and the two injectables below; the 'loader'
        // service lookup lives here, not in the bridge.
        hostReady: async () => {
            try {
                const loader = ctx.get('loader');
                await loader?.await();
            }
            catch (error) {
                log('debug', 'loader.await failed: ' + describeError(error));
            }
        },
        // Live llm lookup per call — same semantics as the pre-port live getter.
        llmCatalog: {
            listProviders: () => ctx.llm.listProviders(),
            listModels: provider => ctx.llm.listModels(provider),
        },
        connection,
        dshHome: dshHome(),
        media,
        transcriber,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentPresets: ctx.agentPresets,
        commands: ctx.commands,
        sessionPersistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        agentDefaultModel: ctx.agentDefaultModel,
        defaultModel: () => {
            try {
                return ctx.agentDefaultModel.currentSelection();
            }
            catch {
                return undefined;
            }
        },
        config: {
            botQQ: config.botQQ,
            ignoreSelf: config.ignoreSelf,
            requireMention: config.requireMention,
            unknownCommand: config.unknownCommand,
            newMessagePolicy: config.newMessagePolicy,
            autoSteerPolicy: config.autoSteerPolicy,
            deferredTimeoutMs: config.deferredTimeoutMs,
            interimMessages: config.interimMessages,
            interimRecallMs: config.interimRecallMs,
            interimRecall: config.interimRecall,
            sendErrorNotice: config.sendErrorNotice,
            rateLimitPerMinute: config.rateLimitPerMinute,
            // 蓝汐 2026-10-28：群聊冷却 / 每日配额 / 峰时只认点名。
            // 三个键以前只在 schema 里定义、没有下发，改配置永远不生效（审查报告 P0）。
            // 这里显式透传；inbound.js 再按「显式 0 = 关闭」的语义解释。
            groupReplyCooldownMs: config.groupReplyCooldownMs,
            groupDailyQuota: config.groupDailyQuota,
            groupPeakOnlyMention: config.groupPeakOnlyMention,
            restrictedMemberPrefix: config.restrictedMemberPrefix,
            groupToolPolicy: config.groupToolPolicy,
            groupMemberTools: config.groupMemberTools,
            groupMemberPinChat: config.groupMemberPinChat,
            // 蓝汐 2026-10-28：群聊夜间静默时段（inbound.js 群准入层读取）。
            groupQuietStart: config.groupQuietStart,
            groupQuietEnd: config.groupQuietEnd,
            // 蓝汐 2026-10-28：自动静默（outbound.js 写状态、inbound.js 读状态）。
            groupAutoSilence: config.groupAutoSilence,
            groupSilenceKeywords: config.groupSilenceKeywords,
            groupSilenceReleaseTimes: config.groupSilenceReleaseTimes,
            groupQuietWakeNames: config.groupQuietWakeNames,
            // 蓝汐 2026-10-28：静默生效群白名单（空=所有群，非空=只有列表里的群）。
            groupSilentGroupIds: config.groupSilentGroupIds,
            sensitivePatterns: config.sensitivePatterns,
            mediaDir,
            maxImageBytes: config.outboundImageMaxBytes,
            maxVoiceBytes: config.maxVoiceBytes,
            maxFileBytes: config.maxFileBytes,
            textImageThreshold: config.textImageThreshold,
            bubbleSplit: config.bubbleSplit,
            bubbleMaxMessages: config.bubbleMaxMessages,
            bubbleMaxChars: config.bubbleMaxChars,
            bubbleGapMinMs: config.bubbleGapMinMs,
            bubbleGapMaxMs: config.bubbleGapMaxMs,
            bubbleLongGapProbability: config.bubbleLongGapProbability,
            bubbleLongGapMinMs: config.bubbleLongGapMinMs,
            bubbleLongGapMaxMs: config.bubbleLongGapMaxMs,
            bubbleOnlyChats: config.bubbleOnlyChats,
            cardFooter: config.cardFooter,
            fontFiles: config.fontFiles,
            fontFamilies: config.fontFamilies,
            agentPreset: config.agentPreset,
            workspacePath: config.workspacePath,
            maxInboundFileBytes: config.inboundFileMaxBytes,
            chatIdleEvictDays: config.chatIdleEvictDays,
            ...gateConfig,
            // 2026-11-02 P0：持久 Outbox / 入站 WAL 档位（出站管线与桥读取）。
            durableOutbox: config.durableOutbox,
            outboxMaxEntries: config.outboxMaxEntries,
            outboxMaxAttempts: config.outboxMaxAttempts,
            outboxTtlMs: config.outboxTtlMs,
            inboundWalReplay: config.inboundWalReplay,
            trace: traceSink,
            recorder,
            inject: injectChannel,
            // 2026-11-02 P0：状态/事件/入站 WAL（桥的 onStatus、入站收口、
            // 启动重放接这三件）。
            status: statusStore,
            events: eventLog,
            wal: inboundWal,
        },
        policy,
        // W1/T5 health: the config snapshot is redacted at the source — secrets
        // (token/password/apikey…) never leave this closure in the clear.
        configSnapshot: () => redactSnapshot(config),
        log,
    });
    // W3/T4 (P3): connection faults mint QQ-CONN-… references through the
    // bridge (registry + trace + structured log); the transport appends the
    // returned reference to its own log line, so host logs and qq-trace.jsonl
    // share the same number for one fault.
    connection.onFailure = (stage, detail) => bridge.registerConnectionFailure(stage, detail);
    // P0：状态快照里的队列/ WAL 深度由桥的管线懒提供（status 模块不反向依赖桥）。
    statusStore.mode = config.mode;
    statusStore.providers.outbox = () => bridge.outbound.outboxStats();
    statusStore.providers.wal = () => inboundWal?.getStats() ?? { enabled: false, unacked: 0 };
    statusStore.providers.selfId = () => connection.selfId;
    // Lifecycle: start the bridge and transport; unwind everything on unload.
    ctx.effect(() => {
        bridge.start();
        connection.start();
        injectChannel?.start();
        // P0：状态快照周期落盘（连接翻转时桥另调 persistNow 立即写）；
        // 同一个定时器顺带刷新 WAL 未确认条数（文件口径，旁路）。
        statusStore.startRefresh(() => {
            if (inboundWal !== undefined)
                void inboundWal.refreshUnacked();
        });
        // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
        return async () => {
            statusStore.stopRefresh();
            await inboundWal?.flush();
            await bridge.outbound.outbox?.flush();
            await eventLog.flush();
            await statusStore.flush();
            await injectChannel?.stop();
            await bridge.stop();
            await connection.stop();
        };
    }, 'dsh-onebot.lifecycle');
    console.log('[dsh-onebot] mounted (mode=' + config.mode + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')');
}
