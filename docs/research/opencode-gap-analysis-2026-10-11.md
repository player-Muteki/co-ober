# Co-Ober 与 Claudian OpenCode 实现差距调研

调研日期：2026-10-11。

## 1. 基线与证据边界

- Co-Ober：本地 HEAD `b2aa7ff`，插件版本 `0.2.58`；最近功能提交为 `cd70e6d`。
- Claudian：本地嵌套仓库 HEAD `a0c2a697`，插件版本 `2.3.13`。
- 比较对象是这个本地 Claudian 快照的 OpenCode provider，以及它调用的共享聊天能力；不是其 Claude、Codex、Pi 等其他 provider 的总功能。
- 本轮为源码和测试对照，没有拉取远端、调用真实模型或启动真实 OpenCode 服务。
- 下文的 OpenCode `1.18.33` 实测结论来自 Co-Ober 的既有提交与决策记录，不是本轮对当前安装的重新实测。
- “Claudian 已实现”表示存在生产调用路径与相关测试，不能推导为这些能力在本项目用户的实际安装上已经可用。其 V2 执行集成测试包含模拟服务 fixture。

## 2. 总结

**差距的中心不是聊天界面组件数量，而是 OpenCode 原生运行时接入的完整度。**

Co-Ober 已经拥有 ACP 聊天、多个会话的输出路由、回放和原生数据库补读，
最近又增加了原生目录、执行、SSE 和 fork 探针。然而探针只在设置页使用，
主聊天仍由 `AcpClient -> AgentRuntime -> CoOberViewController` 驱动。

Claudian 则把 OpenCode 实现为 provider：执行会话拥有原生状态，
版本选择器在 ACP 与 HTTP 内核之间选择，HTTP 服务通过租约管理共享进程，
原生事件进入请求回合、后台回合、子会话和交互请求的独立生命周期。

因此，下一步不应直接复制 Claudian HTTP 内核，也不应继续把设置页探针数量
视作原生运行链路的完成度。应先补齐实际协议契约和会话绑定，再逐步接入。

关键入口：

- Co-Ober：`src/main.ts:511`、`src/client/index.ts`、`src/client/acp.ts`、`src/client/agent.ts`。
- 探针调用范围：`src/settings.ts`；版本探测与原生探针没有进入主客户端构造。
- Claudian：`claudian/src/providers/opencode/registration.ts`、`execution/OpencodeExecutionBackend.ts`、`execution/OpencodeExecutionSession.ts`、`execution/OpencodeSessionKernel.ts`。

## 3. 必须先区分：版本号、协议方言与能力

两边目前的 HTTP 契约并不相同。

| 契约 | Co-Ober 既有探针/历史实测 | Claudian HTTP 分支 |
| --- | --- | --- |
| 启动与就绪 | `serve --hostname 127.0.0.1 --port 0`，从输出提取服务地址 | `serve --stdio --hostname 127.0.0.1 --port 0`，解析首行 JSON 的 `url`，并设置随机密码 |
| 普通 prompt | `{id: 'msg_…', prompt: {text}}` | `{id, text, files?}` |
| 流式文本 | `session.next.text.delta/ended` | `session.text.delta/ended` |
| 执行生命周期 | 近期探针没有完整实现生产级生命周期归一化 | `session.execution.started/succeeded/interrupted/failed` |
| 锚点 fork | 实测 `/api/session/{id}/fork` 返回 HTML；另一条 `/session/{id}/fork?directory=…` 接受 `{messageID}`，但子会话为空 | `/api/session/{id}/fork`，提交 `{before}`，按排他边界保留选中的 assistant 消息 |
| 主路径选择 | 聊天始终 ACP；版本探针只用于设置/诊断 | 检测主版本，只有 `version === 2` 才进入 HTTP 内核 |

证据：

- `src/opencode/OpencodeTurnProbe.ts:138-151`。
- `src/opencode/OpencodeStreamProbe.ts` 的 `reduceNativeStream` 与事件 URL。
- `src/opencode/OpencodeForkProbe.ts:264-279`。
- `docs/decisions/fork-from-latest-reply.md` 的 0.2.57 重访记录。
- `claudian/src/providers/opencode/http/OpencodeHTTPClient.ts:25-29,147-179`。
- `claudian/src/providers/opencode/execution/OpencodeHTTPSessionKernel.ts:146-180,303-338`。
- `claudian/src/providers/opencode/history/OpencodeSessionFork.ts:75-90`。
- `claudian/src/providers/opencode/runtime/OpencodeVersion.ts:5-9` 与 `execution/OpencodeSessionKernel.ts`。

**重要限定：**历史实测版本 `1.18.33` 按 Claudian 的版本选择逻辑会进入 ACP，
不是它的 V2 HTTP 分支。不能因为本项目在这个版本上读到了 `/api/*`，
就把这个安装视为与 Claudian 的 V2 协议兼容。

建议将 CLI 版本与已观察的协议能力分开记录；未知方言明确拒绝，不能猜测端点、
把 HTML 200 当 JSON 成功，也不能在已提交 prompt 后静默切换后端并重复发送。

## 4. 差距矩阵

分类：**缺失**＝没有对应生产路径；**部分**＝已有基础或替代，但语义/覆盖不等价；
**已具备**＝不应再次作为从零缺失项；**条件阻塞**＝需要内核证据才能兑现。

| 维度 | Co-Ober 当前实现 | Claudian OpenCode 实现 | 判断 |
| --- | --- | --- | --- |
| 原生 HTTP 聊天后端 | 执行与 SSE 都是设置页探针，聊天仍 ACP | 版本选择器、HTTP 内核、原生输出归一化和会话执行层 | 缺失；最大的结构性差距 |
| 回合中 steer | busy 时进入每标签 promptQueue，空闲后 drain | HTTP inbox 入队、交付后才确认，取消/结束时召回未交付项；ACP 分支不支持 | 部分；排队不能等同于当前回合中途引导 |
| 独立元数据发现 | ACP 会话报告目录；原生探针目录只读展示 | workspace metadata service，V1 隔离探针，V2 无会话目录查询，模型预热及取消管理 | 部分；缺少与可执行选择一致的独立发现服务 |
| 模型与推理设置 | 模型/模式/effort 切换、常用模型过滤、全局默认 | 模型别名、可见列表、逐模型推理偏好与元数据预热，HTTP model/agent 配置 | 部分；不缺基本模型切换，缺持久策略和原生配置接线 |
| 会话与数据库身份 | SerializedSession 没有 databasePath/nativeVersion；补读默认重新解析 process.env | providerState 保存数据库与版本，恢复、fork、运行和环境变更保留可信绑定 | 部分；会话身份完整性是重要基础缺口 |
| 原生历史 | 已支持列表、搜索、ACP 回放及 v1/v2 存储布局的 transcript/usage/todo/tool error 补读 | V1 SQLite、V2 HTTP 分页读取及会话模型恢复，与数据库绑定衔接 | 已具备基础；差距在绑定、V2 读取路径和恢复契约，不是没有历史 |
| 按消息 checkpoint fork | 整会话 ACP fork 可用；锚点探针已有，历史实测 child-empty | V2 按 assistant checkpoint 转换为 before 边界；V1 为整会话 fork | 条件阻塞；不能照搬按钮兑现不成立的历史截断 |
| 临时/辅助会话 | side chat 是整会话 ACP fork，关闭时 cancel/close；没有显式 nativePersistence 策略 | 执行 profile 与持久化策略；V1 可内存，V2 使用原生凭据库并在 disposal 删除临时会话 | 部分；释放 ACP 句柄不等于删除原生历史 |
| 子 Agent 可视化 | task/subagent 名称识别、子 Agent 卡片、工具状态持久化 | 原生 child session 映射、进度/工具数/token、嵌套工具范围、后台完成事件 | 部分；卡片已有，原生子会话事件链缺失 |
| 原生后台回合 | 可处理非当前标签自己的发送回合；没有 HTTP 原生非请求回合模型 | requested run 与 background turn 分离，接收原生启动及后续子任务输出 | 部分；后台标签流不等于内核自主/延迟产生的后台回合 |
| 工具输出与 shell | ACP tool content、terminal delegate、diff 和工具渲染已有 | HTTP tool 生命周期、shellID 输出读取、子会话范围与停止预览管理 | 部分；缺的是原生 shell/event 接线，不是工具输出组件 |
| 权限与询问 | 权限队列、标签归属、ACP elicitation primitive schema 和 URL 回答 | ACP 权限，加 HTTP permission/form 事件、reply 路由和交互作用域 | 已具备 ACP；HTTP 交互尚未接入，表单语义也不是 Claudian 全面更丰富 |
| 系统指令/受限执行 | systemPrompt、自定义 agent/skill 作为 prompt 文本拼装 | managed/native agent 定义，readonly inline edit、passive title profile，配置叠加不覆盖用户配置 | 部分；提示词注入不等于内核工具权限约束 |
| CLI 与环境管理 | 单一 opencodePath，继承进程环境，可在外部提供 OPENCODE_DB | 每主机路径、环境变量配置、fingerprint、发现发布隔离与运行时退役 | 部分；缺受管理的环境变化和跨机器配置能力 |
| 上下文来源 | Vault @引用、wikilink、图片、inline edit 选区与历史文本上下文 | OpenCode prompt request 可接 linked content、editor/browser/canvas selection 和 session references | 部分；共享上下文来源更广，需逐个跟踪 UI 到请求的接线 |
| 斜杠命令 | builtin/ACP/file/MCP/skill 多源注册、模板展开及本地/agent 分派 | provider command catalog、独立 metadata loader；V2 原生命令端点与无需启动 agent loop 的完成处理 | 已具备丰富基础；差距是独立发现和 HTTP 原生命令生命周期 |

## 5. 重点证据与影响

### 5.1 生产后端与探针之间仍有明显断层

`src/main.ts:511` 直接构造 `AcpClient`，之后包成 `AgentRuntime`。
`src/settings.ts` 是版本、目录、turn、stream、fork 探针的生产调用方。
`src/client/index.ts` 没有 steer、原生后台订阅或数据库绑定契约。

Claudian 的 `OpencodeSessionKernel` 会在 connect 时选择内核，
`OpencodeExecutionSession` 持有请求回合、数据库身份、持久化和后台输出范围，
`OpencodeServerService` 持有按环境/数据库管理的原生服务租约。

这不是简单新增一个 fetch sendMessage 方法即可补齐的差距。

### 5.2 steer 是交付生命周期，不是第二次 send

Co-Ober `CoOberViewController.ts:2640-2657` 把 busy 或共享流预算不足的输入排队。
它不会让这条输入加入当前执行中的原生回合。

Claudian `OpencodeHTTPSessionKernel.ts:192-209` 注册 steer 后发送，
以 `session.inbox.delivered` 而非 HTTP 接受作为成功；`recallSteers` 处理未交付项。
这防止 stop 后遗留输入进入下一轮。

本项目的历史执行探针记录 prompt 默认 delivery 为 steer，并不足以证明
“运行中插入一条 steer、确实在本轮消费、stop 后不会泄漏”的完整能力。

### 5.3 数据库绑定优先于增加更多 UI 能力

Co-Ober `src/types.ts:445` 的 SerializedSession 保存 sessionId、标题、消息等，
没有数据库路径或原生代际。
`NativeSessionReader.ts:311-315` 默认根据当前 process.env 重新选择数据库。

Claudian `types/index.ts`、`OpencodeExecutionSession.ts` 保存 databasePath/nativeVersion，
`OpencodeSettingsReconciler.ts` 对持久 V2 会话保留绑定，并区别处理环境变更。

静态分析可以确定前者缺少绑定机制；环境切换后读错库/恢复不一致是需回归验证的风险，
不是本轮已经复现的故障。

### 5.4 子 Agent 识别已补齐第一层，但第二层仍缺失

Co-Ober `ToolCallRenderer.ts:133-145` 与 `streamController.ts` 已识别 task/subagent，
所以不能再写“没有子 Agent 展示”。

Claudian HTTP 内核在 `session.tool.progress` 中根据 metadata.sessionID 建立 child 映射，
追踪进度和交互作用域；ExecutionSession 把晚到输出导入后台 scope。

缺的是原生 child session 生命周期、子任务事件和晚到结果归属。

### 5.5 临时执行的语义与权限需要单独设计

Co-Ober side chat 在主回合 busy 时拒绝开启，创建后经同一个 ACP 客户端发送；
关闭时取消并 closeSession。
inline edit 的状态随主聊天 send 入队并参与本轮 prompt，随后显示 diff。

Claudian 有 readonly/passive profile 和显式 nativePersistence；
`OpencodeSessionPersistence.ts` 为 V2 保留凭据所在数据库并删除临时会话。
`OpencodeExecutionAgents.ts` 用 native permission 规则限制 readonly agent。

应明确“只是临时面板”“会话句柄释放”“原生数据删除”“内核只读执行”四种不同承诺。

### 5.6 指令与上下文差距不能用同名 Agent 直接等同

Co-Ober `CoOberViewController.ts:3034-3047` 将系统提示、自定义 Agent 和 Skill 文本
拼入普通 prompt parts；这是本地指令组装，不是原生 agent 定义注册。

Claudian `OpencodeLaunchArtifacts.ts` 叠加用户配置，`OpencodeServerConfig.ts`
为共享原生服务注册 agent 定义；不同动态指令需要不同定义，避免相互覆盖。

Claudian `buildOpencodePrompt.ts` 接受多种共享选区与 session reference。
这些是 provider 输入契约，单凭该文件不能宣称每一种上下文在所有 UI/安装上均已验收。

## 6. 不应重复列为缺失的能力

下列功能在本项目已有生产实现，应先评估覆盖而不是重建：

- 多标签和多 session 输出路由、独立草稿、标签恢复及关闭后的资源清理。
- 图片粘贴、选择、拖拽及能力门控。
- ACP 权限问询、elicitation、文件和 terminal 委托。
- OpenCode 原生历史列表/搜索、会话回放与数据库补读。
- todo 计划、usage、费用、推理及工具错误等展示/恢复。
- 模型、模式、effort 切换与常用模型过滤。
- 整会话 fork、side chat、inline edit diff。
- 多来源斜杠命令和自定义 Agent/Skill 提示词。
- Zen、复制/导出、Vault 上下文与工具结果写入笔记。

**特殊项：编辑重发/重新生成。**Co-Ober 的 `rewindUserTurn` 创建新 session，
把保留历史转成上下文文本；Claudian OpenCode capabilities 明确
`supportsRewind: false`。前者是客户端替代方案，不是原生 rewind；
不能写成“Claudian 已有原生 rewind，本项目缺失”。

**特殊项：表单。**Claudian `OpencodeHTTPForms.ts` 主动拒绝多类不可表达的
默认值、验证、条件字段与 number/integer 语义；Co-Ober ACP elicitation
已有 number/boolean/enum/text。差距是 HTTP 表单通道接入和语义适配，
不是简单复制一个“更强表单组件”。

## 7. 建议迭代顺序

这是一份后续建议，不表示本轮已开始实现。

### 第一阶段：补测实际协议，而非直接重接发送路径

目标：形成当前安装可重复执行的协议/能力观测记录。

- CLI 版本、启动与认证、就绪协议。
- session 创建/恢复、model/agent/effort 配置的接受与实际使用。
- SSE 的 session/assistant/tool 标识、执行开始/结束/失败/取消。
- tool 输出、权限、question/form、usage、todo。
- 运行中 steer 的入队、交付、召回和 stop 后无泄漏。
- fork 的 JSON/HTML 判定和真实历史边界。

验收：区分 unknown/unavailable/admitted/executed 等状态；
不把历史实测或模拟 fixture 当作当前真实安装的证据。

### 第二阶段：会话身份与独立元数据服务

- 固定 session 的数据库和协议身份，避免环境变化静默重绑定。
- 明确本地 conversationId 与 native sessionId 的关系。
- 目录刷新、取消、过期结果发布隔离，与会话执行解耦。
- 可以独立补模型别名/逐模型推理偏好，但不能宣称原生 model 切换已经接通。

验收：更换 CLI/OPENCODE_DB 后，旧会话不读错库；
元数据发现不污染真实聊天历史，不伪造运行中的选择结果。

### 第三阶段：可选原生 HTTP 纵向最小闭环

先完成一条有界路径：创建/恢复 -> prompt -> text delta -> 终态 -> 取消 -> 清理。
默认 ACP 保留；不做不可回滚的静默替换。

同时明确服务所有权、认证、会话事件隔离和异常处理。
工具/权限仍未覆盖时，必须限制后端开放范围，不能只因文本 OK 就面向全部会话开放。

验收：多个标签不串流，失联不伪装正常完成，中断不留后台工作，
已提交请求不因 fallback 重复执行。

### 第四阶段：逐个消费原生能力

1. 原生 tool/permission/form/usage/todo 接线。
2. steer 的完整交付/召回生命周期。
3. 原生子会话及后台完成输出。
4. 临时 side chat、readonly inline edit 与删除策略。
5. 原生命令和无 agent loop 命令的完成判定。

### checkpoint fork 独立保留阻塞

只有新的实测得到真正符合边界的历史复制，才开放“从此处分叉”。
当前仓库记录 child-empty，不能用复制本地文本、重放历史或改数据库绕过。

## 8. 验证情况

本轮运行以下本项目测试，全部通过：

```text
src/opencode/OpencodeVersion.test.ts
src/opencode/OpencodeCatalog.test.ts
src/opencode/OpencodeTurnProbe.test.ts
src/opencode/OpencodeStreamProbe.test.ts
src/opencode/OpencodeForkProbe.test.ts
src/opencode/NativeSessionReader.test.ts
src/client/acpMultiSession.test.ts
```

结果：**7 个文件，150 项测试通过**。
这些是模拟依赖/纯函数与已有多 session 行为的回归验证，不是本轮真实内核验收。

没有运行 Claudian 的整套验证，也没有构建它：其 AGENTS.md 提醒构建会读取
`.env.local` 并可能向配置的 Obsidian Vault 复制或删除产物。
调研阶段仅新增此文档；后续代码实施见第 10 节。原有 `.qoder/` 内容未修改。

## 9. 后续测量前仍未知的事项

- 当前实际安装是否仍为历史记录中的版本，是否仍使用同一 HTTP 方言。
- Claudian V2 分支对应的内核在当前环境是否可启动、是否拥有可用凭据。
- 当前安装对运行中 steer、模型应用、tool/permission/form 生命周期的真实契约。
- checkpoint fork 的历史复制缺陷是否在其他实际版本/安装中改善。
- browser/canvas/session reference 的每个共享 UI 入口对 OpenCode 的完整端到端覆盖。

以上未知项都不阻碍确认源码差距，但会影响能力开放和实现优先级。


## 10. 第一轮代码实施：原生数据库路径绑定

已落地，仍保持 ACP 作为主聊天后端：

- ACP 启动时复制环境，并将同一份环境传给进程启动和数据库路径解析；新连接重新捕获，已找到的路径在本连接内固定。
- 会话持久化可选 `nativeDatabasePath`；原生列表、内容搜索和选择回调保留来源。
- transcript、usage、todo、message stats、tool errors、turn stats 读取优先使用保存的来源；显式 `null` 禁止回退发现另一数据库。
- 已绑定会话恢复、resume、fork、继续发送和侧聊发送时，核对当前内核的路径；不一致或未知则拒绝，不隐式替换会话。
- 关闭、删除和侧聊清理避免向另一数据库发送旧会话的取消/关闭请求；rewind 也不会在来源不一致时改写历史。
- 旧记录不在迁移时猜测来源；成功 attach 后才补充绑定。相对路径、空值、控制字符和 `:memory:` 不作为持久化绑定。

边界：路径来自现有 `OpencodePaths` 解析器和启动环境，而不是 ACP 握手返回的数据库声明；多候选路径、符号链接/文件替换、CLI wrapper 自行改变环境等情况不属于已认证的文件身份。没有新增 HTTP kernel，也没有重新实测安装版本、fork 复制、steer 等运行时契约。本轮测试是模拟依赖与本地回归，不消耗真实模型 turn。
