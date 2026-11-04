# dsh-lanxi-qq

把 QQ 接进 DeepSeek Harness 的通道插件，从 `dsh-onebot-qq@0.9.4` 分叉而来。

本分叉由**蓝汐**维护，在上游基础上加了群聊自由度控制、说话方式调节和每日收发统计。
想装上游原版请去 https://github.com/mario841859784/dsh-onebot ；上游完整文档见 `README.upstream.md`。

## 和上游的区别

**群聊**

- 自主接话冷却：没被 @ 的群消息，同一群在冷却窗口内只接一次
- 每日发言预算：按本地日期算，到量就闭嘴，第二天自动恢复
- 高峰时段只回 @：工作日 9-12、14-18 点，没被 @ 一律不接
- 夜间静默：设定起止时间，中间只有管理员 @ 或喊名字能穿透
- 自动静默：发出去的消息命中晚安类关键词，自动静默到下一个出场点
- 静默生效范围：可以只对某几个群生效
- 群聊工具硬闸：非管理员回合只能调用白名单里的工具，防止群里有人借我之手开子 agent。**默认不启用**（`groupToolPolicy` 默认 `inherit` 不设防）；要开启就在配置里设 `groupToolPolicy: guard`，并用 `groupMemberTools` 配白名单
- 工具只能发本群：非管理员的发消息类工具，chat_id 必须指向当前群

**说话方式**

- 分条发送：把一条回复按句子切成几个气泡，中间带随机间隔和长停顿，像人在打字
- 长文转图：超过阈值的长回复渲染成图片卡片
- 试运行（dryRun）：所有出站消息不真发，只写日志——换配置时先开它，安全
- 每日收发计数：每次收发按日期往 statsDir/YYYY-MM-DD.jsonl 追加一行，只记类型不记内容

**可靠性**

- 空 token 不自杀：没配访问令牌时插件保持 ACTIVE、标「未配置」、不监听，而不是抛错把整个插件拽下来
- canvas 懒加载：机器上没有 @napi-rs/canvas 的预编译包时降级为纯文字，不会 import 失败
- 默认路径不写死：试运行日志和计数目录默认落在 ~/.dsh/ 下，不绑死某台机器的盘符

## 设置界面

装上以后，DSH 设置页里的「QQ 通道」会多出两组：

- **群聊**：冷却、每日预算、高峰限制、静默时段、静默生效群、工具硬闸、工具白名单
- **说话与调试**：分条发送的五个参数、试运行开关与日志路径、每日计数目录、长文转图阈值

一共 52 个可调的键，点点点就行，不用改 yml。

## 装之前

1. 必须完全退出 DSH 再装（不是关窗口，是退出进程）。运行中的 DSH 锁着 @napi-rs/canvas 的原生模块，安装会报 EPERM。
2. 装完要重启 DSH 才生效。
3. 建议用小号。非官方 QQ 工具都有账号风险。

## 怎么装（推荐：插件市场 / npm）

本插件已发布到 npm（包名 `dsh-lanxi-qq`）并收录进 DSH 插件市场精选列表，两种装法二选一：

1. **市场一键装**：DSH 设置 → 插件市场，搜 `dsh-lanxi-qq`，点安装。
2. **命令行装**（以 `desktop` profile 为例）：

```
dsh plugin --profile desktop add dsh-lanxi-qq
```

装完重启 DSH，进设置页找「QQ 通道」，把 NapCat 的 WebSocket 地址和令牌填上，保存。

> 如果机器上还装着上游 `dsh-onebot-qq`，先按下面「怎么退」卸掉再装本插件——两个 QQ 通道同时连同一个 NapCat 会互相抢消息。

## 开发者：从本地源码装

想改代码或试用未发布版本时，才需要从本地源码装（profile 以 `desktop` 为例，源码目录替换成你自己的）：

1. 完全退出 DSH。
2. 改 `C:\Users\<你>\.dsh\profiles\desktop\package.json`，两处都要改：

```json
"dependencies": {
  "dsh-lanxi-qq": "file:<你放源码的目录>"
},
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-lanxi-qq"
    ]
  }
}
```

3. 在 profile 目录里跑 `pnpm install`，然后重启 DSH。

## 怎么退

把 package.json 里两处 dsh-lanxi-qq 删掉，pnpm install，重启。市场装的话，在插件市场卡片上点卸载即可。

## 市场收录

本插件已发布到 npm 并收录进精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（注册表由该仓库 CI 每日生成，站点 awesome-dsh-plugin.com 与 DSH 内置市场同源）。列表条目不含版本号，发新版本只改 npm 包即可，市场通常一天内同步。

## 已知的坑

- 改名必须三处一起改：package.json 的 name、包内 cordis.patch.yml 的两个 name、profile cordis.patch.yml 里那个条目的 name。漏一处，几十个配置键会静默失效——accessToken 丢了连不上 NapCat，groupToolPolicy 丢了群闸退回不设防，而且不报错。
- 两个 QQ 通道插件不能同时装。DSH 会崩溃循环。
- 装完插件或跑过 pnpm install，手改过的文件可能被冲掉。如果你也在打补丁，先备份 lib/。
- 试运行（dryRun）打开时消息不会真发出去，只在日志里留一行。别开着它查「为什么对方收不到」。
- 每日计数只记类型不记内容，但 dryRunLogFile 是记内容前 120 字的，别把敏感对话开着试运行跑。

## 许可

BSD 3-Clause，见 LICENSE。上游版权归 dsh-external contributors，本分叉的修改归蓝汐。

上游：https://github.com/mario841859784/dsh-onebot

本仓库不代表上游，上游也不为本仓库的任何问题负责。

## 兼容

- 在 DSH 0.2.1-rc.3 上装过
- Node >= 22