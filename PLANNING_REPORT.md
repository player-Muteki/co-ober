# Copsidian 项目规划报告

> 基于当前架构分析 (v0.0.27) + OpenCode ACP v1.15.3 协议 + Claudian v2.0.16 参考实现
> 生成日期：2026-05-26

---

## 一、当前架构总览

### 1.1 代码规模

| 模块 | 文件数 | 源码行数 | 测试行数 |
|------|--------|---------|---------|
| `client/` (ACP 层) | 7 | 1,230 | 1,465 |
| `view/` (视图层) | 10 | 1,791 | 1,230 |
| `chat/` (会话层) | 5 | 487 | 546 |
| `context/` | 3 | 105 | 170 |
| `sync/` | 2 | 116 | 239 |
| `settings.ts` | 1 | 842 | 352 |
| `main.ts` | 1 | 198 | 74 |
| 其他 (i18n/utils/agents/commands) | 8 | 466 | 359 |
| **总计** | **37** | **5,235** | **4,435** |

测试覆盖率比 ≈ 0.85。

### 1.2 架构层次

```
CopsidianPlugin (main.ts, 198 行)
├── settings: CopsidianSettings (842 行)
├── client: AgentRuntime → AcpClient → AcpSubprocess → AcpJsonRpcTransport
└── CopsidianView (906 行) ← "上帝对象"
    ├── ChatState (77 行) — 含 DOM 引用
    ├── StreamController (176 行) — 依赖 ChatRenderer
    ├── ChatRenderer (333 行)
    ├── ChatInput (75 行)
    ├── InputToolbar (87 行)
    ├── SessionDropdown (124 行)
    ├── WelcomeView (60 行)
    ├── DragDropManager (126 行)
    ├── PermissionBanner (48 行)
    ├── InlineEditPanel (97 行)
    └── KeybindingManager (42 行)
```

### 1.3 核心耦合问题

**问题 1: CopsidianView 是"上帝对象"（906 行）**
- 直接访问 `this.plugin.getClient()` 约 15 处
- 直接读取 `this.plugin.settings` 约 10 处
- 混合了 DOM 创建、会话管理、流式处理、重连逻辑、工具栏同步
- 所有子组件回调都闭包引用 `this`

**问题 2: ChatState 包含 DOM 引用**
- `currentTextEl: HTMLDivElement | null`
- `ThinkingState.el: HTMLDivElement | null`
- `pendingTools[].parentEl: HTMLElement | null`
- 数据模型和视图耦合

**问题 3: parseSessionUpdate() 使用 ~20 个 `as` 断言**
- 虽然不是 `as any`，但仍是运行时不可靠的类型转换
- 没有运行时校验

**问题 4: 无 AbortSignal 支持**
- `sendMessage()` 无法在传输层取消
- `cancel` 只能通过协议层通知，无法中断正在进行的 JSON-RPC 请求

### 1.4 数据流

```
用户输入 → ChatInput.onSend
  → CopsidianView.send(text, refs)
    → ensureRuntimeSession() — 确保连接 + 会话存在
    → buildParts() — 解析 @mention、构建 systemPrompt、组合 PromptPart[]
    → client.sendMessage(sessionId, parts, onChunk)
      → AgentRuntime.sendMessage() — 包装 idle timeout (5 分钟)
        → AcpClient.sendMessage() — 重置 normalizer、调用 requestWithFallback
          → AcpJsonRpcTransport.request('session/prompt') — 写入 stdin
    ← ACP server 在 stdout 发送 session/update 通知
      → AcpJsonRpcTransport.handleLine() — 解析 JSON
        → AcpClient notification handler — parseUpdate + applySessionUpdate
          → normalizer.normalize(update) → NormalizedUpdate
            → StreamController.handleChunk()
              → ChatRenderer.appendText() / addToolCall() / showUsage()
              → SessionStore.saveMessage()
    ← ACP server 返回最终 response
      → finally: busy=false, input.setStreaming(false)
```

---

## 二、OpenCode ACP 协议完整映射

### 2.1 已实现的方法（14 个）

| 方法 | Copsidian 实现 | 状态 |
|------|---------------|------|
| `initialize` | `AcpClient.connect()` | ✅ |
| `session/new` | `AcpClient.createSession()` | ✅ |
| `session/load` | `AcpClient.loadSession()` | ✅ |
| `session/list` | `AcpClient.listSessions()` | ✅ |
| `session/close` | `AcpClient.closeSession()` | ✅ |
| `session/unstable_fork` | `AcpClient.forkSession()` | ✅ |
| `session/resume` | `AcpClient.resumeSession()` | ✅ |
| `session/prompt` | `AcpClient.sendMessage()` | ✅ |
| `session/cancel` | `AcpClient.cancel()` | ✅ |
| `session/set_mode` | `AcpClient.setMode()` | ✅ |
| `session/set_model` | `AcpClient.setModel()` | ✅ |
| `session/set_config_option` | `AcpClient.setConfigOption()` | ✅ |
| `session/compact` | `AcpClient.compact()` | ✅ |
| `session/request_permission` | Handler registered | ✅ |

### 2.2 已声明别名但未实现的服务端请求（7 个）

| 方法 | 别名 | 状态 | 实现复杂度 |
|------|------|------|-----------|
| `fs/read_text_file` | `fs/readTextFile` | ❌ 未实现 | 中 |
| `fs/write_text_file` | `fs/writeTextFile` | ❌ 未实现 | 中 |
| `terminal/create` | `terminalCreate` | ❌ 未实现 | 高 |
| `terminal/output` | `terminalOutput` | ❌ 未实现 | 中 |
| `terminal/kill` | `terminalKill` | ❌ 未实现 | 低 |
| `terminal/release` | `terminalRelease` | ❌ 未实现 | 低 |
| `terminal/wait_for_exit` | `terminalWaitForExit` | ❌ 未实现 | 中 |

### 2.3 ClientCapabilities 声明现状

当前 Copsidian 在 `initialize` 时发送空的 `clientCapabilities: {}`。需要声明：

```typescript
clientCapabilities: {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: true },
}
```

### 2.4 session/update 通知类型覆盖

| 更新类型 | Copsidian 解析 | Normalizer 处理 |
|----------|---------------|----------------|
| `user_message_chunk` | ✅ | ✅ message_chunk |
| `agent_message_chunk` | ✅ | ✅ message_chunk |
| `agent_thought_chunk` | ✅ | ✅ message_chunk |
| `tool_call` | ✅ | ✅ tool_call_snapshot |
| `tool_call_update` | ✅ | ✅ tool_call_snapshot |
| `plan` | ✅ | ✅ plan |
| `available_commands_update` | ✅ | ✅ commands |
| `current_mode_update` | ✅ | ✅ mode |
| `config_option_update` | ✅ | ✅ config_options |
| `session_info_update` | ✅ | ✅ session_info |
| `usage_update` | ✅ | ✅ usage |
| `current_model_update` | ✅ (扩展) | ✅ model |

覆盖率 100%。

### 2.5 错误码

| 错误码 | 含义 |
|--------|------|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32800` | Request cancelled (ACP 特有) |
| `-32000` | Server error |
| `-32002` | Resource not found |
| `-32042` | Authentication required |

---

## 三、Claudian 架构对比分析

### 3.1 ACP 层对比

| 维度 | Claudian | Copsidian | 差距 |
|------|----------|-----------|------|
| ACP 分层 | 3 层 (Subprocess/Transport/Connection) | 混合 (AcpClient 全包 668 行) | **大** |
| 类型定义 | 566 行, 56 个类型 | 263 行, 混合类型 | **中** |
| 方法别名 | 9 个逻辑方法 | 14 个逻辑方法 | Copsidian 更全 |
| Update normalization | 371 行, delta 输出 | 83 行, 全量累积 | **中** |
| 错误类型 | 内联 2 个 | 独立文件 4 个 | **Copsidian 更好** |
| 进程管理 | non-nullable streams | nullable streams | **小** |
| 自动重连 | 无 (ensureReady) | 有 (3 次指数退避) | **Copsidian 更好** |
| AbortSignal | 支持 | 不支持 | **大** |
| FS/Terminal | 完整实现 | 声明但未实现 | **大** |
| 测试覆盖 | 无测试 | 37 个测试文件 | **Copsidian 大幅领先** |

### 3.2 Claudian ACP 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `AcpSubprocess.ts` | 141 | 进程生命周期 (non-nullable streams, env 字段) |
| `AcpJsonRpcTransport.ts` | 367 | JSON-RPC 传输 (AbortSignal, close listener) |
| `AcpClientConnection.ts` | 361 | ACP 协议方法层 (delegate 模式) |
| `AcpSessionUpdateNormalizer.ts` | 371 | Update 归一化 (delta 输出, 双用途) |
| `AcpToolStreamAdapter.ts` | 132 | Provider 特定工具名归一化 |
| `AcpSessionConfig.ts` | 117 | 模型/模式状态提取 |
| `buildAcpUsageInfo.ts` | 41 | Usage 统计构建 |
| `methodNames.ts` | 50 | 方法名别名映射 |
| `types.ts` | 566 | 完整 ACP 类型定义 (56 个接口/类型) |

### 3.3 应该采用的模式

| 模式 | 来源 | 优先级 | 预估工作量 |
|------|------|--------|-----------|
| AbortSignal 传输层支持 | Claudian | **P0** | 2h |
| FS delegate 模式 | Claudian | **P0** | 3h |
| Terminal delegate 模式 | Claudian | **P1** | 8h |
| Normalizer delta 输出 | Claudian | **P2** | 2h |
| 丰富的权限描述 | Claudian | **P2** | 3h |
| AcpSubprocess env 字段 | Claudian | **P3** | 30min |

### 3.4 不需要采用的模式

| 模式 | 原因 |
|------|------|
| AcpMethodOverrides | 单 provider，静态映射足够 |
| 双运行时实例 (AuxQueryRunner) | 过度设计 |
| Symbol-based discovery state | 多 provider 设置管理模式 |
| Launch artifacts / config 文件生成 | Copsidian 传递配置方式不同 |
| AcpSessionConfig 独立模块 | 已在 acp.ts 的 extractConfigMeta 中处理 |

---

## 四、分阶段实施计划

### Phase 1: 架构基础加固 (v0.0.28 → v0.0.30)

#### v0.0.28 — CopsidianView Controller 化 ⏳ 等待 Jules

**目标**: 906 行 → view < 500 行 + controller ~500 行

**提取内容**:
- 连接管理: `ensureClientConnected`, `bindClientHandlers`, `handleDisconnect`, `reconnect`
- 会话生命周期: `newSession`, `restoreSession`, `ensureRuntimeSession`, `syncRuntimeSession`
- 消息发送: `send`, `buildParts`, `executeBuiltIn`, `stopGeneration`
- 工具栏同步: `loadToolbarOptions`, `applyConfigOptions/Mode/Model`

**接口设计**:
```typescript
interface ControllerCallbacks {
  onShowWelcome(connected: boolean): void;
  onHideWelcome(): void;
  onShowReconnectBtn(): void;
  onHideReconnectBtn(): void;
  onShowNewMessagesBtn(): void;
  onHideNewMessagesBtn(): void;
  onScrollToBottom(): void;
  onClearUI(): void;
}

interface ControllerDeps {
  renderer: ChatRenderer;
  input: ChatInput;
  toolbar: InputToolbar;
  inlineEditPanel: InlineEditPanel;
  permissionBanner: PermissionBanner;
  mention: ContextMention;
  resolver: ContextResolver;
  syncEngine: SyncEngine;
  sessionStore: SessionStore;
  welcomeView: WelcomeView;
  plugin: CopsidianPlugin;
}
```

#### v0.0.29 — Transport AbortSignal + 错误分类 UI

**目标**: 支持请求级取消，不同错误类型显示不同 UI

**实现**:
1. `AcpJsonRpcTransport.request()` 增加 `AbortSignal` 参数
2. `AcpClient.sendMessage()` 使用 `AbortController`，`stopGeneration()` 调用 `abort()`
3. 错误分类: `AcpTimeoutError` → 重试按钮, `AcpProcessExitError` → 重启按钮, `AcpProtocolError` → 显示错误码
4. `ChatState` 移除 DOM 引用，改用 ID 索引

**文件变更**:
- `AcpJsonRpcTransport.ts` — 增加 AbortSignal 支持
- `AcpClient.ts` — sendMessage 使用 AbortController
- `renderer.ts` — addError 支持分类样式
- `chatState.ts` — 移除 parentEl 等 DOM 引用

#### v0.0.30 — clientCapabilities.fs + Vault 边界

**目标**: 实现 `fs/read_text_file`，声明 `clientCapabilities.fs`

**关键设计决策**:
1. **Vault 边界**: 只允许访问 vault 内文件，禁止 `../` 路径穿越
2. **路径归一化**: ACP 绝对路径 → vault 相对路径
3. **只读先行**: v0.0.30 只实现 `readTextFile`，`writeTextFile` 在 v0.0.31
4. **大小限制**: 复用 `maxNoteSize` 设置
5. **权限策略**: 可配置 (允许 / 只读 / 禁用)

**文件变更**:
- `acp.ts` — 注册 `fs/read_text_file` handler，声明 `clientCapabilities.fs`
- 新建 `src/client/fsDelegate.ts` — Vault 边界检查 + 文件读取
- `types.ts` — 增加 `FsCapability` 配置类型
- `settings.ts` — 增加 FS 能力配置项

---

### Phase 2: 能力扩展 (v0.0.31 → v0.0.33)

#### v0.0.31 — Terminal 能力 (Phase 1: 只读输出)

**目标**: 实现 `terminal/create` + `terminal/output`，在 Obsidian 内显示终端输出

**架构设计**:
```
TerminalManager (新建)
├── terminals: Map<string, TerminalInstance>
├── create(command, args, cwd, env) → terminalId
├── output(terminalId) → { output, exitStatus }
├── kill(terminalId)
├── release(terminalId)
└── waitForExit(terminalId) → { exitCode, signal }

TerminalView (新建, 视图组件)
├── 终端输出渲染 (pre + code 块)
├── 进度指示器
└── 状态栏 (exit code)
```

**安全约束**:
- 命令白名单模式 (可配置)
- 输出大小限制 (防止 OOM)
- 超时限制 (防止挂起)
- 只在当前 vault 目录下执行

**文件变更**:
- 新建 `src/client/terminalManager.ts`
- 新建 `src/view/terminalView.ts`
- `acp.ts` — 注册 5 个 terminal handler，声明 `clientCapabilities.terminal`
- `renderer.ts` — 支持 terminal output 渲染
- `types.ts` — Terminal 相关类型

#### v0.0.32 — Terminal 能力 (Phase 2: 交互式) + fs write

**目标**: 支持 `terminal/kill`, `terminal/wait_for_exit`, `terminal/release` + `fs/write_text_file`

**fs/write_text_file 设计**:
- 写入前需要用户确认 (PermissionBanner 扩展)
- 只允许写入 vault 内已存在的文件
- 写入后触发 vault 文件刷新
- 支持 diff 预览 (复用 InlineEditPanel)

#### v0.0.33 — 丰富权限 UI + audio PromptPart

**目标**: 不同工具显示不同的权限描述，支持 audio 输入

**实现**:
- 扩展 `PermissionBanner` 显示工具名称、输入参数、执行位置
- 增加 `audio` PromptPart 录制/选择 UI
- 增加 `resource` mimeType 支持

---

### Phase 3: 工程化收尾 (v0.1.0)

#### v0.1.0 — 质量 + 发布

1. **测试覆盖率**: 目标 >80%，补充集成测试
2. **性能优化**: 大会话消息列表虚拟化 (200+ 消息)
3. **文档**: API 文档、贡献指南、CHANGELOG 完善
4. **发布流程**: GitHub Actions 自动构建 + Obsidian 社区插件市场发布
5. **README 更新**: 路线图、ACP 能力矩阵更新

---

## 五、版本路线图总览

```
v0.0.27 ✅ 消除 lint warnings
v0.0.28 ✅ CopsidianView Controller 化
v0.0.29 ✅ Transport AbortSignal + 错误分类 UI
v0.0.30 ✅ clientCapabilities.fs + Vault 边界 (只读)
v0.0.31 ✅ Terminal Phase 1 (只读输出)
v0.0.32 ✅ Terminal Phase 2 + fs write
v0.0.33 ✅ 丰富权限 UI + audio
v0.1.0     工程化收尾 + 发布
```

---

## 六、需要讨论的架构决策

1. **Terminal 安全模型**: 命令白名单 vs 全部允许 + 用户确认？Claudian 不限制命令，靠权限系统控制。

2. **fs/write 时机**: 是否推迟到 terminal 稳定后再做？还是和 terminal 同版本？

3. **ChatState 重构范围**: 是否在 v0.0.29 就彻底移除 DOM 引用，还是渐进式？

4. **多 Provider 路线**: 如果未来考虑支持 Claude/Codex，现在就需要在 AcpClient 层留出扩展口；如果不考虑，保持当前单 provider 简洁性。

5. **发布策略**: v0.0.30 (fs 只读) 是否可以作为第一个 beta 发布到 Obsidian 社区插件市场？还是等到 v0.1.0？

---

## 七、已完成功能回顾

### 版本历史

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.0.22 | MCP http/sse, terminal content, audio type | ✅ |
| v0.0.23 | 方法别名回退 (requestWithFallback) | ✅ |
| v0.0.24 | AgentCapabilities 驱动 UI | ✅ |
| v0.0.25 | ESLint/Prettier/git hooks/README matrix | ✅ |
| v0.0.26 | SessionUpdateNormalizer | ✅ |
| v0.0.27 | 消除全部 33 个 lint warnings | ✅ |

### ACP 能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| newSession / loadSession / listSessions / closeSession / forkSession / resumeSession | ✅ | 含方法别名回退 |
| session/update (12 种 update 类型) | ✅ | parseSessionUpdate 全覆盖 |
| requestPermission (allow_once/allow_always/reject_once/reject_always) | ✅ | safe / plan / yolo 三模式 |
| MCP stdio | ✅ | 含 env 配置 |
| MCP http / sse | ✅ | v0.0.22 引入 |
| promptCapabilities.image | ✅ | drag-drop 支持 |
| promptCapabilities.audio | 🟡 | 类型已定义，UI 未实现 |
| terminal/* (create/output/kill/wait_for_exit/release) | ❌ | 规划中 (v0.0.31) |
| fs/read_text_file / fs/write_text_file | ❌ | 规划中 (v0.0.30) |
| authMethods | 🟡 | 仅显示提示，未实现登录终端 |
| agentCapabilities 协商驱动 UI | 🟡 | v0.0.24 落地中 |
