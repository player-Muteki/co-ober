# Copsilot 架构审查与后续开发计划

日期：2026-05-29

## 1. 当前架构概览

### 1.1 插件入口与生命周期
- `src/main.ts` 负责加载/保存插件数据、注册视图与命令、初始化客户端连接。
- 统一存储：`loadData/savePluginData` 维护 settings + sessions + activeSessionId，并在启动时恢复。

### 1.2 客户端与协议层
- `src/client/acp.ts`（AcpClient）：
  - 负责启动 OpenCode 子进程、JSON-RPC 通讯、能力协商（fs/terminal）。
  - 维护 session 元数据（model/mode/config/commands），处理自动重连。
- `src/client/agent.ts`（AgentRuntime）：
  - 作为 UI 层的客户端适配器；实现权限策略、发送消息的空闲超时保护。
- `src/client/AcpJsonRpcTransport.ts`：
  - JSON-RPC 传输层；处理请求队列、超时/abort、通知与反向请求。

### 1.3 UI 视图与控制器
- `src/view/copsilotView.ts`：
  - 组装 UI（消息区、输入、工具栏、会话下拉、权限横幅、欢迎页）。
  - 负责交互细节（拖拽、自动滚动、快捷键、@/slash 自动补全）。
- `src/view/copsilotViewController.ts`：
  - 统一会话生命周期、发送流程、错误处理、工具栏同步。
  - 维护 `ChatState` 与 `StreamController` 的串流状态。

### 1.4 会话与上下文
- `src/chat/session.ts`：会话持久化（插件数据）与 active session 管理。
- `src/context/*`：@引用解析、上下文注入、自动引用当前文件。
- `src/sync/*`：与 vault 同步的规则引擎。

## 2. 关键流程梳理

1) 启动
- onload → 读取插件数据 → 创建视图 → 尝试连接 ACP → 恢复会话 → 加载工具栏选项。

2) 发送消息
- 输入文本 → 解析内置 slash → 构建 prompt（系统提示 + context 注入 + 用户文本） → sendMessage → 流式更新 UI → 记录 usage → 可选 inline edit diff。

3) 重连与会话同步
- ACP 断开 → 自动重连 → 重新绑定 handler → 通过 sessionId 重新 loadSession → 刷新工具栏。

## 3. 结构优势与注意点

优势：
- UI 与客户端分层清晰，控制器聚合生命周期逻辑。
- JSON-RPC 传输层独立，便于扩展/替换。
- 会话持久化与 view 初始化的耦合点明确。

注意点：
- 版本字段在多个文件中出现，需保持一致。
- 权限策略分布在 AgentRuntime 与 UI 之间，需要统一入口文档化。
- 会话切换与重连路径较多，建议补充回归测试覆盖。

## 4. 参考实现对照（claudian-2.0.16 / opencode-1.15.3）

### 4.1 JSON-RPC 传输层（claudian-2.0.16）
- `src/providers/acp/AcpJsonRpcTransport.ts`：请求级超时默认 30s（`DEFAULT_TIMEOUT_MS = 30_000`），超时后仅在本地 reject 并清理 pending；不会主动发送 cancel 通知或关闭流（对应请求仍可能在服务端继续执行）。
- `dispose()` 会统一 abort 并 reject pending，但同样不包含显式 cancel 语义。

### 4.2 ACP 服务器侧会话与中断（opencode-1.15.3）
- `packages/opencode/src/acp/agent.ts` 在 `closeSession()` 中显式调用 `sdk.session.abort(...)`，服务端会终止会话执行。
- 事件流（`sdk.global.event`）按增量推送 message/tool delta，不依赖客户端空闲计时；未发现类似“空闲超时”逻辑。

### 4.3 对照结论
- 参考实现中，“超时”主要是**请求级超时**（transport）或**显式 abort**（会话级），不存在前端空闲计时导致的“软中断”。
- Copsilot 当前的 5 分钟空闲超时更接近 UI 层的“自我中断”，与参考实现路径不一致；建议改为可配置或迁移为显式 cancel/abort 路径，避免静默丢输出。

## 5. 会话中断问题排查（2026-05-29）

### 5.1 现象与触发条件
- 对话过程中出现“长时间无输出”后，前端报错并停止流式渲染。
- 更常见于长工具调用/模型长思考阶段，服务端仍在处理但 UI 已停止接收后续 chunk。

### 5.2 根因判断
- `AgentRuntime.sendMessage` 存在 5 分钟空闲超时，只在收到 chunk 时重置计时（src/client/agent.ts）。
- 超时触发后抛出 `AcpTimeoutError`，`CopsilotViewController.send` 进入 catch/finally，结束流式状态并清理占位符（src/view/copsilotViewController.ts）。
- `AcpClient.sendMessage` 在 finally 中清空 `chunkHandler/activeStreamSessionId`，导致超时后即使服务端继续输出，客户端也不会再分发更新（src/client/acp.ts）。
- 传输层 abort 不发送 cancel，服务端可能继续运行，但输出被忽略（src/client/AcpJsonRpcTransport.ts）。

### 5.3 修复思路（建议）
- 将空闲超时改为可配置项（默认提升到 30 分钟或可禁用），避免长工具阶段被误判超时。
- 将“超时”从 hard-fail 改为 soft-warning：提示“暂无输出”，允许用户手动取消，但继续保留 chunkHandler 以便恢复输出。
- 若仍需 hard timeout，则触发后同时发出显式 cancel，并写入一条“已中断”消息，避免静默丢输出。
- 如 ACP 支持心跳通知，加入 heartbeat 更新以维持空闲计时刷新。

### 5.4 验证计划
- 构造 ≥5 分钟无输出的工具调用场景，确认不会自动中断或可继续恢复输出。
- 触发超时后继续输出，确认 UI 能恢复（soft 模式）或明确显示“已中断”（hard 模式）。
- 用户点击“停止”时不显示错误，且不会产生残留占位符/状态错乱。
