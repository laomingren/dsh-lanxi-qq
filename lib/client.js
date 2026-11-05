/**
 * dsh-onebot — client bundle（QQ Bot 设置面板，T4 · T1 定案 B 路径）
 *
 * 结构模板：dsh-expert-orchestrator/lib/client.js（CJS 包裹 + slots/remote 挂载模式），
 * 业务与契约全部对齐本仓库 docs/settings-page-design.md（T1 定案）与宿主侧
 * lib/settings-remote.js（T3 实现）。契约唯一来源：T1 §3 / §3.1 / §4 / §5。
 *
 * 宿主装载契约（对照 0.1.7-alpha.2 dsh-client-modules 校验与 expert-orchestrator 先例）：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 仅 react（平台冻结模块表）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
 *     {name, key, locale}, render))`（keyed，key = 组合包 npm 包名）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE)` 后
 *     `ctx.get('remote.onebotSettings')`）；所有读写经 Remote 调 host 侧，host 经
 *     configEditor.edit 写 profile patch 中 dsh-onebot 条目的 config 覆盖行
 *     （T1 §3：设置页/手改 patch/宿主原生设置页三方同源）。
 *
 * descriptor 同步说明（重要）：宿主侧 lib/settings-remote.js（T3）导出的是
 * SETTINGS_GROUPS / SCHEMA_DEFAULTS / SECRET_KEYS / 服务实现，**未导出客户端
 * Typert descriptor 数组**（descriptor 是浏览器侧 client bundle 的挂载清单，
 * host 侧服务经原型发现注册，两侧各持一份）。因此本文件内联定义
 * ONEBOT_SETTINGS_DESCRIPTORS，并以下述不变量与宿主侧逐字对齐（由
 * tests/client-settings.spec.ts 对 src/settings-remote.js 的导出常量断言）：
 *   - namespace/service = `onebotSettings`（T1 §4）；
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision) /
 *     listWorkspaces()（W7：只读查询宿主 workspace 注册表，{available, workspaces:
 *     [{id,path,sessionCount}]}；registry 缺席降级 available:false 不抛错），
 *     全 positional（宿主网关 methodParameterNames 拒绝解构/默认值/rest）；
 *   - 快照结构 = T1 §3 OnebotSettingsSnapshot（revision/entryActive/config(52 键)/
 *     secrets/groups/effect='restart'），accessToken 恒 ''（脱敏，T1 §3）；
 *   - 六组 52 键分组与 schema 默认值 = T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy
 *     = src/settings-remote.ts 常量。
 * 任一侧变更 descriptor/分组/键集/默认值时，必须同步本文件并在 DEVLOG 记录。
 *
 * 生效语义（T1 §5）：19 键统一「保存即热生效」——插件 fiber 秒级原地重启，
 * QQ 桥（NapCat ws-reverse/forward）自动重连；在途回合中断、频控窗口与中间
 * 消息缓冲清零；会话映射/历史不受影响。保存冲突（onebot-settings/conflict）
 * 时提示并重拉快照（revision 语义 = T1 §3.1，任何来源的已提交变更都 +1）。
 */

window.__ModuleLoader__.load({
	id: "dsh-lanxi-qq",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-onebot client: react 不可用");
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-lanxi-qq";
		var REMOTE_NS = "onebotSettings"; // Typert Remote 命名空间（T1 §4，与 host 服务键一致）
		var NS = "dsh-onebot"; // locale 命名空间
		// P0（2026-11-02）：运行状态轮询间隔与事件条数（设置页「运行状态」区）。
		var STATUS_POLL_MS = 30000;
		var EVENTS_LIMIT = 50;
		//#endregion

		//#region 六组 52 键字段定义（T1 §4 表 + W6 诊断组 + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy：分组/键集/类型/默认值；与
		//  src/settings-remote.ts SETTINGS_GROUPS / SCHEMA_DEFAULTS / 类型分组逐字对齐，
		//  tests/client-settings.spec.ts 断言一致性。数值键 dedupWindowSeconds/
		//  actionRatePerMinute/actionRatePerDay/injectIntervalMs 与枚举键 traceLevel
		//  本期不上面板（host 白名单同样不含），仍走 patch config 手改——取舍见 DEVLOG W6。）
		//  2026-11-02：GROUPS 仍是 host 契约分组（组名、顺序、键集不可动，snapshot.groups
		//  与 tests/client-settings.spec.ts 依赖它）；设置页展示改用下方 UI_SECTIONS。
		/** 字段类型：enum（下拉）/ number / boolean / string / stringArray（多行文本）/ secret（密码型）。 */
		var GROUPS = [
			{
				id: "connection",
				title: "连接",
				fields: [
					{ key: "mode", label: "连接模式", type: "enum", options: ["reverse", "forward"], optionLabels: { reverse: "反向 WebSocket（NapCat 连接本插件）", forward: "正向 WebSocket（插件连接 NapCat）" }, hint: "用哪个方向连 NapCat。一般保持反向。" },
					{ key: "host", label: "反向 WS 监听地址", type: "string", hint: "只在反向模式下生效，通常不用改。" },
					{ key: "port", label: "反向 WS 监听端口", type: "number", hint: "只在反向模式下生效；要和 NapCat 那边填的端口一致。" },
					{ key: "url", label: "正向 WS 服务器地址", type: "string", hint: "只在正向模式下生效，例如 ws://127.0.0.1:3001。" },
					{ key: "accessToken", label: "访问令牌", type: "secret", hint: "和 NapCat 侧一致的鉴权令牌；留空表示不修改，勾选下面的框再保存表示清空。" },
					{ key: "botQQ", label: "机器人 QQ 号", type: "string", hint: "机器人自己的号，用来识别 @ 和判断是不是自己发的。" },
					// W7：workspacePath 入面板（connection 组键序追加）。语义（对齐 README「会话工作区选择」）：
					// 修改只对新会话生效；已设 per-chat /workspace 覆盖的会话不受影响。
					{ key: "workspacePath", label: "新会话默认工作区", type: "string", hint: "QQ 会话默认在哪个目录干活。只管新会话；已经用 /workspace 指定过的会话不受影响。留空 = 宿主当前目录。" },
				],
			},
			{
				id: "permissions",
				title: "权限",
				fields: [
					{ key: "requireMention", label: "群里必须 @ 我才回", type: "boolean" },
					{ key: "adminUsers", label: "管理员 QQ 号", type: "stringArray", hint: "每行一个。管理员不受群工具限制。" },
					{ key: "dmPolicy", label: "私聊谁能用", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "groupPolicy", label: "群里谁能用", type: "enum", options: ["open", "allowlist", "disabled"], optionLabels: { open: "开放", allowlist: "白名单", disabled: "禁用" } },
					{ key: "allowAllUsers", label: "允许所有人触发", type: "boolean", hint: "关掉后只有管理员能触发。" },
					{ key: "allowFrom", label: "私聊白名单", type: "stringArray", hint: "每行一个 QQ 号；只在白名单模式下生效。" },
					{ key: "groupAllowFrom", label: "群白名单", type: "stringArray", hint: "每行一个群号；只在白名单模式下生效。" },
				],
			},
			{
				id: "behavior",
				title: "行为",
				fields: [
					{ key: "interimMessages", label: "发中间消息", type: "boolean", hint: "回合还没结束时，先发几句进度。" },
					{ key: "interimRecall", label: "中间消息自动撤回", type: "boolean" },
					{ key: "interimRecallMs", label: "中间消息保留多久（毫秒）", type: "number" },
					{ key: "sendErrorNotice", label: "出错时发通知", type: "boolean" },
					{ key: "unknownCommand", label: "不认识的命令怎么办", type: "enum", options: ["intercept", "passthrough"], optionLabels: { intercept: "拦截", passthrough: "透传" } },
					{ key: "rateLimitPerMinute", label: "每分钟最多发几条", type: "number" },
					{ key: "newMessagePolicy", label: "任务进行中又来消息", type: "enum", options: ["queue", "steer"], optionLabels: { queue: "排队", steer: "插话" }, hint: "排队 = 等当前任务做完再按顺序处理；插话 = 当作补充指令塞进当前任务。图片、文件、语音、引用消息始终排队。" },
					{ key: "autoSteerPolicy", label: "谁能中途插话", type: "enum", options: ["admin", "all"], optionLabels: { admin: "仅管理员", all: "所有成员" }, hint: "只有纯文字消息能自动插话；/steer 命令始终只认管理员，受限用户不会插话。" },
					{ key: "deferredTimeoutMs", label: "模型迟迟不回的超时（毫秒）", type: "number", hint: "超过这个时间还没有任何输出，就提示超时并在任务结束后补发最终文字；0 = 关闭。失败最多重试 3 次，/stop 可以停止补发。" },
				],
			},
			{
				id: "group",
				title: "群聊",
				fields: [
					{ key: "groupReplyCooldownMs", label: "自主接话冷却（毫秒）", type: "number", hint: "没被 @ 的群消息，同一个群在这段时间内只接一次。0 = 不冷却。" },
					{ key: "groupDailyQuota", label: "每个群每天最多接几次", type: "number", hint: "按本地日期算，按回复次数不按气泡数。0 = 不限。" },
					{ key: "groupPeakOnlyMention", label: "上班时段只回 @", type: "boolean", hint: "工作日 9:00–12:00、14:00–18:00，没被 @ 的群消息不接。" },
					{ key: "groupQuietStart", label: "夜间静默开始", type: "string", hint: "格式 HH:MM（北京时间）。要和结束时间成对填；开始晚于结束表示跨午夜。" },
					{ key: "groupQuietEnd", label: "夜间静默结束", type: "string", hint: "格式 HH:MM（北京时间）。到点自动恢复。" },
					{ key: "groupAutoSilence", label: "说了晚安自动静默", type: "boolean", hint: "我发出的消息里出现晚安类关键词后，自动静默到下一个出场点。" },
					{ key: "groupSilentGroupIds", label: "哪些群吃静默", type: "stringArray", hint: "每行一个群号。留空 = 所有群都静默；填了就只限这些群。" },
					{ key: "groupToolPolicy", label: "群里的工具权限", type: "enum", options: ["inherit", "guard"], optionLabels: { inherit: "不设防", guard: "只放行白名单" }, hint: "选「只放行白名单」时，群里非管理员回合只能用下面的工具，其余一律拒绝。私聊不受影响。" },
					{ key: "groupMemberTools", label: "群成员可用的工具", type: "stringArray", hint: "每行一个工具名。别加会开子 agent 的工具。" },
					{ key: "groupMemberPinChat", label: "工具只能发本群", type: "boolean", hint: "群里非管理员回合，发消息类工具只能发给当前群；关掉就允许跨会话发。" },
				],
			},
			{
				id: "extra",
				title: "说话与调试",
				fields: [
					{ key: "bubbleSplit", label: "分条发送（按空行分段）", type: "boolean", hint: "把一条回复按空行分成几个气泡逐条发（短段会合并、超出上限的并入末段）。关掉 = 整条一次发。" },
					{ key: "bubbleMaxMessages", label: "一个回合最多几条", type: "number", hint: "多出来的句子合并进最后一条。" },
					{ key: "bubbleMaxChars", label: "每段大概多长", type: "number", hint: "超过这个长度的整句不硬切，直接单独成段。" },
					{ key: "bubbleGapMinMs", label: "两条之间最短间隔（毫秒）", type: "number" },
					{ key: "bubbleGapMaxMs", label: "两条之间最长间隔（毫秒）", type: "number" },
					{ key: "bubbleLongGapProbability", label: "偶尔长停顿的概率", type: "number", hint: "0 到 1 之间。" },
					{ key: "bubbleLongGapMinMs", label: "长停顿最短（毫秒）", type: "number" },
					{ key: "bubbleLongGapMaxMs", label: "长停顿最长（毫秒）", type: "number" },
					{ key: "bubbleOnlyChats", label: "只在这些会话分条", type: "stringArray", hint: "每行一个 chatId。留空 = 所有会话。" },
					{ key: "dryRun", label: "试运行（只记不发）", type: "boolean", hint: "打开后所有出站消息都不真发，只写日志。换配置前先开它试试最安全。" },
					{ key: "dryRunLogFile", label: "试运行日志存哪", type: "string", hint: "留空 = 用默认位置（用户主目录下的 .dsh/logs/onebot-dryrun.log）。" },
					{ key: "statsDir", label: "每日计数存哪", type: "string", hint: "留空 = 用默认位置（用户主目录下的 .dsh/data/onebot-stats）。每天写一个日期文件，只记类型不记内容。" },
					{ key: "textImageThreshold", label: "超过多少字转成图片", type: "number", hint: "回复正文超过这个字数就渲染成图片卡片；0 = 关闭。" },
				],
			},
			{
				id: "diagnostics",
				title: "诊断",
				fields: [
					{ key: "actionAuditEnabled", label: "记录主动发送审计", type: "boolean", hint: "每次主动发送或转发都记一行到 qq-actions.log，限额拦截也会记。" },
					{ key: "traceEnabled", label: "记录决策追踪", type: "boolean", hint: "把每个收发决策写入 qq-trace.jsonl，排查问题用；关掉就不产生文件。" },
					{ key: "recordInbound", label: "录制收到的消息", type: "boolean", hint: "把收到的消息事件录到 qq-inbox.jsonl，可以离线回放；关掉就不能回放。" },
					{ key: "inboxRedact", label: "录制时隐藏号码", type: "boolean", hint: "录制时把 QQ 号、群号等 6 位以上数字打码；关掉后文件里是明文号码。" },
					{ key: "injectEnabled", label: "事件注入（仅调试）", type: "boolean", hint: "读取 qq-inject.jsonl，把里面的消息喂进真实管线，离线调试用。平时别开。" },
					{ key: "injectDryRun", label: "注入时只记不发", type: "boolean", hint: "默认开，拦截注入产生的所有出站消息；关掉会真的发出去，只在隔离环境用。" },
				],
			},
		];
		/** 全部 52 键扁平表（顺序 = 六组声明顺序，与 host ALL_KEYS 语义一致；T2 起含 newMessagePolicy、T9 起含 autoSteerPolicy、T3 起含 deferredTimeoutMs）。 */
		var ALL_FIELDS = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}
		/** schema 默认值（T1 §4 表；重置按钮与空快照兜底的唯一来源；与
		 *  src/settings-remote.ts SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS = {
			mode: "reverse",
			host: "127.0.0.1",
			port: 8643,
			url: "ws://127.0.0.1:3001",
			accessToken: "",
			botQQ: "",
			workspacePath: "",
			requireMention: true,
			adminUsers: [],
			dmPolicy: "open",
			groupPolicy: "open",
			allowAllUsers: false,
			allowFrom: [],
			groupAllowFrom: [],
			interimMessages: true,
			interimRecall: true,
			interimRecallMs: 90000,
			sendErrorNotice: true,
			unknownCommand: "intercept",
			rateLimitPerMinute: 30,
			newMessagePolicy: "queue",
			autoSteerPolicy: "admin",
			deferredTimeoutMs: 600000,
			actionAuditEnabled: true,
			traceEnabled: false,
			recordInbound: false,
			inboxRedact: false,
			injectEnabled: false,
			injectDryRun: true,
			// 蓝汐 2026-11-02 分叉新增（与 host SCHEMA_DEFAULTS 逐字对齐；两个路径键留空 = 用宿主默认目录）
			groupReplyCooldownMs: 120000,
			groupDailyQuota: 30,
			groupPeakOnlyMention: true,
			groupQuietStart: "",
			groupQuietEnd: "",
			groupAutoSilence: false,
			groupSilentGroupIds: [],
			groupToolPolicy: "inherit",
			groupMemberTools: ["qq_send_image", "qq_send_voice", "qq_send_forward"],
			groupMemberPinChat: true,
			bubbleSplit: false,
			bubbleMaxMessages: 4,
			bubbleMaxChars: 120,
			bubbleGapMinMs: 800,
			bubbleGapMaxMs: 2500,
			bubbleLongGapProbability: 0.2,
			bubbleLongGapMinMs: 4000,
			bubbleLongGapMaxMs: 8000,
			bubbleOnlyChats: [],
			dryRun: false,
			dryRunLogFile: "",
			statsDir: "",
			textImageThreshold: 150,
		};
		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构；供契约核对与快照渲染兜底）。 */
		var GROUP_KEYS = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}
		/** 键 → 字段定义（UI 区按 key 引用字段，避免复制键/默认值）。 */
		var FIELD_BY_KEY = {};
		for (var fk = 0; fk < ALL_FIELDS.length; fk++) FIELD_BY_KEY[ALL_FIELDS[fk].key] = ALL_FIELDS[fk];
		/**
		 * 设置页 UI 分区（只影响渲染，不改变 GROUPS / 键集 / 默认值 / host 契约）。
		 * 52 键按使用场景重新编排：前两组默认展开，其余折叠。
		 * 每个键必须且只能出现一次；下面的自检会在控制台告警漏放/重放。
		 */
		var UI_SECTIONS = [
			{
				id: "connection",
				title: "连接设置",
				desc: "NapCat 怎么连、连哪个号、会话放哪",
				defaultOpen: true,
				keys: ["mode", "host", "port", "url", "accessToken", "botQQ", "workspacePath"],
			},
			{
				id: "group",
				title: "群聊行为",
				desc: "接不接、多久接一次、什么时候闭嘴",
				defaultOpen: true,
				keys: [
					"requireMention", "groupPolicy", "groupAllowFrom",
					"groupReplyCooldownMs", "groupDailyQuota", "groupPeakOnlyMention",
					"groupQuietStart", "groupQuietEnd", "groupAutoSilence", "groupSilentGroupIds",
					"groupToolPolicy", "groupMemberTools", "groupMemberPinChat",
				],
			},
			{
				id: "permissions",
				title: "权限与白名单",
				desc: "谁能私聊、谁能触发、谁是管理员",
				defaultOpen: false,
				keys: ["dmPolicy", "allowAllUsers", "allowFrom", "adminUsers"],
			},
			{
				id: "voice",
				title: "说话方式",
				desc: "分条节奏、中间消息、排队与长文转图",
				defaultOpen: false,
				keys: [
					"bubbleSplit", "bubbleMaxMessages", "bubbleMaxChars",
					"bubbleGapMinMs", "bubbleGapMaxMs", "bubbleLongGapProbability",
					"bubbleLongGapMinMs", "bubbleLongGapMaxMs", "bubbleOnlyChats",
					"textImageThreshold",
					"interimMessages", "interimRecall", "interimRecallMs", "sendErrorNotice",
					"unknownCommand", "rateLimitPerMinute",
					"newMessagePolicy", "autoSteerPolicy", "deferredTimeoutMs",
				],
			},
			{
				id: "audit",
				title: "可靠性审计",
				desc: "出问题时要能查：审计、追踪、录制",
				defaultOpen: false,
				keys: ["actionAuditEnabled", "traceEnabled", "recordInbound", "inboxRedact"],
			},
			{
				id: "advanced",
				title: "高级诊断",
				desc: "试运行、文件位置、事件注入；平时不用动",
				defaultOpen: false,
				keys: ["dryRun", "dryRunLogFile", "statsDir", "injectEnabled", "injectDryRun"],
			},
		];
		for (var us = 0; us < UI_SECTIONS.length; us++) {
			UI_SECTIONS[us].fields = UI_SECTIONS[us].keys.map(function (key) { return FIELD_BY_KEY[key]; }).filter(function (field) { return field != null; });
		}
		/** 52 键覆盖自检：漏放 / 重放只告警，不影响面板运行。 */
		(function assertUiSectionCoverage() {
			var seen = {};
			var duplicated = [];
			var unknown = [];
			for (var si = 0; si < UI_SECTIONS.length; si++) {
				var keys = UI_SECTIONS[si].keys;
				for (var ki = 0; ki < keys.length; ki++) {
					var key = keys[ki];
					if (FIELD_BY_KEY[key] == null) { unknown.push(key); continue; }
					if (seen[key] === true) duplicated.push(key);
					seen[key] = true;
				}
			}
			var missing = ALL_FIELDS.filter(function (field) { return seen[field.key] !== true; }).map(function (field) { return field.key; });
			if (missing.length > 0 || duplicated.length > 0 || unknown.length > 0) {
				console.warn("[dsh-onebot] 设置页分区覆盖异常 漏放:" + missing.join(",") + " 重放:" + duplicated.join(",") + " 未知:" + unknown.join(","));
			}
		})();
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与模板同款）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min, max) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map((entry) => item.parse(entry));
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Remote 契约 schema（与 host lib/settings-remote.js 快照/校验逐字对齐）
		/** 52 键生效值（host buildSnapshot 的 effectiveConfig 全键返回；accessToken 恒 ''）。 */
		var configSchema = vObject({
			mode: vEnum(["reverse", "forward"]),
			host: vString(0, 256),
			port: vNumber(),
			url: vString(0, 512),
			accessToken: vString(0, 256),
			botQQ: vString(0, 64),
			workspacePath: vString(0, 1024),
			requireMention: vBoolean(),
			adminUsers: vArray(vString(0, 64)),
			dmPolicy: vEnum(["open", "allowlist", "disabled"]),
			groupPolicy: vEnum(["open", "allowlist", "disabled"]),
			allowAllUsers: vBoolean(),
			allowFrom: vArray(vString(0, 64)),
			groupAllowFrom: vArray(vString(0, 64)),
			interimMessages: vBoolean(),
			interimRecall: vBoolean(),
			interimRecallMs: vNumber(),
			sendErrorNotice: vBoolean(),
			unknownCommand: vEnum(["intercept", "passthrough"]),
			rateLimitPerMinute: vNumber(),
			newMessagePolicy: vEnum(["queue", "steer"]),
			autoSteerPolicy: vEnum(["admin", "all"]),
			deferredTimeoutMs: vNumber(),
			actionAuditEnabled: vBoolean(),
			traceEnabled: vBoolean(),
			recordInbound: vBoolean(),
			inboxRedact: vBoolean(),
			injectEnabled: vBoolean(),
			injectDryRun: vBoolean(),
			groupReplyCooldownMs: vNumber(),
			groupDailyQuota: vNumber(),
			groupPeakOnlyMention: vBoolean(),
			groupQuietStart: vString(0, 16),
			groupQuietEnd: vString(0, 16),
			groupAutoSilence: vBoolean(),
			groupSilentGroupIds: vArray(vString(0, 64)),
			groupToolPolicy: vEnum(["inherit", "guard"]),
			groupMemberTools: vArray(vString(0, 64)),
			groupMemberPinChat: vBoolean(),
			bubbleSplit: vBoolean(),
			bubbleMaxMessages: vNumber(),
			bubbleMaxChars: vNumber(),
			bubbleGapMinMs: vNumber(),
			bubbleGapMaxMs: vNumber(),
			bubbleLongGapProbability: vNumber(),
			bubbleLongGapMinMs: vNumber(),
			bubbleLongGapMaxMs: vNumber(),
			bubbleOnlyChats: vArray(vString(0, 64)),
			dryRun: vBoolean(),
			dryRunLogFile: vString(0, 1024),
			statsDir: vString(0, 1024),
			textImageThreshold: vNumber(),
		});
		var snapshotSchema = vObject({
			revision: vInt(0),
			entryActive: vBoolean(),
			config: configSchema,
			secrets: vArray(vObject({ path: vArray(vString(1, 64)), set: vBoolean() })),
			groups: vObject({
				connection: vArray(vString(1, 64)),
				permissions: vArray(vString(1, 64)),
				behavior: vArray(vString(1, 64)),
				group: vArray(vString(1, 64)),
				extra: vArray(vString(1, 64)),
				diagnostics: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]), // T1 §5：19 键统一插件级热重启
		});
		/** updateSettings 入参（T1 §4 + W6 + W7：52 键任意子集的扁平 JSON；accessToken 缺省=不改，''=清空）。 */
		var patchSchema = vObject({
			mode: vOptional(vEnum(["reverse", "forward"])),
			host: vOptional(vString(0, 256)),
			port: vOptional(vNumber(1, 65535)),
			url: vOptional(vString(0, 512)),
			accessToken: vOptional(vString(0, 256)),
			botQQ: vOptional(vString(0, 64)),
			workspacePath: vOptional(vString(0, 1024)),
			requireMention: vOptional(vBoolean()),
			adminUsers: vOptional(vArray(vString(0, 64))),
			dmPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			groupPolicy: vOptional(vEnum(["open", "allowlist", "disabled"])),
			allowAllUsers: vOptional(vBoolean()),
			allowFrom: vOptional(vArray(vString(0, 64))),
			groupAllowFrom: vOptional(vArray(vString(0, 64))),
			interimMessages: vOptional(vBoolean()),
			interimRecall: vOptional(vBoolean()),
			interimRecallMs: vOptional(vNumber(0)),
			sendErrorNotice: vOptional(vBoolean()),
			unknownCommand: vOptional(vEnum(["intercept", "passthrough"])),
			rateLimitPerMinute: vOptional(vNumber(0)),
			newMessagePolicy: vOptional(vEnum(["queue", "steer"])),
			autoSteerPolicy: vOptional(vEnum(["admin", "all"])),
			deferredTimeoutMs: vOptional(vNumber(0)),
			actionAuditEnabled: vOptional(vBoolean()),
			traceEnabled: vOptional(vBoolean()),
			recordInbound: vOptional(vBoolean()),
			inboxRedact: vOptional(vBoolean()),
			injectEnabled: vOptional(vBoolean()),
			injectDryRun: vOptional(vBoolean()),
			groupReplyCooldownMs: vOptional(vNumber(0)),
			groupDailyQuota: vOptional(vNumber(0)),
			groupPeakOnlyMention: vOptional(vBoolean()),
			groupQuietStart: vOptional(vString(0, 16)),
			groupQuietEnd: vOptional(vString(0, 16)),
			groupAutoSilence: vOptional(vBoolean()),
			groupSilentGroupIds: vOptional(vArray(vString(0, 64))),
			groupToolPolicy: vOptional(vEnum(["inherit", "guard"])),
			groupMemberTools: vOptional(vArray(vString(0, 64))),
			groupMemberPinChat: vOptional(vBoolean()),
			bubbleSplit: vOptional(vBoolean()),
			bubbleMaxMessages: vOptional(vNumber(1)),
			bubbleMaxChars: vOptional(vNumber(1)),
			bubbleGapMinMs: vOptional(vNumber(0)),
			bubbleGapMaxMs: vOptional(vNumber(0)),
			bubbleLongGapProbability: vOptional(vNumber(0, 1)),
			bubbleLongGapMinMs: vOptional(vNumber(0)),
			bubbleLongGapMaxMs: vOptional(vNumber(0)),
			bubbleOnlyChats: vOptional(vArray(vString(0, 64))),
			dryRun: vOptional(vBoolean()),
			dryRunLogFile: vOptional(vString(0, 1024)),
			statsDir: vOptional(vString(0, 1024)),
			textImageThreshold: vOptional(vNumber(0)),
		});
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host lib/settings-remote.js 服务方法面
		//  逐字对齐：getSettings() / updateSettings(patch, expectedRevision) /
		//  listWorkspaces()（W7），全 positional。
		//  host 侧未导出客户端 descriptor 数组——两侧各自持有一份，本数组为客户端真相源，
		//  变更须同步宿主侧并在 DEVLOG 记录；tests/client-settings.spec.ts 做契约核对。）
	/** W7：listWorkspaces 返回值（host WorkspaceListResult 同构）。 */
	var workspaceListSchema = vObject({
		available: vBoolean(),
		workspaces: vArray(vObject({ id: vString(1, 256), path: vString(0, 1024), sessionCount: vInt(0) })),
	});
	// P0（2026-11-02）：运行状态 / 事件时间线两个只读方法的 wire schema。
	//  与 host lib/settings-remote.js 的 buildStatusResult / buildEventsResult
	//  逐字段对齐；宿主缺方法（旧版）时客户端 catch 后整块隐藏，不炸面板。
	/** getStatus 返回值：连接徽标 + 队列/WAL 深度 + 今日收发与错误数。 */
	var statusResultSchema = vObject({
		available: vBoolean(),
		stale: vBoolean(),
		connected: vBoolean(),
		mode: vString(0, 32),
		selfId: vString(0, 64),
		lastConnectedAt: vNumber(),
		lastDisconnectedAt: vNumber(),
		lastDisconnectReason: vString(0, 256),
		disconnectCount: vInt(0),
		connectedSinceSec: vInt(0),
		probe: vObject({ at: vNumber(), statusOk: vBoolean(), online: vBoolean(), loginOk: vBoolean() }),
		outbox: vObject({ enabled: vBoolean(), pending: vInt(0), inFlight: vInt(0), failed: vInt(0), sent: vInt(0), dropped: vInt(0), deduped: vInt(0) }),
		wal: vObject({ enabled: vBoolean(), unacked: vInt(0), enqWritten: vInt(0), replayed: vInt(0) }),
		today: vObject({ day: vString(0, 16), in: vInt(0), out: vInt(0), errors: vInt(0), byKind: vObject({}) }),
		updatedAt: vNumber(),
	});
	/** getEvents 返回值：最近事件（最新在前），只含元数据无正文。 */
	var eventItemSchema = vObject({
		ts: vNumber(),
		d: vString(0, 16),
		chatId: vString(0, 64),
		kind: vString(0, 32),
		ok: vBoolean(),
		reason: vString(0, 512),
		mid: vOptional(vString(0, 64)),
	});
	var eventsResultSchema = vObject({
		events: vArray(eventItemSchema),
		count: vInt(0),
	});
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: () => schema, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function onebotMethod(method, parameters, resultSchema, typeSymbol) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec(typeSymbol != null ? typeSymbol : "OnebotSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
	var ONEBOT_SETTINGS_DESCRIPTORS = [
		onebotMethod("getSettings", []),
		onebotMethod("updateSettings", [
			jsonParameter("patch", "OnebotSettingsPatch", patchSchema),
			jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
		]),
		onebotMethod("listWorkspaces", [], workspaceListSchema, "WorkspaceListResult"),
		// P0（2026-11-02）：运行状态徽标 + 最近事件时间线（只读）。
		onebotMethod("getStatus", [], statusResultSchema, "OnebotStatusResult"),
		onebotMethod("getEvents", [
			jsonParameter("limit", "number", vOptional(vInt(0))),
			jsonParameter("chatId", "string", vOptional(vString(0, 64))),
		], eventsResultSchema, "OnebotEventsResult"),
	];
		var ONEBOT_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: ONEBOT_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式。
		//  分组标题与字段 label 是中文常量（T4 要求），不走词条。）
		var zh = {
			"settings.title": "QQ 机器人设置",
			"settings.desc": "改完点保存就生效，不用重启宿主；会话和历史不受影响。",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认值",
			"save.submit": "保存设置",
			"save.saving": "正在保存…",
			"save.done": "设置已保存，插件正在自动重启并重连 QQ。",
			"save.noChanges": "没有需要保存的变更。",
			"save.badNumber": "这些数字填得不对：{keys}",
			"effect.hint": "保存后插件会自动重启并重连 NapCat；在途回合会中断，会话映射和历史保留。",
			"effect.entryInactive": "插件当前未激活，保存后可能不生效，请检查加载状态。",
			"secret.set": "已配置（脱敏，不回显）",
			"secret.unset": "未配置",
			"secret.placeholder": "留空 = 不修改",
			"secret.clear": "清除已保存的访问令牌",
		"conflict.title": "保存冲突：设置被其他地方改过（版本号对不上），已经重新拉取最新配置，请核对后再保存。",
		"status.error": "出错",
		"revision.label": "配置版本",
		"meta.summary": "{count} 项设置 · {groups} 组",
		"sections.hint": "最常用的两组已展开，点标题切换",
		"sections.expandAll": "展开全部",
		"sections.collapseAll": "收起全部",
		// P0（2026-11-02）：运行状态 / 事件时间线。
		"runtime.title": "运行状态",
		"runtime.loading": "正在读取运行状态…",
		"runtime.unavailable": "运行状态不可用（宿主暂未提供，或当前没在运行）。",
		"runtime.connected": "已连接",
		"runtime.disconnected": "未连接",
		"runtime.modeReverse": "反向 WS",
		"runtime.modeForward": "正向 WS",
		"runtime.selfId": "机器人",
		"runtime.since": "本次已连",
		"runtime.lastDisconnect": "上次断线",
		"runtime.disconnectCount": "累计断开",
		"runtime.probe": "NapCat 登录探测",
		"runtime.probeOnline": "在线",
		"runtime.probeOffline": "离线/未登录",
		"runtime.stale": "状态文件停更，宿主可能已停止",
		"runtime.todayIn": "今日收到",
		"runtime.todayOut": "今日发出",
		"runtime.todayErrors": "今日错误",
		"runtime.outbox": "待补发",
		"runtime.outboxFailed": "失败",
		"runtime.wal": "入站待确认",
		"runtime.eventsTitle": "最近事件",
		"runtime.eventsToggleShow": "最近事件",
		"runtime.eventsToggleHide": "收起事件",
		"runtime.eventsEmpty": "暂无事件。收发、断线、补发失败会记在这里，只记类型不记内容。",
		"runtime.eventsUpdated": "更新于",
		"runtime.dirIn": "收",
		"runtime.dirOut": "发",
		"runtime.dirConn": "连接",
	};
		var en = {
			"settings.title": "QQ bot settings",
			"settings.desc": "Save to apply; no host restart needed. Sessions and history are unaffected.",
			"settings.loading": "Loading settings…",
			"settings.reload": "Reload",
			"settings.reset": "Reset to defaults",
			"save.submit": "Save settings",
			"save.saving": "Saving…",
			"save.done": "Settings saved. The plugin is restarting and reconnecting to QQ.",
			"save.noChanges": "Nothing to save.",
			"save.badNumber": "These number fields are invalid: {keys}",
			"effect.hint": "Saving restarts the plugin and reconnects NapCat automatically; in-flight turns are interrupted, session mappings and history stay intact.",
			"effect.entryInactive": "The plugin entry is currently inactive; saving may not take effect. Check its load state.",
			"secret.set": "Configured (redacted, never echoed)",
			"secret.unset": "Not configured",
			"secret.placeholder": "Leave empty = keep current",
			"secret.clear": "Clear the saved access token",
		"conflict.title": "Save conflict: settings were changed elsewhere (revision mismatch). The latest snapshot has been re-fetched — review and retry.",
		"status.error": "Error",
		"revision.label": "config version",
		"meta.summary": "{count} settings · {groups} groups",
		"sections.hint": "The two most-used sections are open; click a title to toggle",
		"sections.expandAll": "Expand all",
		"sections.collapseAll": "Collapse all",
		// P0 (2026-11-02): runtime status / event timeline.
		"runtime.title": "Runtime status",
		"runtime.loading": "Reading runtime status…",
		"runtime.unavailable": "Runtime status unavailable (the host does not provide it, or is not running).",
		"runtime.connected": "Connected",
		"runtime.disconnected": "Disconnected",
		"runtime.modeReverse": "reverse WS",
		"runtime.modeForward": "forward WS",
		"runtime.selfId": "bot",
		"runtime.since": "up",
		"runtime.lastDisconnect": "last disconnect",
		"runtime.disconnectCount": "disconnects",
		"runtime.probe": "NapCat login probe",
		"runtime.probeOnline": "online",
		"runtime.probeOffline": "offline/not logged in",
		"runtime.stale": "status file stopped updating; the host may be stopped",
		"runtime.todayIn": "received today",
		"runtime.todayOut": "sent today",
		"runtime.todayErrors": "errors today",
		"runtime.outbox": "pending",
		"runtime.outboxFailed": "failed",
		"runtime.wal": "unacked inbound",
		"runtime.eventsTitle": "Recent events",
		"runtime.eventsToggleShow": "Recent events",
		"runtime.eventsToggleHide": "Hide events",
		"runtime.eventsEmpty": "No events yet. Sends, disconnects and failed redeliveries appear here — metadata only, never message text.",
		"runtime.eventsUpdated": "updated",
		"runtime.dirIn": "in",
		"runtime.dirOut": "out",
		"runtime.dirConn": "conn",
	};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter((key) => !(key in b));
			var extra = Object.keys(b).filter((key) => !(key in a));
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-onebot] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 obx-）
		// 蓝汐个人皮肤 2026-11-02：深海蓝调（主色 #4aa8ff / 深底 #0b1a2b / 次要文字 #9fc2e0 / 正文 #eaf3fc）。
		// 背景只用 linear-gradient + radial-gradient 叠光柱与水波，没有任何外部图片或网络资源。
		// 正文一律用不透明实色，不用 opacity 调淡（opacity 会把文字算淡、拉低对比度）；
		// 对比度按「渐变最亮处」核算，全部 ≥ 4.5:1（最低 6.18:1），
		// 核验数据见 reports/lanxi-qq-设置页个人风格-2026-11-02.md。
		// 动效层 2026-11-02（第二轮，鸿蒙 7 观感）：按钮掠光 1.35s 左上→右下、按下 scale(.98) 弹回、
		// 卡片/折叠标题 hover 描边 0.25s 渐亮、绿点外层扩散环 3s、折叠内容上浮淡入 0.25s、
		// 顶部鲸鱼剪影 20s 横漂 ≤16px。
		// 性能口径：全表只有 2 个 infinite（.obx-dot.ok::after 的 3s 光环、.obx-panel::before 的 20s 漂移），
		// 都只动 transform/opacity；没有 filter:blur、没有 background-position 逐帧、没有全屏动画。
		// prefers-reduced-motion:reduce 只放缓、不再整段 animation:none——本机就是 reduce=true，
		// 上一版那段媒体查询把六种动效全关了，这是「背景看得见、动效一个都没有」的直接原因。
		// 文字色值一个没动（本轮只改 background/border/box-shadow/transform/animation）。
		var CSS = [
			".obx-panel{--obx-ink:#eaf3fc;--obx-ink2:#9fc2e0;--obx-accent:#4aa8ff;--obx-accent2:#7cc4ff;--obx-warm:#f7c46a;--obx-danger:#ff9c8c;--obx-green:#57d98a;--obx-line:rgba(122,190,255,.24);position:relative;isolation:isolate;color-scheme:dark;display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.55;padding:60px 20px 22px;border-radius:18px;border:1px solid rgba(74,168,255,.2);color:var(--obx-ink);background-color:#0b1a2b;background-image:radial-gradient(120% 75% at 84% -10%,rgba(74,168,255,.10),rgba(74,168,255,0) 62%),radial-gradient(80% 55% at 10% -6%,rgba(140,214,255,.07),rgba(140,214,255,0) 68%),repeating-linear-gradient(103deg,rgba(140,214,255,.04) 0 1.5px,rgba(140,214,255,0) 1.5px 26px),repeating-radial-gradient(ellipse 130% 80% at 50% 118%,rgba(140,214,255,.035) 0 1px,rgba(140,214,255,0) 1px 22px),linear-gradient(180deg,#0c1e31 0%,#0b1a2b 46%,#08131f 100%);box-shadow:inset 0 1px 0 rgba(126,206,255,.14)}",
			// 顶部鲸鱼剪影：内联 SVG data URI，opacity .1（≤0.12）；pointer-events:none + z-index:-1 压在内容下方，
			// 且只落在面板顶部 48px 的留白带（padding-top 60px），不覆盖任何文字、输入框或按钮。
			".obx-panel::before{content:\"\";position:absolute;left:0;right:0;top:4px;height:48px;background-image:url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20240%2096'%3E%3Cpath%20fill='%234aa8ff'%20d='M18%2058C30%2038%2064%2030%20100%2030c32%200%2058%208%2072%2016%2010-4%2020-10%2028-16%2010-8%2020-16%2028-18%204%2012%200%2026-8%2034-4%204-8%206-14%206%204%208%204%2016%200%2024-8-6-16-14-22-22-8%208-20%2014-36%2018-26%206-64%204-92-2-18-4-32-8-38-12z'/%3E%3Cpath%20fill='%234aa8ff'%20d='M88%2066c4%2010%2012%2018%2022%2022-6-10-10-18-12-24z'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 22px center;background-size:120px auto;opacity:.1;pointer-events:none;z-index:-1;animation:obx-drift 20s ease-in-out infinite}",
			// 鲸鱼横漂：一个完整周期 20s，位移 0 → -16px → 0（单侧 ≤20px，只动 transform，走合成层）。
			"@keyframes obx-drift{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(-16px,0,0)}}",
			".obx-head{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-start;justify-content:space-between}",
			".obx-head-main{flex:1;min-width:240px}",
			".obx-title{font-size:19px;font-weight:650;margin:0;letter-spacing:.2px;color:var(--obx-ink)}",
			".obx-desc{color:var(--obx-ink2);margin:4px 0 0;font-size:12.5px;max-width:72ch}",
			".obx-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".obx-spacer{flex:1}",
			".obx-meta-row{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;font-size:12px;color:var(--obx-ink2);margin-top:-6px}",
			".obx-meta{color:var(--obx-ink2);font-size:12px}",
			".obx-error{border:1px solid rgba(255,140,120,.55);background:#2a1119;color:#ff9c8c;border-radius:10px;padding:9px 12px;font-size:13px}",
			".obx-alert[role=alert]{white-space:pre-wrap}",
			".obx-notice{color:var(--obx-ink2);min-height:1em;font-size:12.5px;margin:0}",
			".obx-effect{border-left:2px solid rgba(74,168,255,.55);padding:2px 0 2px 10px;color:var(--obx-ink2);font-size:12px;margin-top:-4px}",
			".obx-warn{color:var(--obx-warm)}",
			".obx-sections-bar{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12px;color:var(--obx-ink2)}",
			".obx-sections-bar .obx-meta{margin-right:auto;color:var(--obx-ink2)}",
			".obx-linkbtn{background:none;border:0;color:var(--obx-accent2);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;text-decoration:underline;text-underline-offset:2px}",
			".obx-linkbtn:hover{color:#a9d7ff}",
			".obx-linkbtn:focus-visible,.obx-btn:focus-visible{outline:2px solid var(--obx-accent);outline-offset:2px}",
			".obx-sections{display:flex;flex-direction:column;gap:9px}",
			".obx-section{border:1px solid var(--obx-line);border-radius:14px;background:rgba(14,38,60,.72);overflow:hidden;transition:background-color .25s ease,border-color .25s ease,box-shadow .25s ease}",
			".obx-section.is-open{background:rgba(16,44,70,.78);border-color:rgba(122,190,255,.38)}",
			// hover：淡蓝描边 0.25s 渐亮 + 背景浮起一层极淡的蓝 + 内侧 1px 光环（inset，不会被 overflow:hidden 裁掉）。
			".obx-section:hover{background:rgba(21,52,80,.82);border-color:rgba(122,190,255,.58);box-shadow:inset 0 0 0 1px rgba(122,190,255,.32),0 0 18px -8px rgba(74,168,255,.55)}",
			".obx-section-head{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:12px 16px;background:none;border:0;color:var(--obx-ink);font:inherit;cursor:pointer;text-align:left;transition:background-color .25s ease,box-shadow .25s ease}",
			".obx-section-head:hover{background:rgba(74,168,255,.16);box-shadow:inset 0 0 0 1px rgba(122,190,255,.3)}",
			".obx-section-head:focus-visible{outline:2px solid var(--obx-accent);outline-offset:-2px}",
			".obx-chevron{width:1em;flex:none;color:var(--obx-accent2);font-size:12px}",
			".obx-section-title{font-weight:650;font-size:14.5px;flex:none;color:var(--obx-ink);letter-spacing:.2px}",
			".obx-section-desc{font-size:12px;color:var(--obx-ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}",
			".obx-section-count{font-size:11px;color:var(--obx-ink2);border:1px solid rgba(122,190,255,.3);border-radius:999px;padding:1px 8px;flex:none}",
			".obx-section-changed{font-size:11px;color:var(--obx-warm);border:1px solid rgba(240,180,82,.5);background:rgba(240,180,82,.12);border-radius:999px;padding:1px 8px;flex:none}",
			".obx-section-body{display:flex;flex-direction:column;padding:0 16px 8px;border-top:1px solid rgba(122,190,255,.18);animation:obx-rise .25s cubic-bezier(.2,.7,.3,1) backwards}",
			// 折叠展开：内容从下方 6px 上浮淡入，0.25s；用 backwards（不是 both），动画结束后不残留 transform。
			"@keyframes obx-rise{from{opacity:0;transform:translate3d(0,6px,0)}to{opacity:1;transform:translate3d(0,0,0)}}",
			// 兼容旧 renderGroup 导出（不再用于主面板）。
			".obx-group{display:flex;flex-direction:column;border:1px solid var(--obx-line);border-radius:14px;padding:4px 18px 10px;background:rgba(14,38,60,.72)}",
			".obx-group-title{font-weight:650;margin:10px 0 0;font-size:14.5px;color:var(--obx-ink);letter-spacing:.2px}",
			".obx-field{display:grid;grid-template-columns:210px minmax(0,1fr);gap:4px 18px;align-items:center;padding:10px 0}",
			".obx-field + .obx-field,.obx-field-extra + .obx-field{border-top:1px solid rgba(122,190,255,.14)}",
			".obx-field-extra{grid-column:1/-1;padding:0 0 10px}",
			".obx-label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--obx-ink);min-width:0}",
			".obx-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}",
			".obx-control .obx-control{width:100%}",
			".obx-input,.obx-select,.obx-textarea{width:100%;max-width:420px;box-sizing:border-box;border:1px solid rgba(122,190,255,.34);border-radius:8px;background:#08182a;color:var(--obx-ink);padding:7px 10px;font:inherit;font-size:13px;transition:border-color .15s,box-shadow .15s}",
			".obx-input::placeholder,.obx-textarea::placeholder{color:#8fb2cf;opacity:1}",
			".obx-input:focus,.obx-select:focus,.obx-textarea:focus{outline:none;border-color:var(--obx-accent);box-shadow:0 0 0 3px rgba(74,168,255,.35)}",
			".obx-textarea{max-width:560px;min-height:66px;resize:vertical}",
			".obx-toggle{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;color:var(--obx-ink)}",
			".obx-toggle input{width:16px;height:16px;margin:0;accent-color:var(--obx-accent)}",
			".obx-hint{grid-column:1/-1;color:var(--obx-ink2);font-size:12px;line-height:1.5;margin-top:-1px}",
			".obx-secret-badge{font-size:11px;color:var(--obx-ink2);border:1px solid rgba(122,190,255,.34);border-radius:999px;padding:1px 9px;white-space:nowrap}",
			".obx-badge{font-size:11px;border:1px solid rgba(240,180,82,.5);color:var(--obx-warm);border-radius:999px;padding:1px 9px;background:rgba(240,180,82,.12);white-space:nowrap}",
			".obx-workspace-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:-2px;margin-bottom:10px}",
			".obx-workspace-row .obx-label{color:var(--obx-ink2);font-size:12px}",
			".obx-workspace-row .obx-hint{flex-basis:100%;width:100%;grid-column:auto}",
			".obx-workspace-empty{grid-column:1/-1;margin:0 0 8px}",
			// P0（2026-11-02）：运行状态卡片 + 事件时间线。
			".obx-status-card{display:flex;flex-wrap:wrap;align-items:center;gap:14px 26px;padding:16px 20px;border:1px solid var(--obx-line);border-radius:16px;background:rgba(9,27,44,.72);transition:background-color .25s ease,border-color .25s ease,box-shadow .25s ease}",
			".obx-status-card:hover{background:rgba(20,50,78,.84);border-color:rgba(122,190,255,.58);box-shadow:inset 0 0 0 1px rgba(122,190,255,.32),0 0 18px -8px rgba(74,168,255,.55)}",
			".obx-status-main{display:flex;flex-direction:column;gap:5px;min-width:220px;flex:0 1 auto}",
			".obx-status-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",
			".obx-dot{position:relative;width:10px;height:10px;border-radius:50%;flex:none;background:#9ca3af}",
			".obx-dot.ok{background:var(--obx-green);box-shadow:0 0 0 2px rgba(87,217,138,.3),0 0 10px rgba(87,217,138,.38)}",
			// 双层呼吸：里层 = 绿点本体 + 静态两层柔光（box-shadow，不耗动画）；外层 = ::after 描边圆环 3s 扩散淡出。
			".obx-dot.ok::after{content:\"\";position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(87,217,138,.6);opacity:0;pointer-events:none;animation:obx-halo 3s cubic-bezier(.25,.6,.35,1) infinite}",
			".obx-dot.err{background:#ff6f5e;box-shadow:0 0 0 4px rgba(255,140,120,.16)}",
			".obx-dot.idle{background:#9ca3af;box-shadow:0 0 0 4px rgba(156,163,175,.14)}",
			// 只动 opacity/transform，走合成层；3s 一轮（扩散 0→65%，后面 35% 留给「呼吸」的静止段）。
			"@keyframes obx-halo{0%{opacity:.85;transform:scale(1)}65%{opacity:0;transform:scale(2.4)}100%{opacity:0;transform:scale(2.4)}}",
			".obx-status-title{font-size:16.5px;font-weight:650;color:var(--obx-ink);letter-spacing:.2px}",
			".obx-status-mode{font-size:11px;color:var(--obx-ink2);border:1px solid rgba(122,190,255,.32);border-radius:999px;padding:0 8px}",
			".obx-status-meta{color:var(--obx-ink2);font-size:12px}",
			".obx-status-warn{color:var(--obx-warm);font-size:12px}",
			".obx-status-stats{display:flex;flex-wrap:wrap;gap:10px 28px;flex:1;min-width:200px}",
			".obx-stat{display:flex;flex-direction:column;gap:2px;line-height:1.15;min-width:56px}",
			".obx-stat-num{font-size:23px;font-weight:650;color:var(--obx-ink);font-variant-numeric:tabular-nums;letter-spacing:.2px}",
			".obx-stat-label{font-size:11.5px;color:var(--obx-ink2);white-space:nowrap}",
			".obx-stat-num.err{color:var(--obx-danger)}",
			".obx-stat-num.warn{color:var(--obx-warm)}",
			".obx-events-toggle{flex:none;margin-left:auto;white-space:nowrap}",
			".obx-events-wrap{display:flex;flex-direction:column;gap:6px;margin-top:-4px}",
			".obx-events-head{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--obx-ink2);padding:0 2px}",
			".obx-events{max-height:300px;overflow:auto;border:1px solid var(--obx-line);border-radius:10px;background:rgba(6,18,30,.72);padding:8px 10px;font-size:12px;line-height:1.75}",
			".obx-events-empty{color:var(--obx-ink2);font-size:12px;padding:4px 2px;margin:0}",
			".obx-event-row{display:flex;gap:8px;align-items:baseline;white-space:nowrap}",
			".obx-event-time{color:var(--obx-ink2);font-variant-numeric:tabular-nums;flex:none}",
			".obx-event-dir{font-weight:650;width:2.4em;flex:none}",
			".obx-event-dir.in{color:var(--obx-accent2)}",
			".obx-event-dir.out{color:var(--obx-green)}",
			".obx-event-dir.conn{color:var(--obx-warm)}",
			".obx-event-chat{color:var(--obx-ink2);max-width:170px;overflow:hidden;text-overflow:ellipsis;flex:none}",
			".obx-event-kind{color:var(--obx-ink2);flex:none}",
			".obx-event-reason{color:var(--obx-ink);overflow:hidden;text-overflow:ellipsis}",
			".obx-event-bad{color:var(--obx-danger)}",
			// 按下回弹：按下 0.06s 收到 scale(.98)，松手用 .3s 的 cubic-bezier(.2,1.55,.45,1) 过冲弹回（≈1.02 再落回 1）。
			".obx-btn{position:relative;overflow:hidden;cursor:pointer;border:1px solid rgba(122,190,255,.4);border-radius:8px;background:rgba(74,168,255,.1);color:var(--obx-ink);padding:6px 14px;font:inherit;font-size:13px;transition:border-color .2s ease,background-color .2s ease,transform .3s cubic-bezier(.2,1.55,.45,1)}",
			".obx-btn:hover:not(:disabled){border-color:var(--obx-accent);background:rgba(74,168,255,.2)}",
			// 掠光条：46% 宽、高于按钮 220%，被 .obx-btn 的 overflow:hidden 裁成按钮内的一道斜光。
			".obx-btn::after{content:\"\";position:absolute;top:-60%;bottom:-60%;left:0;width:46%;pointer-events:none;opacity:0;background:linear-gradient(105deg,rgba(255,255,255,0) 0%,rgba(190,228,255,.16) 42%,rgba(255,255,255,.34) 50%,rgba(190,228,255,.16) 58%,rgba(255,255,255,0) 100%);transform:translate3d(-165%,-8%,0) skewX(-18deg)}",
			".obx-btn:hover:not(:disabled)::after,.obx-btn:focus-visible:not(:disabled)::after{animation:obx-sheen 1.35s cubic-bezier(.22,.61,.36,1)}",
			".obx-btn:active:not(:disabled){transform:scale(.98);transition-duration:.06s}",
			// 1.35s 走完：横向 -165% → 320%（左上出、右下收），纵向 -8% → 10% 让光带整体向斜下方压一点。
			"@keyframes obx-sheen{0%{opacity:0;transform:translate3d(-165%,-8%,0) skewX(-18deg)}12%{opacity:1}72%{opacity:.85}100%{opacity:0;transform:translate3d(320%,10%,0) skewX(-18deg)}}",
			".obx-btn:disabled{opacity:.55;cursor:not-allowed}",
			".obx-btn.primary{border-color:var(--obx-accent);background:var(--obx-accent);color:#06203a;font-weight:700}",
			".obx-btn.primary:hover:not(:disabled){background:#6fbcff;border-color:#6fbcff;color:#06203a}",
			".obx-btn.primary::after{background:linear-gradient(105deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.2) 42%,rgba(255,255,255,.4) 50%,rgba(255,255,255,.2) 58%,rgba(255,255,255,0) 100%)}",
			// 本机 matchMedia('(prefers-reduced-motion: reduce)') 实测为 true（Edge/Chromium 同源判定）：
			// 这一块只放缓，绝不写 animation:none / transition:none，否则六种动效会像上一版那样全被关掉。
			"@media (prefers-reduced-motion:reduce){.obx-btn:hover:not(:disabled)::after,.obx-btn:focus-visible:not(:disabled)::after{animation-duration:1.8s}.obx-dot.ok::after{animation-duration:4.2s}.obx-panel::before{animation-duration:32s}.obx-section-body{animation-duration:.2s}}",
			"@media (max-width:720px){.obx-panel{padding:54px 14px 14px}.obx-panel::before{background-position:right 12px center;background-size:96px auto}.obx-head{flex-direction:column}.obx-toolbar{width:100%}.obx-field{grid-template-columns:1fr;gap:4px}.obx-section-body{padding:0 12px 6px}.obx-section-head{padding:11px 12px;gap:8px}.obx-section-desc{display:none}.obx-status-card{padding:14px}.obx-status-stats{gap:8px 20px}.obx-stat-num{font-size:20px}.obx-events-toggle{margin-left:0}.obx-workspace-row .obx-label{width:100%}}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) =>
				Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
		}
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（T1 §3.1：expectedRevision ≠ 当前 revision 拒写，
		 *  host 抛 RemoteError('onebot-settings/conflict')；message 兜底只匹配该
		 *  错误路径本身——不过宽匹配含 "revision" 的无关错误（评审 B5）。 */
		var CONFLICT_RE = /onebot-settings\/conflict/i;
		function isConflictError(cause) {
			if (cause == null) return false;
			return cause.code === "onebot-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** 快照生效值 → 表单草稿（展示形态：number/stringArray/secret 均为可编辑文本；
		 *  accessToken 恒 ''，明文绝不进入草稿——host 快照已脱敏）。 */
		function snapshotValueToDraft(field, value) {
			if (field.type === "secret") return ""; // 脱敏回显：密码框恒空（T1 §3 敏感字段行）
			if (field.type === "stringArray") return Array.isArray(value) ? value.join("\n") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(value);
			if (field.type === "boolean") return value === true;
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值（stringArray 文本 → 行数组；number 文本 → 数字）。 */
		function coerceValue(field, raw) {
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				return Number.isFinite(n) ? n : NaN;
			}
			if (field.type === "boolean") return raw === true;
			if (field.type === "stringArray") {
				return String(raw == null ? "" : raw).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a, b) {
			return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
		}
		/**
		 * 计算保存 patch（T1 §4 + W6 + W7：52 键任意子集的扁平 JSON）。
		 * @param draft 表单草稿（snapshotValueToDraft 形态）
		 * @param config 快照生效值（snapshot.config）
		 * @param opts.secretDraft 密码框输入（'' = 不修改 accessToken）
		 * @param opts.clearSecret true = 显式下发 accessToken: ''（host 语义：'' = 清空）
		 * @returns {patch, invalidKeys} 与生效值有差异的键集合；invalidKeys 为未通过
		 *          客户端数字校验的键（host validatePatch 仍会二次校验）。
		 */
		function computePatch(draft, config, opts) {
			var options = opts == null ? {} : opts;
			var config_ = config == null ? {} : config;
			var patch = {};
			var invalidKeys = [];
			for (var field of ALL_FIELDS) {
				if (field.type === "secret") continue; // accessToken 走 secretDraft/clearSecret 专用通道
				var next = coerceValue(field, draft[field.key]);
				if (field.type === "number" && Number.isNaN(next)) {
					invalidKeys.push(field.key);
					continue;
				}
				if (!valueEquals(next, config_[field.key])) patch[field.key] = next;
			}
			var secretDraft = options.secretDraft;
			if (options.clearSecret === true) patch.accessToken = ""; // host 语义：'' = 清空
			else if (typeof secretDraft === "string" && secretDraft !== "") patch.accessToken = secretDraft;
			// secretDraft 为空且未勾选清除 → 不含 accessToken 键 = 不修改（host 缺省语义）
			return { patch: patch, invalidKeys: invalidKeys };
		}

		/**
		 * W7：把选中的 workspace path 填入草稿（「快速填入」的唯一写入口）。
		 * 纯函数、只返回新草稿对象——绝不触达 remote.updateSettings；保存仍走
		 * 「保存设置」显式通道（computePatch → updateSettings）。
		 */
		function fillWorkspacePath(draft, path) {
			var next = Object.assign({}, draft == null ? {} : draft);
			next.workspacePath = String(path == null ? "" : path);
			return next;
		}
		//#endregion

		//#region 渲染（模块级可测的纯渲染函数：renderGroup 不依赖 hooks/副作用）
		function h(ReactImpl, tag, props) {
			var children = Array.prototype.slice.call(arguments, 3);
			return ReactImpl.createElement.apply(ReactImpl, [tag, props].concat(children));
		}
		/**
		 * 渲染单个字段行（纯函数；值全部经 snapshotValueToDraft 脱敏形态传入，
		 * accessToken 明文按契约绝不进入本函数——host 快照侧已脱敏为 ''）。
		 * 返回 [字段行, 可选附加行]，供 renderGroup / renderSection 复用。
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.onSecretChange (nextText) => void
		 * @param opts.onClearSecretChange (nextBoolean) => void
		 * @param opts.secretSet boolean（快照 secrets 标记：明文是否已配置）
		 * @param opts.clearSecret boolean（清除勾选态）
		 * @param opts.nonDefaultKeys 与 schema 默认值不同的键数组（W6「非默认」徽标；
		 *        以快照生效值为准而非草稿——徽标描述已保存状态，不是未保存编辑）
		 * @param opts.draft 表单草稿（snapshotValueToDraft 形态）
		 */
		function renderFieldRows(ReactImpl, field, opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var onSecretChange = typeof options.onSecretChange === "function" ? options.onSecretChange : function () {};
			var onClearSecretChange = typeof options.onClearSecretChange === "function" ? options.onClearSecretChange : function () {};
			var value = draft[field.key];
			var control;
			if (field.type === "boolean") {
				control = h(ReactImpl, "label", { className: "obx-toggle" },
					h(ReactImpl, "input", {
						type: "checkbox", checked: value === true, disabled: options.disabled === true,
						onChange: function (event) { onChange(field, event.target.checked); },
						"aria-label": field.label,
					}),
					value === true ? "开" : "关");
			} else if (field.type === "enum") {
				var optionLabels = field.optionLabels == null ? {} : field.optionLabels;
				control = h(ReactImpl, "select", {
					className: "obx-select", value: String(value == null ? "" : value), disabled: options.disabled === true,
					onChange: function (event) { onChange(field, event.target.value); },
					"aria-label": field.label,
				}, field.options.map(function (option) {
					return h(ReactImpl, "option", { key: option, value: option }, optionLabels[option] != null ? optionLabels[option] : option);
				}));
			} else if (field.type === "stringArray") {
				control = h(ReactImpl, "textarea", {
					className: "obx-textarea", rows: 3, value: String(value == null ? "" : value), disabled: options.disabled === true,
					placeholder: "每行一个",
					onChange: function (event) { onChange(field, event.target.value); },
					"aria-label": field.label,
				});
			} else if (field.type === "secret") {
				// 密码型输入且不明文回显：value 恒为用户本次输入（初始 ''），占位符提示留空不改；
				// 已配置状态只展示脱敏徽标，绝不渲染任何明文。
				control = h(ReactImpl, "span", { className: "obx-control" },
					h(ReactImpl, "input", {
						type: "password", className: "obx-input", value: String(value == null ? "" : value),
						placeholder: "留空 = 不修改", autoComplete: "new-password", disabled: options.disabled === true,
						onChange: function (event) { onSecretChange(event.target.value); },
						"aria-label": field.label,
					}),
					h(ReactImpl, "span", { className: "obx-secret-badge" }, options.secretSet === true ? "已配置（脱敏，不回显）" : "未配置"),
					h(ReactImpl, "label", { className: "obx-toggle" },
						h(ReactImpl, "input", {
							type: "checkbox", checked: options.clearSecret === true, disabled: options.disabled === true,
							onChange: function (event) { onClearSecretChange(event.target.checked); },
						}),
						"清除已保存的访问令牌"));
			} else {
				control = h(ReactImpl, "input", {
					type: "text", className: "obx-input", value: String(value == null ? "" : value), disabled: options.disabled === true,
					onChange: function (event) { onChange(field, event.target.value); },
					"aria-label": field.label,
				});
			}
			// W6「非默认」徽标：快照生效值 ≠ schema 默认值时标注，帮助一眼识别改过哪些开关。
			var badge = nonDefaultKeys.indexOf(field.key) >= 0
				? h(ReactImpl, "span", { className: "obx-badge", title: "与默认值不同" }, "非默认")
				: null;
			var nodes = [
				h(ReactImpl, "div", { className: "obx-field", key: field.key },
					h(ReactImpl, "div", { className: "obx-label" }, field.label, badge),
					h(ReactImpl, "div", { className: "obx-control" }, control),
					field.hint != null ? h(ReactImpl, "div", { className: "obx-hint" }, field.hint) : null),
			];
			// W7：可选扩展点——字段行后追加附加行（workspacePath 下方的「快速填入 workspace」）。
			if (typeof options.renderExtraRow === "function") {
				var extra = options.renderExtraRow(field);
				if (extra != null) nodes.push(h(ReactImpl, "div", { className: "obx-field-extra", key: field.key + "-extra" }, extra));
			}
			return nodes;
		}
		/** 兼容导出：按 host GROUPS 渲染一整组（主面板已改用 renderSection）。 */
		function renderGroup(ReactImpl, group, opts) {
			var rows = [];
			for (var i = 0; i < group.fields.length; i++) {
				rows = rows.concat(renderFieldRows(ReactImpl, group.fields[i], opts));
			}
			return h(ReactImpl, "section", { className: "obx-group", "data-group": group.id },
				h(ReactImpl, "h3", { className: "obx-group-title" }, group.title),
				rows);
		}
		/**
		 * 渲染一个可折叠的 UI 分区（主面板使用）。
		 * @param opts.open 是否展开
		 * @param opts.onToggle (sectionId) => void
		 * 其余 opts 透传给 renderFieldRows。
		 */
		function renderSection(ReactImpl, section, opts) {
			var options = opts == null ? {} : opts;
			var open = options.open === true;
			var fields = Array.isArray(section.fields) ? section.fields : [];
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var changedCount = 0;
			for (var c = 0; c < fields.length; c++) {
				if (nonDefaultKeys.indexOf(fields[c].key) >= 0) changedCount++;
			}
			var bodyNodes = [];
			if (open) {
				for (var i = 0; i < fields.length; i++) {
					bodyNodes = bodyNodes.concat(renderFieldRows(ReactImpl, fields[i], options));
				}
			}
			return h(ReactImpl, "section", {
				className: "obx-section" + (open ? " is-open" : ""),
				"data-section": section.id,
				key: section.id,
			},
				h(ReactImpl, "button", {
					type: "button", className: "obx-section-head", "aria-expanded": open ? "true" : "false",
					onClick: function () {
						if (typeof options.onToggle === "function") options.onToggle(section.id);
					},
				},
					h(ReactImpl, "span", { className: "obx-chevron", "aria-hidden": "true" }, open ? "▾" : "▸"),
					h(ReactImpl, "span", { className: "obx-section-title" }, section.title),
					section.desc != null ? h(ReactImpl, "span", { className: "obx-section-desc" }, section.desc) : null,
					changedCount > 0 ? h(ReactImpl, "span", { className: "obx-section-changed" }, changedCount + " 项已改") : null,
					h(ReactImpl, "span", { className: "obx-section-count" }, fields.length + " 项")),
				open ? h(ReactImpl, "div", { className: "obx-section-body" }, bodyNodes) : null);
		}
		//#endregion

		/**
		 * W7：渲染 workspacePath 字段下方的「快速填入 workspace」行（纯函数）。
		 * 数据来自面板打开时对 remote.listWorkspaces() 的一次现拉（不缓存陈旧列表）。
		 * 三态：
		 *   - loaded !== true（拉取中/未拉取）→ 不渲染；
		 *   - available !== true 或列表为空 → 隐藏下拉与按钮，仅渲染一行说明
		 *     （可直接输入路径，不阻塞手输）；
		 *   - 正常 → select（选项 = path（N 会话），value = id，避免同名 path 冲突）
		 *     + 「填入」按钮：仅把选中 path 写进输入框当前值（onApply → fillWorkspacePath），
		 *     不自动保存。
		 * @param opts.workspaces host listWorkspaces().workspaces
		 * @param opts.available host listWorkspaces().available
		 * @param opts.loaded 面板打开后拉取是否已完成
		 * @param opts.selectedId 当前选中的 workspace id（'' = 未选）
		 * @param opts.onApply (path: string) => void（填入回调；本函数绝不调用保存）
		 */
		function renderWorkspacePicker(ReactImpl, opts) {
			var options = opts == null ? {} : opts;
			if (options.loaded !== true) return null;
			var workspaces = Array.isArray(options.workspaces) ? options.workspaces : [];
			if (options.available !== true || workspaces.length === 0) {
				return h(ReactImpl, "p", { className: "obx-hint obx-workspace-empty" },
					options.available === true
						? "暂无 workspace 记录，可直接输入路径。"
						: "无法获取 workspace 列表（宿主未提供 workspace 注册表），可直接输入路径。");
			}
			var selectedId = typeof options.selectedId === "string" ? options.selectedId : "";
			var selected = null;
			for (var workspace of workspaces) {
				if (workspace != null && String(workspace.id) === selectedId) selected = workspace;
			}
			var disabled = options.disabled === true;
			return h(ReactImpl, "div", { className: "obx-workspace-row", "data-role": "workspace-picker" },
				h(ReactImpl, "span", { className: "obx-label" }, "快速填入 workspace"),
				h(ReactImpl, "select", {
					className: "obx-select", value: selectedId, disabled: disabled,
					"aria-label": "快速填入 workspace",
					title: "列出宿主 workspace 注册表中的工作区；选中后点「填入」写入上方路径输入框（只填值，保存仍走「保存设置」按钮）",
					onChange: function (event) {
						var onSelectedChange = options.onSelectedChange;
						if (typeof onSelectedChange === "function") onSelectedChange(event.target.value);
					},
				},
					h(ReactImpl, "option", { key: "", value: "" }, "选择 workspace…"),
					workspaces.map(function (workspace) {
						var label = String(workspace.path == null ? "" : workspace.path) + "（" + String(workspace.sessionCount == null ? 0 : workspace.sessionCount) + " 会话）";
						return h(ReactImpl, "option", { key: String(workspace.id), value: String(workspace.id) }, label);
					})),
				h(ReactImpl, "button", {
					className: "obx-btn", type: "button", disabled: disabled || selected == null,
					onClick: function () {
						var onApply = options.onApply;
						if (selected != null && typeof onApply === "function") onApply(selected.path);
					},
				}, "填入"),
				h(ReactImpl, "span", { className: "obx-hint" }, "选中后点「填入」仅写入上方输入框；需点「保存设置」才会保存（对新会话生效，已设 /workspace 覆盖的会话不受影响）。"));
		}

		//#region P0 运行状态渲染（纯函数：renderStatusBadge / renderEventsPanel）
	/** epoch ms → MM-DD HH:MM:SS；0/非法 → '—'。 */
	function fmtClock(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
		var d = new Date(ms);
		var p = function (n) { return String(n).padStart(2, "0"); };
		return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
	}
	/** 秒 → 「N 分 M 秒 / N 小时 M 分」。 */
	function fmtDur(sec) {
		var s = typeof sec === "number" && Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
		if (s < 60) return s + " 秒";
		if (s < 3600) return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
		return Math.floor(s / 3600) + " 小时 " + Math.floor((s % 3600) / 60) + " 分";
	}
	/**
	 * 运行状态卡片（P0，2026-11-02 重排）：左侧绿点/红点 + 状态文字，中间大字号
	 * 横向统计，右侧「最近事件」按钮。三态：加载中 / 不可用 / 有值。
	 * @param opts.t 翻译函数
	 * @param opts.eventsOpen 事件面板是否展开
	 * @param opts.eventsCount 最近事件条数
	 * @param opts.onToggleEvents 右侧按钮回调（缺省时不渲染按钮）
	 */
	function renderStatusCard(ReactImpl, state, opts) {
		var options = state == null ? {} : state;
		var settings = opts == null ? {} : opts;
		var t = settings.t;
		var value = options.value;
		var eventsButton = typeof settings.onToggleEvents === "function"
			? h(ReactImpl, "button", {
				className: "obx-btn obx-events-toggle", type: "button",
				onClick: settings.onToggleEvents,
			}, (settings.eventsOpen === true ? t("runtime.eventsToggleHide") : t("runtime.eventsToggleShow"))
				+ (settings.eventsOpen === true ? "" : " · " + String(settings.eventsCount == null ? 0 : settings.eventsCount)))
			: null;
		if (value == null) {
			var loading = options.failed !== true;
			return h(ReactImpl, "section", { className: "obx-status-card", "data-role": "runtime-status", "aria-label": t("runtime.title") },
				h(ReactImpl, "div", { className: "obx-status-main" },
					h(ReactImpl, "div", { className: "obx-status-head" },
						h(ReactImpl, "span", { className: "obx-dot idle", "aria-hidden": "true" }),
						h(ReactImpl, "span", { className: "obx-status-title" }, loading ? t("runtime.loading") : t("runtime.unavailable")))),
				eventsButton);
		}
		var tone = value.stale === true ? "idle" : (value.connected === true ? "ok" : "err");
		var title = value.connected === true ? t("runtime.connected") : t("runtime.disconnected");
		var modeLabel = value.mode === "forward" ? t("runtime.modeForward") : (value.mode !== "" ? t("runtime.modeReverse") : "");
		var meta = [];
		if (value.selfId !== undefined && value.selfId !== "") meta.push(t("runtime.selfId") + " " + value.selfId);
		if (value.connected === true) {
			meta.push(t("runtime.since") + " " + fmtDur(value.connectedSinceSec));
		} else if (value.lastDisconnectedAt > 0) {
			meta.push(t("runtime.lastDisconnect") + " " + fmtClock(value.lastDisconnectedAt)
				+ (value.lastDisconnectReason !== "" ? "（" + value.lastDisconnectReason + "）" : "")
				+ " · " + t("runtime.disconnectCount") + " " + value.disconnectCount);
		}
		var probeNode = null;
		if (value.probe != null && value.probe.at > 0) {
			probeNode = h(ReactImpl, "div", { className: "obx-status-meta" },
				t("runtime.probe") + "：" + (value.probe.loginOk === true ? t("runtime.probeOnline") : t("runtime.probeOffline"))
				+ "（" + fmtClock(value.probe.at) + "）");
		}
		var today = value.today == null ? { in: 0, out: 0, errors: 0 } : value.today;
		var outbox = value.outbox == null ? { enabled: false, pending: 0, failed: 0 } : value.outbox;
		var wal = value.wal == null ? { enabled: false, unacked: 0 } : value.wal;
		var stats = [
			{ key: "in", label: t("runtime.todayIn"), value: today.in },
			{ key: "out", label: t("runtime.todayOut"), value: today.out },
			{ key: "err", label: t("runtime.todayErrors"), value: today.errors, tone: today.errors > 0 ? "err" : "" },
		];
		if (outbox.enabled === true) {
			stats.push({ key: "pending", label: t("runtime.outbox"), value: outbox.pending, tone: outbox.pending > 0 ? "warn" : "" });
			if (outbox.failed > 0) stats.push({ key: "failed", label: t("runtime.outboxFailed"), value: outbox.failed, tone: "err" });
		}
		if (wal.enabled === true && wal.unacked > 0) {
			stats.push({ key: "wal", label: t("runtime.wal"), value: wal.unacked, tone: "warn" });
		}
		var statNodes = stats.map(function (stat) {
			return h(ReactImpl, "div", { className: "obx-stat", key: stat.key },
				h(ReactImpl, "span", { className: "obx-stat-num" + (stat.tone !== "" ? " " + stat.tone : "") }, String(stat.value)),
				h(ReactImpl, "span", { className: "obx-stat-label" }, stat.label));
		});
		return h(ReactImpl, "section", { className: "obx-status-card", "data-role": "runtime-status", "aria-label": t("runtime.title") },
			h(ReactImpl, "div", { className: "obx-status-main" },
				h(ReactImpl, "div", { className: "obx-status-head" },
					h(ReactImpl, "span", { className: "obx-dot " + tone, "aria-hidden": "true" }),
					h(ReactImpl, "span", { className: "obx-status-title" }, title),
					modeLabel !== "" ? h(ReactImpl, "span", { className: "obx-status-mode" }, modeLabel) : null),
				meta.length > 0 ? h(ReactImpl, "div", { className: "obx-status-meta" }, meta.join(" · ")) : null,
				probeNode,
				value.stale === true ? h(ReactImpl, "div", { className: "obx-status-warn" }, t("runtime.stale") + "（" + fmtClock(value.updatedAt) + "）") : null),
			h(ReactImpl, "div", { className: "obx-status-stats" }, statNodes),
			eventsButton);
	}
	/** 兼容导出：旧调用方按徽标语义使用，内部走新的状态卡片。 */
	function renderStatusBadge(ReactImpl, state, t) {
		return renderStatusCard(ReactImpl, state, { t: t });
	}
	/**
	 * 最近事件时间线（P0）：最新在前；方向（收/发/连接）着色，ok:false 红字。
	 * 只含元数据（时间/会话/类型/结果），绝不展示消息正文。
	 * 展开/收起按钮在状态卡片右侧，本函数只渲染列表。
	 * @param opts.events 事件数组（getEvents 结果）
	 * @param opts.updatedAt 最近一次拉取时间
	 */
	function renderEventsPanel(ReactImpl, opts) {
		var options = opts == null ? {} : opts;
		var events = Array.isArray(options.events) ? options.events : [];
		var t = options.t;
		var rows = events.map(function (event, index) {
			var dir = event.d === "in" ? "in" : event.d === "out" ? "out" : event.d === "conn" ? "conn" : "";
			var dirLabel = dir === "in" ? t("runtime.dirIn") : dir === "out" ? t("runtime.dirOut") : dir === "conn" ? t("runtime.dirConn") : (event.d || "?");
			return h(ReactImpl, "div", { className: "obx-event-row", key: String(event.ts) + "-" + index },
				h(ReactImpl, "span", { className: "obx-event-time" }, fmtClock(event.ts)),
				h(ReactImpl, "span", { className: "obx-event-dir " + dir }, dirLabel),
				event.chatId !== undefined && event.chatId !== ""
					? h(ReactImpl, "span", { className: "obx-event-chat", title: String(event.chatId) }, String(event.chatId))
					: null,
				event.kind !== undefined && event.kind !== ""
					? h(ReactImpl, "span", { className: "obx-event-kind" }, String(event.kind))
					: null,
				h(ReactImpl, "span", { className: "obx-event-reason" + (event.ok === false ? " obx-event-bad" : "") },
					(event.ok === false ? "✗ " : "") + String(event.reason == null ? "" : event.reason)));
		});
		return h(ReactImpl, "div", { className: "obx-events-wrap" },
			h(ReactImpl, "div", { className: "obx-events-head" },
				h(ReactImpl, "span", null, t("runtime.eventsTitle")),
				h(ReactImpl, "span", null, t("runtime.eventsUpdated") + " " + fmtClock(options.updatedAt))),
			h(ReactImpl, "div", { className: "obx-events", "data-role": "runtime-events" },
				rows.length > 0 ? rows : h(ReactImpl, "p", { className: "obx-events-empty" }, t("runtime.eventsEmpty"))));
	}
	//#endregion

	//#region 面板组件
		/**
		 * QQ Bot 设置面板。
		 * @param props t 为宿主注入的翻译函数（locale: NS，语言切换自动重渲染）；
		 *        remote 为挂载后的 `remote.onebotSettings` API。
		 */
		function OnebotSettingsPanel(props) {
			var t = props.t;
			var remote = props.remote;
			var snapshotState = React.useState(null);
			var snapshot = snapshotState[0];
			var setSnapshot = snapshotState[1];
			var draftState = React.useState(null);
			var draft = draftState[0];
			var setDraft = draftState[1];
			var secretState = React.useState("");
			var secretDraft = secretState[0];
			var setSecretDraft = secretState[1];
			var clearSecretState = React.useState(false);
			var clearSecret = clearSecretState[0];
			var setClearSecret = clearSecretState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
		// W7：「快速填入 workspace」数据态——面板打开时（挂载 effect）对
		// remote.listWorkspaces() 现拉一次，不缓存跨会话的陈旧列表。
		var workspaceState = React.useState({ loaded: false, available: false, workspaces: [], selectedId: "" });
		var workspace = workspaceState[0];
		var setWorkspace = workspaceState[1];
		// P0（2026-11-02）：运行状态（连接徽标 + 今日统计 + 队列/WAL 深度）与
		// 最近事件时间线。30s 轮询；瞬时失败保持上次已知值，宿主缺方法时
		// 整块降级为一行提示，绝不影响设置表单本身。
		var runtimeStatusState = React.useState({ loading: true, failed: false, value: null });
		var runtimeStatus = runtimeStatusState[0];
		var setRuntimeStatus = runtimeStatusState[1];
		var runtimeEventsState = React.useState({ loaded: false, events: [], updatedAt: 0 });
		var runtimeEvents = runtimeEventsState[0];
		var setRuntimeEvents = runtimeEventsState[1];
		var eventsOpenState = React.useState(false);
		var eventsOpen = eventsOpenState[0];
		var setEventsOpen = eventsOpenState[1];
		// 2026-11-02：分区折叠态——默认只展开 UI_SECTIONS 里标了 defaultOpen 的组。
		var sectionOpenState = React.useState(function () {
			var initial = {};
			for (var i = 0; i < UI_SECTIONS.length; i++) initial[UI_SECTIONS[i].id] = UI_SECTIONS[i].defaultOpen === true;
			return initial;
		});
		var sectionOpen = sectionOpenState[0];
		var setSectionOpen = sectionOpenState[1];
		var toggleSection = function (id) {
			var next = Object.assign({}, sectionOpen);
			next[id] = sectionOpen[id] !== true;
			setSectionOpen(next);
		};
		var setAllSections = function (open) {
			var next = {};
			for (var i = 0; i < UI_SECTIONS.length; i++) next[UI_SECTIONS[i].id] = open === true;
			setSectionOpen(next);
		};

			/** 接受新快照：草稿按快照重置（accessToken 明文绝不进入草稿）。 */
			var accept = function (next) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
			};

			React.useEffect(function () {
				var alive = true;
				void remote.getSettings().then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				// W7：辅助查询独立拉取——失败（含 RPC 异常）降级为 unavailable 提示行，
				// 绝不阻塞/污染 getSettings 主链路与错误横幅。
				void Promise.resolve().then(function () {
					return remote.listWorkspaces();
				}).then(function (result) {
					if (!alive) return;
					var value = unwrap(result);
					setWorkspace({
						loaded: true,
						available: value != null && value.available === true,
						workspaces: value != null && Array.isArray(value.workspaces) ? value.workspaces : [],
						selectedId: "",
					});
				}).catch(function () {
					if (alive) setWorkspace({ loaded: true, available: false, workspaces: [], selectedId: "" });
				});
			return function () { alive = false; };
		}, [remote]);

		// P0：运行状态/事件轮询（独立于 getSettings 主链路，失败互不影响）。
		React.useEffect(function () {
			var alive = true;
			var timer;
			var poll = function () {
				Promise.resolve().then(function () { return remote.getStatus(); })
					.then(function (result) {
						if (!alive) return;
						setRuntimeStatus({ loading: false, failed: false, value: unwrap(result) });
					})
					.catch(function () {
						if (!alive) return;
						// 瞬时失败保持上次已知值；从没拿到过才标记不可用。
						setRuntimeStatus(function (prev) {
							return { loading: false, failed: prev.value === null, value: prev.value };
						});
					});
				Promise.resolve().then(function () { return remote.getEvents(EVENTS_LIMIT, ""); })
					.then(function (result) {
						if (!alive) return;
						var value = unwrap(result);
						setRuntimeEvents({
							loaded: true,
							events: value != null && Array.isArray(value.events) ? value.events : [],
							updatedAt: Date.now(),
						});
					})
					.catch(function () { /* 事件拉取失败：保留上次列表 */ });
			};
			poll();
			timer = setInterval(poll, STATUS_POLL_MS);
			return function () { alive = false; if (timer !== undefined) clearInterval(timer); };
		}, [remote]);

			var refetch = function () {
				void remote.getSettings().then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)；冲突时提示并重拉快照。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
				var computed = computePatch(draft, snapshot.config, { secretDraft: secretDraft, clearSecret: clearSecret });
				if (computed.invalidKeys.length > 0) {
					var labels = computed.invalidKeys.map(function (key) {
						var field = ALL_FIELDS.find(function (item) { return item.key === key; });
						return field != null ? field.label : key;
					});
					setError(format(t("save.badNumber"), { keys: labels.join("、") }));
					return;
				}
				if (Object.keys(computed.patch).length === 0) {
					setNotice(t("save.noChanges"));
					return;
				}
				setBusy(true);
				void Promise.resolve().then(function () {
					return remote.updateSettings(computed.patch, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(t("save.done")); // 生效方式提示（T1 §5）：热生效、插件秒级重启、桥重连
					setClearSecret(false);
					setSecretDraft("");
				}).catch(function (cause) {
					if (isConflictError(cause)) {
						// T1 §3.1：revision 不一致 → 提示并重拉快照，用户核对后重放
						setError(t("conflict.title"));
						refetch();
					} else {
						setError(messageOf(cause));
					}
				}).finally(function () {
					setBusy(false);
				});
			};

			if (snapshot === null || draft === null) {
				return h(React, "div", { className: "obx-panel" },
					h(React, "p", { className: "obx-hint" }, t("settings.loading")),
					error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error));
			}

			var secretSet = false;
			if (Array.isArray(snapshot.secrets)) {
				for (var secretEntry of snapshot.secrets) {
					if (secretEntry != null && Array.isArray(secretEntry.path) && secretEntry.path.indexOf("accessToken") >= 0 && secretEntry.set === true) secretSet = true;
				}
			}
			if (clearSecret === true) secretSet = false; // 勾选清除后按“将清空”展示

			// W6「非默认」徽标数据源：快照生效值 vs schema 默认值（DEFAULTS），
			// 反映已保存状态；草稿未保存的改动不打徽标。
			var nonDefaultKeys = [];
			if (snapshot.config != null) {
				for (var field of ALL_FIELDS) {
					if (valueEquals(snapshot.config[field.key], DEFAULTS[field.key]) === false) nonDefaultKeys.push(field.key);
				}
			}

			var changeHandlers = {
				disabled: busy,
				secretSet: secretSet,
				clearSecret: clearSecret,
				nonDefaultKeys: nonDefaultKeys,
				draft: draft,
				// W7：workspacePath 字段行下方的「快速填入 workspace」行（独立于
				// obx-field 行；onApply 只写草稿不保存——保存仍走 save() 显式通道）。
				renderExtraRow: function (field) {
					if (field.key !== "workspacePath") return null;
					return renderWorkspacePicker(React, {
						loaded: workspace.loaded,
						available: workspace.available,
						workspaces: workspace.workspaces,
						selectedId: workspace.selectedId,
						disabled: busy,
						onSelectedChange: function (nextId) {
							setWorkspace(Object.assign({}, workspace, { selectedId: nextId }));
						},
						onApply: function (path) {
							setDraft(fillWorkspacePath(draft, path));
						},
					});
				},
				onChange: function (field, nextValue) {
					setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
				},
				onSecretChange: function (nextText) {
					setSecretDraft(nextText);
					setDraft(Object.assign({}, draft, (function () { var next = {}; next.accessToken = nextText; return next; })()));
				},
				onClearSecretChange: function (nextChecked) {
					setClearSecret(nextChecked);
				},
			};

			return h(React, "div", { className: "obx-panel" },
				h(React, "div", { className: "obx-head" },
					h(React, "div", { className: "obx-head-main" },
						h(React, "h2", { className: "obx-title" }, t("settings.title")),
						h(React, "p", { className: "obx-desc" }, t("settings.desc"))),
					h(React, "div", { className: "obx-toolbar" },
						h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: refetch }, t("settings.reload")),
						h(React, "button", { className: "obx-btn", type: "button", disabled: busy, onClick: function () { setDraft(draftFromDefaults()); } }, t("settings.reset")),
						h(React, "button", { className: "obx-btn primary", type: "button", disabled: busy, onClick: save }, busy ? t("save.saving") : t("save.submit")))),
				h(React, "div", { className: "obx-meta-row" },
					h(React, "span", { className: "obx-meta" }, t("revision.label") + " " + String(snapshot.revision)),
					h(React, "span", { className: "obx-meta" }, format(t("meta.summary"), { count: ALL_FIELDS.length, groups: UI_SECTIONS.length })),
					snapshot.entryActive === true ? null : h(React, "span", { className: "obx-meta obx-warn" }, t("effect.entryInactive"))),
				h(React, "div", { className: "obx-effect" }, t("effect.hint")),
				error === null ? null : h(React, "div", { className: "obx-error", role: "alert" }, t("status.error") + "：" + error),
				notice === "" ? null : h(React, "p", { className: "obx-notice" }, notice),
				// P0（2026-11-02）：运行状态卡片——绿点连接状态 + 大字号统计 +
				// 右侧「最近事件」按钮（只读；与 /status、/doctor 诊断包同源）。
				renderStatusCard(React, runtimeStatus, {
					t: t,
					eventsOpen: eventsOpen,
					eventsCount: runtimeEvents.events.length,
					onToggleEvents: function () { setEventsOpen(eventsOpen === true ? false : true); },
				}),
				eventsOpen === true
					? renderEventsPanel(React, { events: runtimeEvents.events, updatedAt: runtimeEvents.updatedAt, t: t })
					: null,
				h(React, "div", { className: "obx-sections-bar" },
					h(React, "span", { className: "obx-meta" }, t("sections.hint")),
					h(React, "button", { className: "obx-linkbtn", type: "button", onClick: function () { setAllSections(true); } }, t("sections.expandAll")),
					h(React, "button", { className: "obx-linkbtn", type: "button", onClick: function () { setAllSections(false); } }, t("sections.collapseAll"))),
				h(React, "div", { className: "obx-sections" },
					UI_SECTIONS.map(function (section) {
						return renderSection(React, section, Object.assign({}, changeHandlers, {
							open: sectionOpen[section.id] === true,
							onToggle: toggleSection,
						}));
					})));
		}
		//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（对照先例：只回收 Remote 挂载；
		 *          样式/词条/slot 注册由宿主 ctx.effect 与 slot 生命周期回收）。
		 */
		async function apply(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "onebot-settings: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "onebot-settings: dictionaries");
			var t = ctx.locale.bind(NS);

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.onebotSettings 会要求预先注入并死锁（先例同款注释）。
			var disposeRemote = await ctx.remote.$mount(ONEBOT_SETTINGS_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			if (remote === undefined) throw new Error("onebot-settings Remote 挂载后不可用");

			ctx.slots.inject("plugins.bundle.config", function () { return ctx.slots.register(
				{ name: "plugins.bundle.config", key: "dsh-lanxi-qq", locale: NS },
				function (props) { if (props && props.view === "summary") return t("settings.desc"); return React.createElement(OnebotSettingsPanel, Object.assign({}, props, { remote: remote })); },
			); });

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.ONEBOT_SETTINGS_REMOTE = ONEBOT_SETTINGS_REMOTE;
		exports.ONEBOT_SETTINGS_DESCRIPTORS = ONEBOT_SETTINGS_DESCRIPTORS;
		exports.GROUPS = GROUPS;
		exports.ALL_FIELDS = ALL_FIELDS;
		exports.DEFAULTS = DEFAULTS;
		exports.GROUP_KEYS = GROUP_KEYS;
		// 2026-11-02：设置页 UI 分区（只影响渲染；GROUPS/键集/默认值不变）。
		exports.UI_SECTIONS = UI_SECTIONS;
		exports.UI_SECTION_KEYS = UI_SECTIONS.reduce(function (acc, section) { acc[section.id] = section.keys.slice(); return acc; }, {});
		exports.computePatch = computePatch;
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.fillWorkspacePath = fillWorkspacePath;
		exports.renderWorkspacePicker = renderWorkspacePicker;
		exports.isConflictError = isConflictError;
		exports.unwrap = unwrap;
		exports.renderGroup = renderGroup;
		exports.renderFieldRows = renderFieldRows;
		exports.renderSection = renderSection;
		exports.OnebotSettingsPanel = OnebotSettingsPanel;
		// P0（2026-11-02）：运行状态渲染纯函数（可单测）。
		exports.renderStatusCard = renderStatusCard;
		exports.renderStatusBadge = renderStatusBadge;
		exports.renderEventsPanel = renderEventsPanel;
		exports.fmtClock = fmtClock;
		exports.fmtDur = fmtDur;

		return module.exports;
	}
});
