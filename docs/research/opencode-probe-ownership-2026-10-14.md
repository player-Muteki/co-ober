# OpenCode 下一阶段：探针所有权与三探针生命周期

日期：2026-10-14。实现版本：Co-Ober 0.2.62。

## 1. 先复核参考仓库，而不是沿用旧结论

Claudian 本地 `main` 从 `630bfec9f306909a384de138b6b753fc21008241`
快进到 `6c0c9587`，领先 28 个提交；包版本 2.3.16 → 2.3.20，最新提交
`test: align side-chat command suite with its source (#1622)`。

`git diff --stat 630bfec9..6c0c9587 -- src/providers/opencode` 为**空**。
这 28 个提交完全没有触及 OpenCode provider：新增的是 DeepSeek Harness
provider（#1563），其余是 chat 标签/会话、side chat、本地化与测试对齐。

两个生命周期基础模块同样未变：

- `src/core/providers/metadata/OwnedProbeRegistry.ts`
- `src/core/providers/metadata/ProviderTransitionFence.ts`

`51f37b8f` 只是让新 DeepSeek provider **采用**这两个模块，没有重新定义它们。

### 这对本轮意味着什么

参考基线的 OpenCode 实现没有前进，所以差距分析里"下一阶段"的那一格没有被
上游改动挤掉，也没有被上游的新能力取代。上游仍然只提供同一套纪律，本轮照它执行。

## 2. 上游纪律与本仓库现状的对照

`src/providers/opencode/metadata/OpencodeMetadataService.ts` 是上游对应的
所有权形态，其形状是：

- `loadCatalog(signal?)` 接受调用方 signal；`dispose()` 释放；
- 发布前 `signal.throwIfAborted()`；
- command discovery 用 `onAbort → reject` 与工作本身竞速，取消不依赖不配合
  abort 的采集器；
- 环境/CLI fingerprint 变化 fence 发布，**保留旧行直到显式刷新**。

本仓库已经在两处镜像了这套纪律：

- 0.2.60 `OpencodeCatalogService`：取消、来源 fence、旧目录保留 + stale；
- 0.2.61 `OpencodeDiagnosticsService`：单一所有者、取消按钮、来源 key、
  只重绘自己的容器。

**但 0.2.61 的研究文档第 4 节自己记录了缺口**："turn/stream/fork 显式、可能
消耗模型回合的探针仍是独立旧生命周期，本轮没有声称它们已经获得取消/来源
fence。" 这三个探针正是本轮的对象。

## 3. 本轮确认的缺口

`src/settings.ts` 里三个显式探针（turn / stream / fork）仍在旧生命周期上：

1. **无取消**：`hide()` 只取消 `catalogService` 与 `diagnosticsService`。关闭
   设置页后 `opencode serve` 子进程与真实模型回合继续跑完。
2. **无来源 fence**：`runNativeTurnProbe()` 等直接
   `await detect...(this.plugin.settings.opencodePath, …)`。读者在探测途中改掉
   CLI 路径，结果仍写进 `this.nativeTurn`，并以"当前安装"的口气绘制。
3. **探针本身不接受 signal**：三个 `detect*` 的 deps 都没有 `signal`，即使调用
   方想取消也无法传递。0.2.61 已给版本探针接上外部 signal（"预取消不 spawn"），
   这三个没有跟上。
4. **重绘越界**：三者结尾调用 `this.render()`，而 `render()` 执行
   `containerEl.empty()` 并重建整个设置页。0.2.61 的发布说明写的是"诊断只重绘
   自己的容器，保留正在编辑的连接输入"；目录（0.2.60）已改用
   `redrawNativeCatalog()`，三个探针仍在整页重建，读者正在编辑的连接输入会被
   清掉。

第 4 条还有第二个后果：`redrawNativeCatalog()` 与 `redrawDiagnostics()` 都有
`if (!this.shown …) return` 的守卫，`this.render()` 没有。设置页关闭后，晚到的
探针结果仍会重绘一个没人看的面板。

## 4. 本轮选择的边界

只修这个已确认的生命周期缺口，不在目录读通后直接开放原生 HTTP 聊天。

新增 `OpencodeProbeService<T>`：单一所有者，持有 running / reading / stale 与
当前 AbortController。三个探针各自持有一个实例，形状沿用
`OpencodeCatalogService` 的构造注入，读取函数可替换以便测试。

关键取舍：**取消与超时不共用一条竞速**。0.2.55 建立的纪律要求
`admitted`（内核接了提示词、窗口内没读回回答）与 `unavailable`（内核没应答）
是两个不可合并的桶。如果把内部超时也接到"提前 resolve 默认值"的竞速上，
轮询途中超时就会从 `admitted` 塌成 `unavailable`——用一个新谎换掉旧谎。
因此竞速只由**外部取消**触发；内部超时继续走原有的
`controller.abort()` 路径，轮询循环照旧 `break` 并给出 `admitted`。

取消路径不做的事：不取消共享 ACP 聊天连接，不 closeSession，不删除真实会话。
已被接受的提示词仍可能在本机把回合跑完——插件能证明的只是"不再发布、不再
开始后续阶段"，不是"物理停止了底层生成"。

## 5. 保留的差距

- turn/stream/fork 三个探针仍各自启动自己的 `opencode serve`，没有共享租约。
- 目录发现仍是现有 loopback 方言；无 V2 stdio 启动、随机认证、共享 HTTP lease、
  插件级 provider registry 或协议选择契约。
- 上游最新的目录就绪等待、独立 skill 目录及分类、native compact、用户输入
  范围识别与 steer 顺序仍未迁入。
- 来源比较仍不包含可执行文件/配置内容、符号链接或数据库文件身份指纹。

下一阶段仍按差距分析的原序：先给原生目录建立明确的协议/启动/认证契约和就绪
证据，再考虑 command/skill 发现。不能按 major version 推断整套 HTTP 能力，
也不能把"探针现在可取消"写成模型执行认证。
