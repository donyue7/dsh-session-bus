# dsh-session-bus

[![npm](https://img.shields.io/npm/v/dsh-session-bus.svg)](https://www.npmjs.com/package/dsh-session-bus)
[![test](https://github.com/donyue7/dsh-session-bus/actions/workflows/test.yml/badge.svg)](https://github.com/donyue7/dsh-session-bus/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DSH 会话总线插件：让**同一个工作区**或**不同工作区**的两个会话互相推送消息，并自动唤醒被推送方继续工作 —— 不需要用户手动暂停会话、复制、粘贴。

```
会话 A ──bus_send──▶ 会话总线 ──▶ 会话 B（冷启动会被唤醒，空闲则立刻开始新回合）
   ▲                                        │
   └──────────────bus_send 回复─────────────┘
```

## 它解决了什么

原先要让 A 会话把任务交给 B 会话，只能：暂停 B → 复制 A 的输出 → 切到 B 粘贴 → 回车。
本插件把这条链路变成一次工具调用：

- **自动唤醒**：目标会话是冷的（进程里没有 Agent）会被 `resume`；空闲会话直接开始新回合。
- **跨工作区**：目标会话在别的目录也能投递，Agent 在它自己的工作目录里继续干活。
- **真·用户消息语义**：投递的消息就是一条 `user` 角色消息，进入目标会话日志、可被压缩、可被检索。
  默认带 DSH 的 `agent-message` source，所以前端把它显示成**左侧「收到任务消息」卡片**而不是右侧气泡 ——
  让读的人一眼看出"这不是我自己发的"（想还原成右侧气泡可设 `inboundPresentation: bubble`）。
- **可回复**：被推送方看到 `[session-bus v1] from=<会话id>`，用 `bus_send` 把结果发回源会话，源会话同样被唤醒。

## 安装

### 从 npm 安装（推荐）

包已发布在 npm：**https://www.npmjs.com/package/dsh-session-bus**（`latest` 版本见顶部徽章）。

```powershell
cd <profile>                 # 例如 C:\Users\<你>\.dsh-harness-next\profiles\desktop
npm i dsh-session-bus        # 装进 profile 自己的 node_modules
```

然后在同一目录的 `package.json` 里把包名加进 `dsh.profile.bundles`（`npm i` 已自动写入 `dependencies`）：

```json
{
  "dsh": { "profile": { "bundles": ["dsh-session-bus"] } }
}
```

重启 DSH 后插件会出现在「设置 → 插件」页，`bus_*` 工具即可使用。

### 从源码安装

插件源码在本目录，安装脚本把它复制进 DSH profile 并在该 profile 的 `cordis.patch.yml`
里插入一行挂载条目（用标记注释包裹，可完整卸载）：

```powershell
# 默认：复制到 <profile>/node_modules/dsh-session-bus
pwsh -NoProfile -File scripts/install.ps1

# 让插件出现在「设置 → 插件」页（需要重启一次 DSH，见下）
pwsh -NoProfile -File scripts/install.ps1 -Mode bundle

# 卸载（删除挂载行 + profile bundle 选择 + 已安装目录）
pwsh -NoProfile -File scripts/install.ps1 -Uninstall

# 开发用：不复制，条目直接指向本目录源码
pwsh -NoProfile -File scripts/install.ps1 -Mode path

# 开发用：改了代码后想立刻生效（见下方“改代码后如何生效”）
pwsh -NoProfile -File scripts/install.ps1 -Mode copy -Suffix 2
```

`<profile>` 默认取 `$env:DSH_PROFILE_DIR`，否则取 `$env:DSH_HOME/profiles/$env:DSH_PROFILE`。

**运行中的 DSH 会热加载 profile 补丁文件，无需重启**：写入后几秒内 `bus_*` 工具就会出现。
如果宿主没有热加载（例如非桌面端启动方式），重启 DSH 即可。

### `copy` / `path` 与 `bundle` 的区别

两种挂载方式在功能上完全一样，区别只在 **DSH 的两个页面按不同口径枚举插件**：

| | `copy` / `link` / `path`（默认） | `bundle` |
| --- | --- | --- |
| 挂载来源 | 脚本写进 profile `cordis.patch.yml` 的一行 `- insert:` | 包自带的 `cordis.patch.yml` |
| 生效方式 | **热加载，无需重启** | 启动时组合，**需要重启一次** |
| 设置 → 插件清单 | 可见（该页列出 `ctx.loader.entries()` 全量） | 可见 |
| 设置 → 插件 | **不可见** | 可见，且可用界面开关启停 |

「设置 → 插件」页只渲染**某个已选 bundle 声明的行**（`dsh-client-ui-plugin-manager` 的
`bundle.rows.map(...)`），bundle 列表来自 profile `package.json` 的 `dsh.profile.bundles`、
`dependencies` 与 DSH 安装自身的依赖三者；手写进 profile 补丁的条目不属于任何 bundle，
所以那一页没有它的位置 —— 它一直是正常加载的，只是没被那个页面统计。

**但只加进 `dsh.profile.bundles` 还不够。** 同一页在渲染前还有一道过滤：

```js
const listed = state.packages.filter((pkg) =>
  !BUILTIN_PROFILE_BUNDLES.has(pkg.name) && (pkg.installed || pkg.optional || pkg.error !== void 0));
```

而 `listBundles` 里 `installed = dependencies.includes(name)` —— 也就是**必须同时写进 profile
`package.json` 的 `dependencies`**，否则 `installed`/`optional`/`error` 三者皆假，整条记录就在这一行被丢掉
（`dsh-aoci-panel` 正是这种情况，它同样不显示）。

`-Mode bundle` 因此同时做两件事：选进 `dsh.profile.bundles`、声明进 `dependencies`；
后者写成 `file:<源码绝对路径>`，这样以后 `pnpm install` 能在本地解析，而不是去 registry
找一个根本不存在的包。做完后记录变为 `installed: true, removable: true`，
出现在插件页的「已安装」分组里。

同时它会删除手写挂载行（同一 `id` 两行会让 loader 报重复）。
区分两件事：**挂载切换**（手写行 → bundle 自己的 patch）要重启，因为 bundle 列表在启动时组合；
**可见性**只是读磁盘上的 `package.json`，刷新插件页即可。`bundle` 模式不支持 `-Suffix`。

### 改代码后如何生效

Node 按**解析后的真实路径**缓存 ES 模块，所以宿主只会执行某个目录里第一次导入的那份代码。
因此修改源码后：

- 用 `-Suffix <n>` 换一个安装目录名再挂载（无需重启），或
- 重启 DSH。

脚本会在修改 profile 前自动备份 `cordis.patch.yml`（bundle 模式还会备份 `package.json`）。

## 配置

安装脚本写入的挂载条目不带 config，全部走默认值；要改就在 profile 的
`cordis.patch.yml` 里追加一段同 `id` 的覆盖（后出现的行优先生效）：

```yaml
- id: session-bus
  config:
    allowCrossWorkspace: true   # 允许跨工作区投递
    allowSpawn: true            # 允许 bus_spawn 新建会话
    allowSelf: false            # 禁止发给自己
    maxHops: 8                  # 往返跳数预算，防互踢
    maxMessageChars: 20000      # 单条消息字符上限
    defaultMode: queue           # queue | steer
    inboundPresentation: notice  # notice（左侧通知卡）| bubble（右侧用户气泡）
    deliveryTimeoutMs: 120000   # 单次投递预算
    audit: true                 # 写审计日志
    listLimit: 40               # bus_list 默认行数
    findLimit: 5                 # bus_find 默认候选数
    targetPermission: delegate  # 被推送会话的权限（见下节）
    restorePermission: true      # 委派回合结束后还原目标权限
    spoolLongMessages: true      # 超长正文落盘为 body-file 而不是拒绝
    persistState: true           # 线程/跳数写入 state.json，重启不丢
    promptSection: true         # 注入系统提示词章节
    tools: true
    enabled: true
```

### 入站消息显示在哪：左侧通知卡还是右侧气泡

DSH 前端按消息的 `source.kind` 决定一条 `user` 角色消息怎么画：

- `source.kind === 'user'`（真人输入，即旧版投递路径）→ **右侧用户气泡**，看起来像本会话用户自己发的；
- 其它生产者 kind（`agent-message` / `schedule` / `goal` / `tool-jobs` …）→ **左侧整宽卡片**：
  唤醒新回合时是「收到任务消息 · 时间」可展开卡片，回合进行中插入时是「上下文注入」行。

默认 `inboundPresentation: 'notice'`：插件用 `sessionController.resolveAgent()` 拿到目标 Agent，
构造一条 source 为 `{ kind: 'agent-message', form: 'relay', senderSessionId, busMessageId, threadId, hop }`
的用户消息，再用 `agent.followup()`（queue）/ `agent.steer()`（steer）投递，`ctx.sessions.flush()` 落盘。
这不是 hack —— DSH 自己的 schedule、tool-jobs、subagent、Agent Teams 插件就是用同一条 Agent API
投递"非本人"消息的；`agent-message` + `form: 'relay'` 正是 DSH 为"另一个 Agent 发给本会话"声明的 source 词汇。

代价：这类卡片**默认折叠**，正文需要点开（DSH 前端对非用户消息的固定行为）。如果更想要"直接可读的右侧气泡"，
把 `inboundPresentation` 设为 `bubble` 即回退到旧路径（`sessionController.prompt`，按 `requestId` 幂等）。
两条路径都保留权限提升/还原、跳数记账、审计、长消息落盘；`bubble` 路径另外会带 `clientTimeZone`。

> 兼容性：宿主没有 `resolveAgent`/Agent API（很旧或嵌入式宿主）时自动回退到 `bubble` 路径，投递不受影响。

> 新会话标题：notice 路径的首条消息来源不是 `user`，DSH 的自动标题不会采用它，因此 `bus_spawn`
> 会用首条消息的第一行（去掉 `#`/`>` 等 Markdown 前缀，最多 60 个字符）给新会话命名；
> 重试命中的旧会话不会改名，`bubble` 路径仍沿用 DSH 的自动标题。

### 权限：为什么推送会把目标会话提到调用方的等级

DSH 的 Windows 沙箱有一个已知缺陷：`workspace-write` 会话里 `pwsh` 子进程起不来
（`0xC0000142 STATUS_DLL_INIT_FAILED`，你 profile 的 `cordis.patch.yml` 里也记过）。
结果是"把任务推给别的会话"看着成功，被唤醒的会话却一条 shell 命令都跑不了 —— 推送等于白推。

所以插件在投递前会调整目标会话的权限预设，走的是 GUI 权限菜单同一条路径
（`ctx.permissionPresets.current(session)` / `.set(session, preset)`）：

| `targetPermission` | 行为 |
| --- | --- |
| `delegate`（默认） | 把目标提升到**调用方当前**的预设；目标已经比调用方宽松时**不动**；读不到目标预设（新会话尚无覆盖）视为无约束；调用方是 `custom` 则不动 |
| `inherit` | 完全不碰目标权限 |
| `read-only` / `workspace-write` / `danger-full-access` | 总是把目标设为该预设（属于运维显式决定，因此可以下调） |

默认值 `delegate` 的取舍：它**不会凭空造出用户没给过的权限**——目标最多被提到"发起这次委派的那个会话"已有的等级。
反过来，当你的会话是"完全权限"时，被唤醒的会话也拿到完全权限，任务才真的能跑。

> **注意（v0.2 修正）**：早期文档写过"被刻意关在 `read-only` 的会话不会被放开"，那是**错的**——
> `read-only` 比调用方低，按上表会被提升。行为与本文一致，代码从未按"用户意图"区分手工限制；
> 需要绝对不动目标权限时用 `inherit`，或对单次投递传 `elevate: false`。

**自动还原**：提升只是为了让这一条委派跑得动，不是给目标换永久等级。目标回合结束、且没有其他排队消息时，
插件把它**放回原来的预设**（`restorePermission`，默认开）；期间用户手动改过预设则不覆盖用户的决定。
投递失败（消息没进去）时立即回滚，保证"被拒绝 ≠ 留下权限变更"。

几个实现细节：

- 目标预设无法读取时**不阻断投递**：消息照发，回执的 `note` 会写明权限没提上去、目标可能跑不了 shell。
- 权限确实变化时，投递的消息里会附一行说明，告诉目标"你被切到了 X 预设，是为了跑这条委派；任务结束后切回来"，
  系统提示词章节里也写了这条约定，避免被唤醒的模型把它当成异常或越权。
- 审计日志每条投递都记录 `permission` / `permissionApplied` / `permissionError`。
- 宿主没有 `permissionPresets` 服务时整个步骤自动跳过，投递不受影响。

非法值一律回落到默认值。配置项由 `lib/config.js` 归一化（不依赖外部包，见下节）。

审计日志：`<DSH_HOME>/session-bus/audit.jsonl`，每条投递一行 JSON（来源/目标/模式/跳数/字符数/是否跨区/是否新建）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `bus_list` | 列出可达会话：`sessionId`、标题、工作目录、忙/闲、能否投递、**是否与你同工作目录**；支持 `offset` / `updated_within_minutes` / `active_only` |
| `bus_find` | **按对话内容**找"该问谁"：检索全部工作区会话的全文，返回少数几个真正讨论过该话题的候选 + 命中片段 + 是否同目录 / 已有线程；只读，**不唤醒任何人**；结果带 `ambiguous` / `nextStep`，分不清时明确要求交给用户决定 |
| `bus_send` | 把消息推入目标会话并唤醒它（`mode: queue` 排队 / `steer` 立即插入当前回合）；默认以 `agent-message` source 投递，接收方看到左侧「收到任务消息」卡片（`inboundPresentation: bubble` 则退回右侧气泡）；可带 `thread` / `reply_to` / `write_scopes` / `elevate` |
| `bus_read` | 读取目标会话最近的对话尾部（**不会**唤醒对方）；`since` 支持只取增量（可传**最近一条**入站信封上的 `msg=`，也可传 ISO 时间或毫秒时间戳；消息表裁剪后仍可由收件表还原） |
| `bus_spawn` | 在指定工作区新建会话并把首条消息投进去；`spawn_key` 保证重试不会多建会话 |
| `bus_threads` | 列出你的会话线程与各自"欠谁一条回复"，替代反复 `bus_read` 猜进度 |

目标寻址支持：完整 `sessionId`、唯一 id 前缀、唯一标题、唯一工作目录片段、`self`。
**有歧义时报错并列出候选，绝不猜**。

### 问对会话：为什么路由不做成"统筹会话"

问错会话 → 回答不精准。这看起来像需要一个"总控/统筹会话"记住谁在做什么，但**路由本质是检索问题，不是编排问题**：

- 新版 DSH 自带会话全文索引（`sessionQuery.searchSessions`，FTS5，覆盖 live + 落盘会话、跨工作区），
  能直接回答"哪些会话的对话里真的出现过这个话题"。
- `bus_find` 把检索结果收敛成可直接行动的东西：候选 `sessionId`、命中片段、忙/闲、是否同工作目录、
  是否已有线程，最后一句提示用 `bus_send` 把问题发过去。**整个过程只读，不唤醒任何会话**。
- 常驻统筹会话的代价：它会冷、会过期（上下文压缩）、是单点（它不知道就会瞎指）、每次多一跳；
  而它知道的信息**不会比索引更多**。真想要"一个入口"时，任何会话（比如日常主会话）用
  `bus_find` 就能当总台，不需要额外的会话类型。
- 宿主没有挂载全文索引时自动退化为标题/工作目录/最近活跃度排序，并明确回报 `indexed: false`，
  调用方知道该先 `bus_read` 确认。
- **分不清就问用户，禁止自己拍板、禁止私自开新会话**：`bus_find` 对"多个同等候选 / 没有任何会话
  真正讨论过 / 只有元数据猜测"都会返回 `ambiguous: true`，`nextStep` 里写明"把候选交给用户确认，
  不要自己挑，也不要 `bus_spawn` 新建会话"。只有**唯一明确命中**（`ambiguous: false`）时才允许直接
  `bus_send`。这条规则同时写进了系统提示词，所有会话生效——不是靠调用方自觉。

## 消息协议

投递出去的消息是一条 `user` 角色消息（默认 source.kind = `agent-message`），首行是机器可解析的包头：

```
[session-bus v1] from=session-abc hop=1/8 msg=1f0c9a2b re=9d3c11 thread=t-4a7b21c9
from-title: 修复解析器
from-cwd: C:\work\project-a
sent-at: 2026-10-16T05:10:04.000Z
write-scopes: frontend/src/views, backend/app/services
body-file: C:\Users\me\.dsh-harness-next\session-bus\spool\1f0c9a2b.md
body-bytes: 41233
--- message ---
帮我跑一遍测试并告诉我失败项
--- reply ---
Answer with the bus_send tool: bus_send({ to: "session-abc", message: "<your result>" })
请用 bus_send 工具把结果发回会话 session-abc，并带上 thread: "t-4a7b21c9"；不要只为确认收到而回复。
```

- **幂等**：默认投递把 `msg` 记在 source 的 `busMessageId` 上，重试时先在目标会话日志/收件箱里查重，
  已落地就只回执、不再投递；`bubble` 路径仍用 `requestId` 让宿主去重。
- **按会话线程计跳数**：`thread` 是对话标识，`hop` 只在**同一条线程**内递增，而且只统计**易手**
  （换到对面发言）次数：同一方连发两条补充消息算同一次易手，不额外花预算。
  给一个从未通过 bus 交流的对端发第一条消息，永远是 `hop=1` —— 一条繁忙的对话不会吃掉另一条的预算
  （v0.1 曾按"会话"记账，实测评委会踩到：给 Gys 来回两跳后，给毫无关系的 Fws 发第一条就报预算耗尽）。
  线程与跳数持久化在 `<DSH_HOME>/session-bus/state.json`，重启不丢。
- **可关联**：回复默认继承入站线程并带 `re=<原 msg>`；对**尚未回复你**的对端再发一条补充消息，
  会自动接在同一条线程上（带 `re=` 指向你上一条），不会另开一条并行线程把上一条悬在那里。
  `re=` 的读法是"本条接在哪条后面"（回复或补充都算），**不等于**"我在回复对方"：
  同方连续补充时它指向你自己上一条，会话锚点始终是 `thread=`。
  `bus_threads` 据此报出"谁欠谁一条回复"。包头新增字段均可选，
  **旧版本写的包头照样能解析**（`thread`/`re` 缺失即旧语义）。
- **拒绝零副作用**：每类拒绝都有稳定错误码（`hop_budget_exhausted`、`message_too_long`、
  `self_send_disabled`、`cross_workspace_disabled`、`no_sender`、`empty_message`、`spawn_disabled`、
  `delivery_failed`、`invalid_since`），拒绝同样写审计（`event: "reject"`），
  且不产生投递、不留权限变更；确需越过跳数预算可显式传 `force: true`（**只越过检查，不重置计数**）。
- **写范围**：`write_scopes` 原样进信封与审计；`bus_list` 标出与你同工作目录的会话，
  投递回执会提示"工作区重叠"。
- **长消息落盘**：正文超过 `maxMessageChars` 时写入 `<DSH_HOME>/session-bus/spool/<msg>.md`，
  信封只带 `body-file:` 与指针，接收方自己读文件 —— 既不整条拒绝，也不永久占用对方上下文。
- **系统提示词章节**：所有会话都会收到一段"会话总线"说明（工具用法 + 回复约定 + 禁止空回执）。

## 为什么没有任何外部依赖

这是插件能否在某些位置加载的硬约束，不是风格选择：

宿主用普通 Node 模块解析加载**安装目录之外**的插件（profile 插件、工作区插件），
而 `@deepseek-ai/*` 这些包只对**安装在 DSH 安装目录内**的插件可达。
本 profile 里能正常工作的第三方插件（`dsh-ops`、`dsh-aoci-panel`）同样只有相对路径与 `node:*` 导入。

所以本插件：

- 不 `import { defineTool } from '@deepseek-ai/dsh-tools'` —— `lib/toolkit.js` 自带定义与参数校验；
- 不 `import z from '@deepseek-ai/schemastery'` —— 配置由 `lib/config.js` 归一化；
- 只用 `node:crypto`、`node:fs/promises`、`node:path` 和相对路径。

结果：`-Mode path` 直接指向工作区源码也能加载，不受安装位置限制。

## 限制

- **不能投递给 subagent 会话**：`origin: 'subagent'` 的子会话由父会话驱动，宿主会拒绝（`session/agent-busy`）。
  插件会提前识别并给出明确错误，`bus_list` 默认也不列它们（`include_subagents: true` 可查看）。
- **跳数状态默认跨重启保留**：线程与跳数写在 `<DSH_HOME>/session-bus/state.json`（防抖落盘），
  重启后同一 `thread` 的 `hop` 继续累加、`re=` 仍指向重启前那条消息；
  只有 `persistState: false` 时才退化为纯内存态（重启回到 0）。
- **跨工作区投递会消耗目标会话的额度**：被唤醒的会话会真的开始一个回合，请把它当作“以用户身份发指令”。
- `bus_read` 通过宿主 `inspect` 读取会话事件，超长会话的读取开销与历史长度相关（返回文本有上限）。

## 开发与测试

```powershell
cd dsh-session-bus
node --test test/envelope.test.mjs test/resolve.test.mjs test/bus.test.mjs test/find.test.mjs test/toolkit.test.mjs test/config.test.mjs test/threads.test.mjs test/plugin.test.mjs test/presentation.test.mjs
```

（Node 24 下 `node --test test/` 会因目录解析报 `MODULE_NOT_FOUND`，所以逐个列出文件。）

109 个用例，全部不依赖 DSH 运行时：

- `test/envelope.test.mjs` —— 包头渲染/解析、多行正文、恶意输入。
- `test/resolve.test.mjs` —— 目标寻址的每一级、歧义拒绝、工作区匹配。
- `test/bus.test.mjs` —— 用假宿主验证：投递请求、跳数递增、跨区策略、自投递拒绝、长度上限、
  subagent 拒绝、`bus_spawn`、`bus_read`、投递失败的错误信息。
- `test/find.test.mjs` —— v0.3 的路由：全文索引命中、只保留可投递会话（排除自己/subagent/看不见的）、
  已有线程标记、候选数截断、无索引时退化为标题匹配、检索后端报错不致命、空问题返回 `empty_query`、
  工具结果与声明 schema 一致且**不唤醒任何会话**；以及**歧义策略**：多个同等候选 / 索引无真实命中 /
  无可投递候选时 `ambiguous: true`，`nextStep` 明确要求交给用户、不要自己挑、不要 `bus_spawn`。
- `test/toolkit.test.mjs` —— 参数校验的路径诊断、结果投影（丢弃未声明字段、递归数组/嵌套对象）。
- `test/threads.test.mjs` —— v0.2 的会话模型：按线程计跳数、跨对端不串预算、重启后从
  `state.json` 恢复、`thread`/`re` 关联与旧包头兼容、`bus_threads` 未决视图、每类拒绝的错误码与
  reject 审计、权限回滚与回合结束自动还原、写范围与同目录提示、长消息落盘、`spawn_key` 幂等、`since` 增量读；
  另有评审批次的用例：未回复时的补充消息接同一线程且不花预算、无关对端仍从 `hop=1` 起、
  入站 `msg` 可作 `since`（含消息表裁剪后仍可从收件表还原）、失败回滚写出 `permission_restore` 审计、
  回滚写失败时**保留**那次提升的记录以便稍后补还（不会留下"已提升但无人可还原"的会话）。
- `test/plugin.test.mjs` —— 用假宿主**完整挂载插件**并真的调用全部工具，同时断言
  工具返回值不包含未声明的字段（宿主会按 `additionalProperties: false` 严格校验工具输出）；
  并钉住 `persistState` 到构造选项 `persist` 的接线（关掉时一个账本字节都不落盘，默认仍写）。
- `test/presentation.test.mjs` —— v0.4 的呈现层：默认用 Agent API 投递 `agent-message`（不碰 prompt RPC）、
  queue/steer 分别落到收件箱 `nextTurn`/`nextStep`、消息深冻结与 source 字段（sender/thread/hop/messageId）、
  按日志与收件箱查重幂等、`bubble` 配置回退旧路径、没有 Agent API 的宿主自动回退、
  无 Session store 时只跳过 flush、Agent 解析失败报 `delivery_failed`；以及 notice 模式下 `bus_spawn`
  用首行给新会话命名、重试命中的旧会话不改名、标题服务拒绝也不影响投递。

### 工具结果为什么由 schema 决定

宿主对工具返回值做 `additionalProperties: false` 的严格校验，而校验发生在**工具体执行之后**：
一旦 schema 漏写某个字段，调用方看到的是"工具失败"，但副作用（新建会话、投递消息）已经发生。
所以 `defineTool`（`lib/toolkit.js`）在返回前把结果**投影到 `output.schema` 声明的字段**，
递归处理数组与嵌套对象。字段清单只有 schema 一处，结构上不可能漂移。

## 文件

```
lib/index.js      Cordis 插件入口（name / inject / apply）
lib/bus.js        核心：列举、寻址、投递、读取、新建；跳数跟踪与审计
lib/tools.js      六个工具定义（原始 JSON Schema）
lib/toolkit.js    零依赖的 defineTool：参数校验 + 按 output.schema 投影结果
lib/envelope.js   消息包头渲染/解析
lib/resolve.js    纯函数：会话与工作区寻址
lib/config.js     配置默认值与归一化
lib/prompt.js     注入系统提示词的章节
scripts/install.ps1  安装/卸载/开发模式
test/             单元与集成测试
```
