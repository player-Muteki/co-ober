# OpenCode 下一阶段：最新 Claudian 基线与诊断任务生命周期

日期：2026-10-11。实现版本：Co-Ober 0.2.61。

## 1. 先更新参考仓库，而不是沿用旧结论

Claudian 本地 `main` 从 `a0c2a697d0fe507d8635c540bfbad6b82ddd97b9`
快进到远端 `630bfec9f306909a384de138b6b753fc21008241`，领先 38 个提交。
包版本从 2.3.13 更新为 2.3.16；最新提交为
`style(settings): remove retired slash-command panel rules (#1580)`，
提交时间为 2026-10-11T08:57:45Z。完成调研后再次通过官方 API 确认 main
仍是同一提交。

常规 `git pull --ff-only` 在 sandbox 内 DNS 失败，获准联网后 HTTPS
低速超时。替代路径只从 GitHub 官方 Git API 下载缺失对象：还原完整
38 个提交、相关树及 315 个缺失 blob，**每个对象都校验完整 Git SHA-1**，
通过后才更新 `origin/main` 并快进本地 main。无签名提交也必须还原到
完全相同的对象 ID；没有创建替代提交或覆盖源码快照。
`git fsck --connectivity-only --no-dangling HEAD` 通过，参考仓库干净。
没有构建 Claudian，也没有运行其外部 vault 复制脚本。

### 最新 OpenCode 变化

直接复核新旧基线的以下源码和测试：

- `metadata/OpencodeV2MetadataProbe.ts`：`/api/command` 初次可能暂时为空，
  目录有界等待；并行读取 `/api/skill`，仅明确 HTTP 404 可降级为无 skill。
  command 和 skill 保留类型，同名 command 优先占据 slash 调用。
- `commands/OpencodeCommandCatalog.ts`：保留 command 的 `kind`，不再一律
  标记成 command。
- `runtime/buildOpencodePrompt.ts`、`execution/OpencodeExecutionSession.ts`、
  `execution/OpencodeHTTPSessionKernel.ts`：组合 prompt 保存用户输入范围，
  skill 识别仅作用于该范围并排除代码块等 Markdown 示例；steer 队列保持顺序。
- `execution/OpencodeACPSessionKernel.ts`、`history/OpencodeHistoryStore.ts`、
  `history/OpencodeSqliteReader.ts`：V1 compact 前后读取成功 summary 的差集，
  取消期间不得继续启动 prompt；V2 识别完成的 compaction 行并恢复分隔标记。
- `tests/integration/providers/opencode/metadata/OpencodeV2MetadataFixture.ts`：
  fixture 目录文件改为原子写入，避免半写 JSON 被当成 provider 故障。
- 继续参考现有 `OwnedProbeRegistry`、`ProviderTransitionFence` 及 provider
  transition 所有权约束；这两个基础模块不是本次新增的上游能力。

这些变化证明旧差距分析需要更新，但不证明 Co-Ober 已支持 V2 执行。
上游测试是参考契约，不是本机 OpenCode 的运行证明。本轮不复制原生
skill 调用、compact 路由或 steer 到 ACP 聊天层。

## 2. 选择并落地的边界

0.2.60 目录服务已经拥有取消和来源 fence，但完整诊断流程仍直接顺序
调用版本、原生目录和共享 ACP 元数据：关闭设置页或切换 CLI 后，旧任务
仍可能继续启动后续阶段并重绘整个设置页。

本轮选择修复这个已确认的生产生命周期缺口，而不是在目录成功后直接
开放原生 HTTP 聊天。

### 单一诊断状态所有者

新增 `OpencodeDiagnosticsService`：

- 拥有 running、results、failed 和当前 AbortController；设置页不再持有
  需要同步的第二套 running/results 状态。
- 复制 CLI、cwd、完整启动环境；来源 key 仅内存比较，不日志、不持久化、
  不显示环境值。
- 取消独立完成，不依赖不配合 abort 的 collector；晚到成功或失败不能发布。
- 来源转换清除旧诊断 Pass，不自动重跑。
- 每个阶段前后 `checkCurrent()`，环境在 await 期间发生变化时，阻止后续
  原生探针、ACP 初始化或元数据读取；最后发布也再检查来源。
- 最新重试拥有发布权；当前真正失败仅暴露失败状态，不泄漏底层错误内容。

目录服务与诊断服务共享 `OpencodeProbeSource` 的纯快照/比较函数，没有
共享可变控制器，也没有把两种任务合并成一个会互相取消的任务。

### 生产接线

设置页新增中英文“取消诊断”按钮；取消、hide、CLI 改变及语言改变都会
fence 旧诊断。CLI 改变同时撤下旧来源结果。诊断只重绘自己的容器，不
重建正在编辑的连接输入，也不在隐藏后重绘。环境变化触发 fence 后，
控件恢复到可重试状态，不停留在 Running。

版本与目录探针使用**同一份捕获来源和同一诊断 signal**。MCP 配置、同步
目录也在诊断开始时复制，避免一个结果混用不同阶段的设置值。

共享 ACP 连接不是诊断任务的资源：取消不会 disconnect、closeSession 或
删除真实会话。已经启动的 `initClient`/ACP 元数据请求尚无独立取消协议，
可能继续在内部完成；诊断自身立即结束，并阻止结果发布与后续阶段。
这不是“底层共享请求被物理停止”的认证。

### 版本子进程

`detectOpencodeVersion` 接入外部 AbortSignal：预取消不 spawn；启动时复制
环境；取消、超时、stdout 超量和进程错误均有统一完成边界。kill 抛错或
没有 close 不阻塞调用者。stderr 只 drain 不保存，stdout 有上限；结束移除
输出/abort listeners，取消后保留无害 error sink 到 close，接住晚到错误。

## 3. 回归与实测证据

先复现并记录失败，再实施的边界：

1. 预取消版本读取仍然 spawn。
2. 取消挂起版本进程后调用仍 pending。
3. hide 后旧诊断不传 signal，继续后续探针并重绘隐藏设置。
4. 环境变化 fence 后，诊断控件仍停留在 Running。

进一步覆盖来源快照、CLI 转换、环境转换、来源键排序、晚到错误、最新
重试、locale 转换、共享 ACP 读取/初始化期间取消、输入元素保留，以及
版本超时/输出上限/kill 抛错和关闭后的 listener 清理。

全套：**81 个测试文件、2,407 项通过**；TypeScript 和 ESLint 通过。

真实只读验证从当前 `OpencodeVersion.ts` 单独 bundle 后执行：

- 正常 `opencode --version` 读取为 1.18.33，failed=false。
- 第二次启动版本进程后立即取消：调用在本次测量中 2 ms 返回 failed=true；
  只启动一个 child，观察到真实 close 为 code=null、signal=SIGKILL。
- 没有创建 session、提交 prompt 或运行模型回合。
- 单次时间不是跨平台性能保证；跨平台 wrapper 后代进程树不在本次证明内。

## 4. 保留的差距与下一阶段

- turn/stream/fork 显式、可能消耗模型回合的探针仍是独立旧生命周期，
  本轮没有声称它们已经获得取消/来源 fence。
- 目录发现仍是现有 loopback 方言；尚无 V2 stdio 启动、随机认证、共享
  HTTP lease、插件级 provider registry 或协议选择契约。
- 上游最新的目录就绪等待、独立 skill 目录及分类、native compact、用户
  输入范围识别和 steer 顺序仍未迁入本项目。
- 来源比较不包含可执行文件/配置内容、符号链接或数据库文件身份指纹；
  ACP 会话数据库绑定仍是 0.2.59 的路径级约束。
- 整体诊断没有共享 ACP 请求的强制 deadline/物理取消；原生版本和目录
  各有自己的有界 deadline。设置页仍是诊断和发现的生命周期所有者。

下一阶段可先给原生目录建立明确的协议/启动/认证契约和就绪证据，再
考虑 command/skill 发现。不能按 major version 推断整套 HTTP 能力，也
不能把目录成功、上游 fixture 或本轮版本取消实测写成模型执行认证。
