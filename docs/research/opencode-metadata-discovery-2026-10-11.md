# OpenCode 下一阶段：独立目录发现与发布隔离

日期：2026-10-11。基线：Co-Ober `a20059a` / `0.2.59`；
Claudian 本地快照仍为 `a0c2a697` / `2.3.13`。
本轮继续上一份差距清单的第二阶段，不切换聊天后端。

## 1. 补充对照

Claudian 的关键证据：

- `src/providers/opencode/metadata/OpencodeMetadataService.ts`：发现任务有独立
  probe 所有权、取消信号、环境转换 fence 与发布边界；命令发现可以共享在途
  任务，但每个消费者独立取消。
- `src/providers/opencode/runtime/OpencodeModels.ts`：目录发现、模型可见性和
  warming 分离；发现失败不是一份成功的空列表。
- `src/providers/opencode/env/OpencodeSettingsReconciler.ts`：CLI/环境指纹变化
  进入运行时转换流程，而不是让旧发现继续写入新来源的目录。
- OpenCode provider 的 `AGENTS.md` 要求独立元数据存储，且 V2 原生目录查询
  不创建聊天 session；不能为缺少原生绑定的历史会话创建真实聊天做发现。

Co-Ober `0.2.59` 的实际断点：

- `settings.ts` 自己持有 running/loaded/catalog 三个状态。CLI 改动或关闭设置
  页不取消发现，旧 Promise 可以晚到并重新绘制设置页。
- `OpencodeCatalog.ts` 的 timeout 仅 abort 请求并 kill 子进程；若请求不响应
  abort，Promise 仍可能永不完成。
- fulfilled 被当作端点已观察到，即使内容是 HTML、不同 JSON 方言或错误结构。
  部分端点失败时没有逐端点证据，设置页会把未观察到的列表显示成零项。
- 目录读取刷新整个设置页，没必要连同连接输入和其他设置一起重建。

这些是源码与失败回归可重复确认的断点，不是 HTTP 聊天闭环的完成证据。

## 2. 本轮实现

### 独立所有权

新增 `OpencodeCatalogService`，仅依赖原生目录读取，不持有聊天 client 或 session。
接口为 `setSource`、`refresh`、`cancel`、`getSnapshot`：

- CLI 字符串、工作目录和完整启动环境复制成操作快照。
- 环境键排序后比较；指纹仅在内存使用，不持久化、不写日志、不显示环境值。
- 来源改变或新 refresh 会取消旧任务；只有当前任务能发布。
- 完成时再次检查原始来源，捕获读取期间的环境变化。
- cancel 本身有独立 Promise 边界，不等待不配合取消的底层读取。
- 已成功读取的目录保留到下一次成功显式刷新；来源变化或刷新失败会标记
  stale，不把历史目录误当作当前安装已认证的目录。
- 观察失败有单独 unavailable 状态，不覆盖已有目录为虚假的空列表。

### 有界读取与逐端点证据

`detectOpencodeNativeCatalog`：

- 接受外部 `AbortSignal`；预先取消时不启动进程。
- 启动与 HTTP 查询共享操作级 deadline；与 abort 完成竞速，不只依赖 fetch。
- 进程提前关闭/报错导致任务终止；最后统一清理 timer、signal/readiness
  listeners 和子进程。关闭前保留无害的 error sink，以接住取消后延迟到达的
  spawn/kill 错误，避免未处理的 EventEmitter error。
- 仅 `{ data: [...] }` 这一已使用的方言算有效端点响应；HTML、其他 JSON
  结构和请求错误记为 unavailable。
- 记录 models/commands/agents 的逐端点 observed/unavailable；有效 `data: []`
  与不可用端点不再同义。

### 生产接线

设置页使用该服务，不在打开时自动发现；用户可以取消并重试。
CLI 修改立即 fence 当前发现，关闭设置页取消当前任务；晚到结果不恢复旧目录。
目录仅重绘自己的容器，不重建连接输入或其他设置。
上次目录与部分目录都有中英文说明，失败端点显示 unavailable 而非零项。
诊断中的部分读取不能显示完整目录通过，也不能冒充三个空列表。

## 3. 验证证据

按行为逐步验证失败回归再实施：

- HTML/不同 JSON 方言被旧实现报告为 observed。
- 不配合 abort 的请求超过 deadline 后仍然 pending。
- 缺少服务和设置 hide 生命周期；旧来源可发布、环境变化可发布。
- 服务 cancel 等待不配合的 reader。
- 取消后晚到 spawn error 没有 listener 而抛出未处理事件。
- 部分目录被旧诊断标记为完整通过。

实施后覆盖预取消、startup 取消、请求晚到、监听器 drain、逐端点空/失败、
环境快照、来源改变、最新刷新胜出、目录保留、失败恢复、显式取消与关闭设置。
全套本地回归：**80 个文件、2,389 项测试通过**；类型检查和 ESLint 通过。

### 当前安装的有界实测

本轮实际执行 `opencode --version`，输出 `1.18.33`。
从修改后的 `OpencodeCatalog.ts` 单独 bundle 并调用目录读取：

- sandbox 内返回 unavailable（355 ms）；没有把它当作有效空列表。
- 经批准的 sandbox 外 loopback 读取：1,064 ms 完成；三个端点都为 observed。
- 观察到 47 个 enabled 模型、2 个命令、7 个 Agent。
- 请求限于 `/api/model`、`/api/command`、`/api/agent`；没有创建 session，
  没有提交 prompt，没有模型回合，也没有输出模型凭据。
- 最终代码再次只读验证：1,068 ms 完成，三个端点与计数一致，观察到服务
  close 事件为 `code: null, signal: SIGKILL`，确认正常读取路径进程退出。
- 取消/超时/晚到的边界由 fake transport 回归覆盖，不把模拟结果写成真实
  模型运行证据。

计数属于本次安装的一次读取，不是跨机器保证。

## 4. 明确保留的差距

- 服务目前由设置页拥有，不是覆盖整个插件的 provider 发现注册表。完整诊断
  流程、turn/stream/fork 等其他探针尚未纳入同一个取消/转换生命周期。
- 比较的是 CLI 设置字符串、工作目录和环境值，不是可执行文件内容、符号
  链接、配置文件内容或数据库文件指纹；路径不变而文件被替换不属于本轮认证。
- V2 协议适配、共享 HTTP 服务租约、认证协商未接入。本轮只验证现有
  1.18.33 目录方言，不按 major version 猜测其他方言。
- 未接原生模型到聊天选择器，未做 model warming/aliases；ACP 的模型与 agent
  能否实际应用仍以 session 配置结果为准。
- 未创建独立 ACP metadata session；没有共享消费者取消计数和插件级缓存。
- 未实现 steer、原生后台回合、原生工具/permission/form、checkpoint fork。
- 子进程清理沿用 kill；跨平台 wrapper/后代进程树清理不在本轮实机证据中。

下一阶段先补受控的协议契约与服务生命周期，再决定是否开放可选 HTTP 文本
闭环；不能因目录有效就绕过工具权限、认证、取消和多会话事件隔离。
