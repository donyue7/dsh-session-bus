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
- **按模块分工（v0.8）**：一个工作区可以有「一个主会话 + 每个模块一个开发会话」，用 `bus_roles` 登记角色、`bus_task` 记账、`bus_attention` 让开发会话一次只问用户一个具体问题——人仍然只和主会话对话。
- **需求即任务（v1.0）**：一个需求 = 一个任务 = 一条 `task_id`。消息信封带上 `task=` / `task-title:` 并在整个线程内自动继承；开发会话每轮开始时会收到一张 `[session-bus task card]`（需求标题、状态、验收标准、红线、最后进展），还能按任务检索消息与线程——会话再多也不会搞混「这条消息属于哪个需求」。

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
    maxHops: 16                 # 往返跳数预算，防互踢（一轮真实问答约 3 跳；长线程用 max_hops 提升）
    maxMessageChars: 20000      # 单条消息字符上限
    leaseTtlMinutes: 30          # 写租约默认存活 30 分钟（1..480，到期自动失效）
    maxPayloadChars: 8000        # 结构化 payload 的 JSON 字符上限
    maxAttachments: 16           # 单条消息附件上限
    whenBusyPreset: dev-session  # when_busy: "spawn" 派生 worker 时用的 agent 预设
    maxWorkers: 8                # 每个工作区同时存在的 worker 上限（0 = 不限，超出回落 queue）
    defaultMode: queue           # queue | steer | interrupt（结论插队）| inbox（静默投递不唤醒）
    interruptReplies: true       # 回答对方消息或 kind=correction 时，若对方在跑则自动升级为 interrupt
    inboundPresentation: notice  # notice（左侧通知卡）| bubble（右侧用户气泡）
    deliveryTimeoutMs: 120000   # 单次投递预算
    audit: true                 # 写审计日志
    listLimit: 40               # bus_list 默认行数
    findLimit: 5                 # bus_find 默认候选数
    taskCards: true              # 每轮在第一条用户消息前注入当前任务卡（v1.0）
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

### 结论要插队：`mode: interrupt`

A 算出结论时 B 可能还在跑。把结论排到 B 回合结束后就晚了——B 会先按旧假设干下去。
三档投递语义：

| mode | 目标正在运行 | 目标空闲 / 冷 |
| --- | --- | --- |
| `queue`（默认） | 等当前回合结束，进 `nextTurn` | 唤醒起新回合 |
| `steer` | 立即插入当前回合（无条件） | 也塞进 `nextStep`（旧行为，不建议） |
| `interrupt` | **立即插入当前回合**（`agent.steer`） | 照常唤醒（`agent.followup`） |

`interrupt` 是"结论安全"模式：目标在跑就插队，空闲就正常唤醒，不会像 `steer` 那样把消息卡在
没人消费的 `nextStep`。两种默认自动升级：**回答对方自己消息**（`re=` 指向对方发来的那条）的发送，
以及 **`kind: "correction"` 的发送**（v0.8.2 起，不需要 `re=` 锚点）——后者对应"主会话发现开发会话
正按错误假设干活"：只要对方在跑，更正会立刻插进当前回合，而不是等它干完才送达。显式 `mode` 永远优先，
所以单条传 `mode: "queue"` 即可关掉自动升级，`interruptReplies: false` 可全局关闭。

接收端信封会带 `mode=interrupt` 包头，`--- reply ---` 段明确提醒："这是插队消息，可能在你当前回合
进行中到达；把它当作比手上任务更新的信息，下一步前据此调整，别按旧假设收尾。"回执新增
`interrupted`（是否真的插进了运行中的回合），`note` 会说明插队原因（"回答的是对方自己的消息"
或"这是一条更正"）。

### 长线程、收线与静默投递（v0.6）

一轮真实协作往往不止三条消息。v0.6 把这些操作显式化：

- **跳数预算**：默认 `maxHops: 16`。`bus_send({ max_hops: 24 })` 把**这个线程**的预算提到 24 并写进线程记录，
  之后该线程都用新预算——比每次 `force: true` 安全，`force` 只在单条消息上硬闯，预算本身没变。
  信封在剩余跳数 ≤2 时会提醒对方收线。
- **收线**：`bus_send({ closing: true })` 表示"这条是最后一条，不用回"。信封不再要求对方回复，
  线程从"欠一条回复"变成 closed；收线消息**即使超出跳数预算也会送达**，不会出现线程耗尽后无法正常结束。
  收线后再发同一对端会开启新线程（也可用 `new_thread: true` 显式指定新线程）。
- **kind 决定是否插队**：`bus_send({ kind: "conclusion" | "correction" | "task" | "question" | "notice" | "ack" })`。
  `conclusion` 在"回答对方自己的消息"时、`correction` 在对方运行时（不要求 `re=`）会被自动升级为
  `interrupt`；`task` / `question` / `notice` / `ack` 保持排队，避免一条补充说明打断对方整轮工作。
- **静默 inbox**：`mode: "inbox"` 用宿主 `agent.inject()` 只把消息放进对方信箱、**不唤醒**它
  （下一回合自然读到）；用于 ack、知会、收尾，不再消耗对方一整轮。宿主不支持 `inject` 时自动回退为普通唤醒。
- **投递状态**：`bus_threads` 现在给出每个线程的 `state`（closed / awaitingYou / pending / idle）、`peerRunning`，
  以及最后一条消息的 `lastMessageState`（`queued` / `consumed` / `unknown`）、`lastKind`、`lastPreview`、
  `lastAgeMinutes`——`queued` ≠ 对方已处理，别把"已送达"当"已读"。
- **旧消息**：信封的 `sent-at` 是**写入时间**，不一定是送达时间；排队很久的消息会附带提醒，先核对当前状态再行动。

### 写租约与结构化交接（v0.7）

同一个工作目录里往往不止一个会话在写代码。`write_scopes` 只是"我要碰这些文件"的声明，
没有排他性；v0.7 增加了跨会话可见的写租约（lease），把"谁在写哪里"变成可协商的事实：

- **先 claim 再编辑**：`bus_lease({ paths: ["src/api", "package.json"], note: "正在改接口" })`。
  `paths` 可以是文件或目录（目录覆盖其下所有文件），相对路径按调用方 cwd 解析，最多 20 条。
  成功返回 `leaseId`、`expiresAt`、`expiresInMinutes`；租约默认存活 `leaseTtlMinutes: 30` 分钟，
  到期自动失效——对方崩了也不会永久占着不放。
- **冲突时不要硬来**：与另一个 Session 的覆盖路径重叠时 `granted: false`，`conflicts` 列出
  对方 lease 的 `leaseId`/`sessionId`/`paths`/`expiresInMinutes`/`note`。正确做法是 `bus_send`
  和对方协商、等它释放或等租约过期；`force: true` 只在用户明确要求时用。
- **完成即释放**：`bus_release({ lease: "<leaseId>" })`，省略 `lease` 则释放自己的全部。
- **看谁在写**：`bus_leases()` 列出当前有效租约（`mine` 标记自己、`expired` 标记过期），
  `workspace` 参数按目录过滤，`include_expired: true` 连过期的一起看。
- 租约落在 `<DSH_HOME>/session-bus/state.json`（`version: 2`），重启不丢；审计日志记 `lease`/`release`。

结论、清单这类"机器要读"的交接不必塞进正文：`bus_send({ payload: { ... } })` 会渲染成
信封里的 `--- payload ---` 段（JSON，≤ `maxPayloadChars` 字符），接收方拿到的是结构化对象。
交付文件用 `attachments: [{ path, sha256, note }]`——信封里的 `--- attachments ---` 只写
路径/摘要/说明，对方按路径自己读文件，长内容不用在消息里搬运；相对路径按发送方 cwd 解析，
`sha256` 必须是 64 位十六进制（用于校验内容没被改过）。回执会带 `payload` / `attachments`
两个字段，方便发送方确认哪些东西真的发出去了。

### 主会话与开发会话（v0.8）

一个工作区里**人只和主会话对话**，主会话只做协调、把工作按模块派给开发会话。这是 v0.8 显式支持的工作方式（借鉴 DSH `dsh-superagent-prototype` 的注意力模型，但只取角色 / 任务 / 提问三件事，不做外部事件源、面板与 PR 跟随）：

- **登记角色**：主会话 `bus_roles({ action: "register", role: "main" })`（每工作区唯一，`force` 可替换）；开发会话用 `bus_spawn({ role: "dev", module: "Gys_Frontend", preset: "dev-session" })` 一并注册。登记后任何会话都能 `bus_send({ to: "main" })`，不用猜 sessionId。真实会话永远优先——标题恰好叫 "Main" 的会话仍按名字投递，别名只在解析不到具体会话时生效。
- **任务账本**：主会话 `bus_task({ action: "create", title: ... })` 开任务；开发会话开工前 `claim`，进展/结论用 `update` 汇报；`ready` 是"已完成"的声明，必须带 `evidence`（命令 + 结果、提交、链接）——"改动存在"不等于"工作完成"。`bus_task({ action: "list", mine: true })` 让每个会话看到自己的活。
- **一次一个问题**：开发会话被真人决策阻塞时 `bus_attention({ action: "ask", task_id, question, options, recommendation })`；插件把问题转发给主会话，主会话原样转述给人，用户决定由主会话 `answer` 记回，被阻塞任务自动恢复 `in_progress`。不要把多个问题塞进一条，也不要用它报进度。
- **配套预设**：`dsh-workspace-workflow` bundle 提供 `main-session`（只协调：不写文件、不跑命令）与 `dev-session`（完整开发工具 + 子代理/后台任务）两个预设，`bus_spawn({ preset: "main-session" })` 直接可用。
- 角色 / 任务 / 提问都落在 `<DSH_HOME>/session-bus/state.json`（`version: 3`），重启不丢；审计日志记 `role` / `task` / `attention`。
- **常驻提示段开销（v0.8.1）**：注入每个会话系统提示的 session-bus 段落从约 11.2K 字符（≈2.8K tokens）精简到约 6.1K 字符（≈1.5K tokens，-46%）；工具清单与全部行为规则逐条保留，只压缩措辞。这段是稳定前缀，正常会命中 prompt cache。

### 并行任务：忙时派生 worker（v0.9）

主会话一次安排几个任务时，如果都发给同一个开发会话，后面的只能排队——一个会话的一个回合只能做一件事。
v0.9 给 `bus_send` 加了 `when_busy`：

- **`when_busy: "queue"`（默认）**：目标忙时照旧排队。
- **`when_busy: "spawn"`**：目标正在跑就**另开一个 worker 会话**（`whenBusyPreset`，默认 `dev-session`），把任务作为它的第一条消息投进去；原目标完全不被打断，继续做完手上的活。worker 的首条消息写明派发者、原目标、模块和回报方式；完成后它用 `bus_send({ to: "<派发者>", kind: "conclusion", closing: true })` 回报，需要真人决定时用 `bus_attention`。
- **worker 会被进度 chip 统计**：worker 注册为 `dev` 角色并带 `worker: true`，主会话头部的「N 个开发会话推进中」自动包含它。
- **去重**：`spawn_key` 由派发者、原目标和任务正文哈希得出，重试同一条任务会复用同一个 worker，不会重复开。
- **上限**：`maxWorkers`（默认 8，0 = 不限）按工作区限制同时存在的 worker 数量；到上限后自动回落为 `queue`，回执 `whenBusy: "queue"` 并在 `note` 里说明。
- **约束**：`allowSpawn: false` 时直接拒绝（`spawn_disabled`）；目标空闲时不派生 worker，照常直接投递。
- 回执新增 `whenBusy`、`worker: { sessionId, preset, module, title }`、`handedOffFrom: { sessionId, title }`。

### 需求即任务（v1.0）

会话一多，真正让人困惑的不是「谁在做什么」，而是「这条消息属于哪个需求」。v1.0 把需求提升为总线的一等对象：

- **任务有验收标准**：`bus_task({ action: "create", title, acceptance: ["退款行出现", "审计日志写入"], constraints: ["未经批准不许发生产"] })`。`acceptance` 是用户判断「做完了」的标准，`constraints` 是红线；两者都会写进发给执行会话的任务卡。
- **每条消息带 `task_id`**：`bus_send({ task_id, ... })` 把它写进信封（`task=` / `task-title:`），并粘在**线程**上——后续回复不重申也自动继承。没传时按「被回复消息 / 线程 → 发送方唯一的进行中任务」推断；推断不出来就留空，绝不乱猜。显式传不存在的任务会被拒绝（`task_not_found`）。
- **任务卡注入（每轮第一步）**：会话开始新回合时，插件通过 `agent/pre-step` 在第一条用户消息前插入一张卡片：
  - 开发会话：`[session-bus task card]` + 任务号/标题/状态 + **验收标准** + **约束红线** + 最后一次交流的摘要与来源；
  - 主会话：自己名下所有进行中的需求一览（≤6 条，含负责人、最后活动时间、会话 id）。
  卡片是真实注入的 `user` 角色消息（`source.kind = session-bus-task-card`），不是系统提示——模型每轮都看得到「当前需求是什么」。`taskCards: false` 可关闭。
- **一个需求一个会话**：`bus_spawn({ task_id })` 把新会话绑定为该需求的归属会话（`assignee` / `sessionId` 写回任务），且默认 `spawn_key` 就是任务号——同一需求重复派生会复用同一个会话。
- **按需求回顾**：`bus_read({ task })` 只读该需求的消息，`bus_find({ task })` 只在该需求碰过的会话里找，`bus_threads` 每行标出所属任务（`taskId` / `taskTitle` / `taskStatus`）。
- 投递回执新增 `task: { taskId, title, status }`；审计记 `task`；`bus_task` 详情带 `acceptance` / `constraints` / `threadIds` / `last`。

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

审计日志：`<DSH_HOME>/session-bus/audit.jsonl`，每条投递一行 JSON（来源/目标/模式/实际注入方式/是否插队/跳数/字符数/是否跨区/是否新建）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `bus_list` | 列出可达会话：`sessionId`、标题、工作目录、忙/闲、能否投递、**是否与你同工作目录**；支持 `offset` / `updated_within_minutes` / `active_only` |
| `bus_find` | **按对话内容**找"该问谁"：检索全部工作区会话的全文，返回少数几个真正讨论过该话题的候选 + 命中片段 + 是否同目录 / 已有线程；只读，**不唤醒任何人**；结果带 `ambiguous` / `nextStep`，分不清时明确要求交给用户决定；**v1.0：`task` 把候选限定在该需求碰过的会话** |
| `bus_send` | 把消息推入目标会话并唤醒它（`mode: queue` 排队 / `steer` 立即插入 / **`interrupt` 结论插队：目标在跑时插入当前回合，空闲时正常唤醒** / **`inbox` 静默投递不唤醒**；回答对方自己的消息、以及 `kind: "correction"` 的发送（v0.8.2 起，无需 `re=`）会自动升级为 `interrupt`，显式 `mode: queue` 可关闭单条升级）；默认以 `agent-message` source 投递，接收方看到左侧「收到任务消息」卡片（`inboundPresentation: bubble` 则退回右侧气泡）；可带 `thread` / `reply_to` / `write_scopes` / `elevate` / **`kind`** / **`max_hops`** / **`new_thread`** / **`closing`** / **`payload`** / **`attachments`** / **`when_busy`**（v0.9：忙时 `"spawn"` 另开 worker 会话而不是排队） |
| `bus_read` | 读取目标会话最近的对话尾部（**不会**唤醒对方）；`since` 支持只取增量（可传**最近一条**入站信封上的 `msg=`，也可传 ISO 时间或毫秒时间戳；消息表裁剪后仍可由收件表还原）；**v1.0：`task` 只读某个需求的消息** |
| `bus_spawn` | 在指定工作区新建会话并把首条消息投进去；`spawn_key` 保证重试不会多建会话；v0.8 起可用 `preset` 指定 agent 预设（主会话用 `main-session`）、`role: main/dev` 一步注册角色、`module` 标模块归属、`force` 替换已有主会话；**v1.0：`task_id` 让新会话成为该需求的归属会话，默认 `spawn_key` = 任务号** |
| `bus_roles` | **v0.8 角色注册表**：`register` 把会话登记为 `main`（每工作区唯一）或 `dev`（可带 `module`）；`list` 查看谁是谁、是否在跑、是否可投递；`clear` 注销。登记后 `bus_send({ to: "main" })` 永远能找到协调者 |
| `bus_task` | **v0.8 任务账本 / v1.0 需求**：`create` 开任务（可带 `acceptance` 验收标准 / `constraints` 红线 / `session_id`）、`claim` 认领（→ `in_progress`）、`update` 报进度/`ready`（必须带 `evidence`）/`done`、`list` 看活动任务（`mine: true` 只看自己的）、`get` 看详情（含验收标准、约束、线程、最后交流）；每个进行中任务每轮以任务卡出现在执行会话里 |
| `bus_attention` | **v0.8 结构化提问**：`ask` 一次一个问题 + 有界 `options` + `recommendation`，自动转发给主会话转述用户；`answer` 记录用户决定并让被阻塞任务恢复；`list` / `cancel` |
| `bus_threads` | 列出你的会话线程与各自"欠谁一条回复"，替代反复 `bus_read` 猜进度；v0.6 起还给出线程 `state`、`peerRunning`、最后一条的 `lastMessageState`（queued/consumed/unknown）、`lastKind`、`lastPreview`、`lastAgeMinutes`；**v1.0：每行标出所属任务** |
| `bus_lease` | 为共享目录里的文件/目录 claim 一把写租约（默认 30 分钟自动过期）；与别的 Session 重叠时返回冲突列表，提示先协商而不是硬写；`force` 只在用户明确要求时用 |
| `bus_release` | 释放自己的写租约（指定 `lease` 或全部）；完成编辑后立刻释放，让下一个写者进入 |
| `bus_leases` | 列出当前有效写租约：谁、在哪个工作区、占了哪些路径、还剩多少分钟、是否自己；过期租约不再阻塞别人 |

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

注意：v0.8 的角色 / 任务 / 提问（见「主会话与开发会话」）不是对这条原则的否定。默认仍是谁都能直接
`bus_send` 到任意会话；登记角色只是**在你选择**「一个主会话 + 多个开发会话」的组织方式时，给
`to: "main"` 一个稳定含义，并让任务进度与"等人回答的问题"有一处可查的事实，而不是散落在各会话的对话里。

## 消息协议

投递出去的消息是一条 `user` 角色消息（默认 source.kind = `agent-message`），首行是机器可解析的包头：

```
[session-bus v1] from=session-abc hop=1/16 msg=1f0c9a2b re=9d3c11 thread=t-4a7b21c9 task=t-77aa10c3
from-title: 修复解析器
from-cwd: C:\work\project-a
sent-at: 2026-10-16T05:10:04.000Z
task-title: 修复解析器
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
- **需求戳**：`task=<id>` 与 `task-title:` 标记这条消息属于哪个需求（v1.0）；同一线程内后续消息自动继承，缺这两个字段的旧包头照常解析。
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
- `bus_read` 通过宿主的会话事件页读取（DSH 0.2.2 起用 `sessionController.events`，旧版回退 `inspect`），超长会话的读取开销与历史长度相关（返回文本有上限）；宿主没有转录读取能力时返回 `note` 说明原因，而不是抛错。

## 开发与测试

```powershell
cd dsh-session-bus
node --test test/envelope.test.mjs test/resolve.test.mjs test/bus.test.mjs test/find.test.mjs test/toolkit.test.mjs test/config.test.mjs test/threads.test.mjs test/plugin.test.mjs test/presentation.test.mjs test/leases.test.mjs test/coordination.test.mjs test/whenbusy.test.mjs test/read022.test.mjs test/task-v1.test.mjs
```

（Node 24 下 `node --test test/` 会因目录解析报 `MODULE_NOT_FOUND`，所以逐个列出文件。）

193 个用例，全部不依赖 DSH 运行时（v1.0 新增任务层 / 信封任务戳 / 需求会话 / 按任务检索 / 任务卡注入用例；v0.6 新增 `max_hops` / `closing` / `new_thread` / `inbox` / `kind` / 线程状态等用例；v0.7 新增写租约与结构化 `payload` / `attachments` 用例；v0.8 新增角色 / 任务 / 提问账本用例；v0.9 新增忙时派生 worker 用例；v0.9.1 新增 DSH 0.2.2 转录读取兼容用例）：

- `test/envelope.test.mjs` —— 包头渲染/解析、多行正文、恶意输入；v0.6 的 `kind`/`closing` 元数据、
  收线信封省略回复指示、剩余跳数告警、queue 消息的"写入时间≠送达时间"提醒，以及 parse 往返；
  v0.7 的 `--- payload ---` / `--- attachments ---` 段渲染与解析、未发送时不出现对应键、坏 JSON 不致命。
- `test/resolve.test.mjs` —— 目标寻址的每一级、歧义拒绝、工作区匹配。
- `test/bus.test.mjs` —— 用假宿主验证：投递请求、跳数递增、跨区策略、自投递拒绝、长度上限、
  subagent 拒绝、`bus_spawn`、`bus_read`、投递失败的错误信息；v0.6 的 `max_hops` 只提升本线程预算、
  `closing` 收线并豁免跳数预算、`new_thread` 从 hop 1 起、未知 `kind` 在投递前拒绝；
  v0.7 的 `payload` / `attachments` 投递与回执字段，以及非法 `payload` / 超长 `payload` /
  坏 `attachments`（非数组、坏 sha256、超额）在投递前拒绝。
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
  回滚写失败时**保留**那次提升的记录以便稍后补还（不会留下"已提升但无人可还原"的会话）；
  v0.6 的 `bus_threads` 异步返回 `state` / `peerRunning` / `lastMessageState` / `lastPreview`。
- `test/leases.test.mjs` —— v0.7 写租约：路径归一化（相对/绝对、Windows 大小写折叠）、目录覆盖子路径、
  冲突检测与 force 强占（不删除原 lease）、相同 roots 续期、过期后不再阻塞、release 单个/全部、
  `toJSON`/`restore` 往返；以及 bus 层 `bus_lease` / `bus_release` / `bus_leases` 契约、ttl clamp 与错误码。
- `test/coordination.test.mjs` —— v0.8 角色 / 任务 / 提问：`samePath` 归一化、`RoleRegistry` 每工作区唯一
  main 与 `main_exists` / `force` 替换 / dev 模块归属、`TaskLedger` 的 claim → blocked → ready（必须
  evidence）→ done 状态机与 `task_owned` / `task_closed` / `empty_update` 错误码、`AttentionLedger` 提问
  阻塞任务 / 回答后恢复 / 关闭后拒绝再答；以及 bus 层 `bus_roles` / `bus_task` / `bus_attention` 契约、
  `to: "main"` 路由（真实会话优先、无主会话报 `no_main`）、`bus_spawn` 的 `preset` / `role` / `module`
  与第二个 main 的拒绝。
- `test/whenbusy.test.mjs` —— v0.9 忙时派生 worker：目标在跑 + `when_busy: "spawn"` 时新开一个
  `dev-session` worker（注册为 `dev` + `worker: true`）、首条消息带派发者/原目标/回报方式与原任务、
  原目标完全不被投递；目标空闲时照常直接投递；不带 `when_busy` 仍排队；`maxWorkers` 到上限回落 `queue`
  并在 note 说明；`allowSpawn: false` 报 `spawn_disabled`。
- `test/read022.test.mjs` —— v0.9.1 兼容层：宿主只有 0.2.2 的 `sessionController.events`（无 `inspect`）时
  `bus_read` 仍能读出标题与消息、`hasMore` 页标 `truncated`、完全没有转录读取能力时降级成 `note`
  而不是抛错、只有旧版 `inspect` 时继续工作；`bus_spawn` 的复用探测同样走新接口。
- `test/task-v1.test.mjs` —— v1.0 需求层：验收标准/约束的创建与替换、`bind`/`touch`、信封 `task=` 与线程继承、
  发送方唯一进行中任务的自动识别（两条则不猜）、`task_not_found`、`bus_spawn` 绑定需求与默认 spawn_key 复用、
  `bus_threads`/`bus_read`/`bus_find` 的任务过滤，以及 `agent/pre-step` 任务卡注入（无任务/非首步/已有卡片/
  拒绝回合都不注入、开发卡带验收标准与红线、主会话卡列所属需求、`taskCards: false` 关闭）。
- `test/plugin.test.mjs` —— 用假宿主**完整挂载插件**并真的调用全部工具，同时断言
  工具返回值不包含未声明的字段（宿主会按 `additionalProperties: false` 严格校验工具输出）；
  并钉住 `persistState` 到构造选项 `persist` 的接线（关掉时一个账本字节都不落盘，默认仍写）。
- `test/presentation.test.mjs` —— v0.4/v0.5 的呈现与投递语义：默认用 Agent API 投递 `agent-message`（不碰 prompt RPC）、
  queue/steer/interrupt 分别落到收件箱 `nextTurn`/`nextStep`、`interrupt` 在目标运行时插队而空闲时唤醒、
  回答对方自己的消息自动升级为 `interrupt`（可被 `interruptReplies: false` 或显式 `mode: "queue"` 关闭）、
  `kind: "correction"` 对运行中的目标自动升级为 `interrupt`（同样可关闭，v0.8.2）、
  `defaultMode: "interrupt"`、bubble 路径把 `interrupt` 映射为 steer/queue、信封 `mode=interrupt` 标记与
  接收端"以新信息为准"提示、消息深冻结与 source 字段（sender/thread/hop/messageId）、
  按日志与收件箱查重幂等、`bubble` 配置回退旧路径、没有 Agent API 的宿主自动回退、
  无 Session store 时只跳过 flush、Agent 解析失败报 `delivery_failed`；以及 notice 模式下 `bus_spawn`
  用首行给新会话命名、重试命中的旧会话不改名、标题服务拒绝也不影响投递；v0.6 的 `mode: "inbox"`
  用 `agent.inject` 静默投递（无 `inject` 时回退普通唤醒），以及 `kind` 决定回答是否自动升级为 `interrupt`。

### 工具结果为什么由 schema 决定

宿主对工具返回值做 `additionalProperties: false` 的严格校验，而校验发生在**工具体执行之后**：
一旦 schema 漏写某个字段，调用方看到的是"工具失败"，但副作用（新建会话、投递消息）已经发生。
所以 `defineTool`（`lib/toolkit.js`）在返回前把结果**投影到 `output.schema` 声明的字段**，
递归处理数组与嵌套对象。字段清单只有 schema 一处，结构上不可能漂移。

## 文件

```
lib/index.js      Cordis 插件入口（name / inject / apply）
lib/bus.js        核心：列举、寻址、投递、读取、新建；跳数跟踪与审计
lib/coordination.js  v0.8 角色 / 任务 / 提问账本：main/dev 注册、任务状态机、attention 阻塞与解除
lib/tools.js      十二个工具定义（原始 JSON Schema）
lib/leases.js     写租约账本：路径归一化、冲突检测、过期清理
lib/toolkit.js    零依赖的 defineTool：参数校验 + 按 output.schema 投影结果
lib/envelope.js   消息包头渲染/解析
lib/resolve.js    纯函数：会话与工作区寻址
lib/config.js     配置默认值与归一化
lib/prompt.js     注入系统提示词的章节
scripts/install.ps1  安装/卸载/开发模式
test/             单元与集成测试
```
