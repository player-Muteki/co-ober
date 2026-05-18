# Copsidian — OpenCode × Obsidian 深度整合插件总体规划

## Context

**问题**：开发者在 Obsidian 中管理知识笔记，在 OpenCode 中执行 AI 编程任务，两者之间没有联动。笔记内容无法作为 OpenCode 的上下文，OpenCode 的执行结果也不会回流到 Obsidian。

**方案**：开发一个 Obsidian 插件 **Copsidian**，在侧边栏嵌入完整的 OpenCode agent 交互界面，实现笔记与 OpenCode 的无缝双向联动。

**参考**：Claudian（ Claudian-2.0.16）的多 provider 架构、ACP 协议实现、控制器模式；OpenCode（v1.15.3）的 SDK 与工具系统。**从零重写，不复用 Claudian 代码**。

**关键约束**：
- 只通过 ACP 协议与 OpenCode 完整 agent 进程通信，不支持直接 API 模式
- OpenCode 的全部特性、指令、工具、功能都不可缺失，必须完整支持

---

## Phase 1: 项目骨架与构建

### 1.1 目录结构

```
copsidian/
├── package.json
├── manifest.json
├── tsconfig.json
├── esbuild.config.mjs
├── styles/
│   └── main.css              # 插件样式（Obsidian 自动加载）
├── src/
│   ├── main.ts               # 插件入口
│   ├── settings.ts           # 插件设置 + SettingTab
│   ├── types.ts              # 共享类型定义
│   │
│   ├── view/
│   │   ├── copsidianView.ts  # ItemView 侧边栏面板
│   │   └── layout.ts         # 面板 DOM 布局组装
│   │
│   ├── chat/
│   │   ├── session.ts        # 会话/对话数据模型
│   │   ├── messages.ts       # 消息类型 + 渲染数据模型
│   │   ├── renderer.ts       # 流式消息渲染器（Markdown/ToolCall/Thinking）
│   │   └── input.ts          # 输入框 + @mention + 发送逻辑
│   │
│   ├── client/
│   │   ├── index.ts          # 统一 OpenCode 客户端接口
│   │   └── acp.ts            # ACP 协议客户端（subprocess 模式）
│   │
│   ├── sync/
│   │   ├── engine.ts         # 执行结果同步引擎
│   │   ├── rules.ts          # 同步规则配置模型
│   │   └── templates.ts      # 同步笔记模板
│   │
│   ├── context/
│   │   ├── mention.ts        # @mention 笔记引用系统
│   │   ├── resolver.ts       # 笔记内容解析器
│   │   └── injection.ts      # 上下文注入构建器
│   │
│   └── utils/
│       ├── vault.ts          # Vault 文件操作
│       └── markdown.ts       # Markdown 处理工具
│
├── assets/
│   └── icon.png              # 插件图标
├── .opencode/                 # Copsidian 管理的 OpenCode 运行时配置
│   └── opencode/              # ACP 会话的工作目录
└── .github/
    └── workflows/
        └── release.yml       # 自动发布
```

### 1.2 构建配置

**依赖**（参考 Claudian，精简为 OpenCode 专用）：
```jsonc
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "~1.29.0",   // ACP JSON-RPC 通信
    "tslib": "^2.8.1"
  },
  "devDependencies": {
    "obsidian": "latest",
    "esbuild": "^0.28.0",
    "typescript": "^5.7.0"
  }
}
```

**构建流程**：esbuild 单文件打包 → `main.js` + `manifest.json` + `styles/main.css`

**manifest.json**：
```json
{
  "id": "copsidian",
  "name": "Copsidian",
  "description": "Embed the complete OpenCode agent inside Obsidian sidebar",
  "minAppVersion": "1.7.0",
  "isDesktopOnly": true
}
```

---

## Phase 2: 核心架构

### 2.1 插件入口 (`src/main.ts`)

```typescript
class OpnianPlugin extends Plugin {
  // OpenCode 客户端单例
  private client: OpencodeClient | null = null;
  // 会话持久化存储
  private store: SessionStore;
  
  async onload() {
    // 注册侧边栏 View
    this.registerView(VIEW_TYPE_OPNIAN, (leaf) => new OpnianView(leaf, this));
    
    // 注册设置页
    this.addSettingTab(new OpnianSettingsTab(this));
    
    // 注册命令
    this.addCommand({ id: 'open-opnian', name: 'Open Opnian', callback: () => this.activateView() });
    
    // 初始化存储
    this.store = new SessionStore(this);
    
    // 初始化客户端（根据设置选择连接模式）
    this.client = await this.createClient();
  }
}
```

### 2.2 统一客户端接口 (`src/client/index.ts`)

Copsidian 只通过 ACP 协议与 OpenCode 完整 agent 进程通信。不剥离任何功能 — OpenCode 的全部特性、指令、工具、权限系统、计划模式、subagent 等都必须在 Copsidian 中完整暴露。

```typescript
// 唯一接口 — ACP 协议客户端
interface OpencodeClient {
  // 生命周期
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // 会话管理
  createSession(options?: SessionOptions): Promise<SessionId>;
  loadSession(sessionId: SessionId): Promise<void>;
  listSessions(): Promise<SessionMeta[]>;

  // 对话（流式）
  sendMessage(
    message: UserMessage,
    contextBlocks?: ContextBlock[],  // 从 Obsidian 笔记注入的上下文
    onChunk: (chunk: StreamChunk) => void,
    onToolCall?: (toolCall: ToolCallInfo) => void,
    onSessionUpdate?: (update: SessionUpdate) => void,
  ): Promise<FinalResponse>;

  // 取消
  cancel(): void;

  // 模式切换（plan mode / yolo mode / safe mode 等 OpenCode agent mode）
  setMode(mode: string): Promise<void>;

  // 权限控制（对应 OpenCode 的 tool permission system）
  setPermissionHandler(handler: PermissionHandler): void;

  // 全部 agent 能力探测
  getCapabilities(): OpenCodeCapabilities;

  // 工具调用相关
  handleToolPermissionRequest(request: PermissionRequest): Promise<PermissionDecision>;
  handleAskUserQuestion(question: AskUserQuestion): Promise<AskUserAnswer>;
  handleExitPlanMode(decision: ExitPlanModeDecision): Promise<void>;
}
```

### 2.3 ACP 协议客户端 (`src/client/acp.ts`)

参考 Claudian 的 ACP 实现，使用 `AcpSubprocess` + `AcpClientConnection` 模式：

```
流程：
1. 启动 subprocess: `opencode acp`
2. JSON-RPC 初始化 → initialize()
3. 创建/加载会话 → newSession() / loadSession()
4. 发送消息 → prompt() (streaming)
5. 接收通知 → session/update (tool calls, content chunks, mode changes)
6. 文件系统操作 → fs/readTextFile / fs/writeTextFile
7. 权限请求 → session/requestPermission
8. 终端管理 → terminal/create, terminal/release, terminal/kill
9. 模式/配置切换 → session/set_mode, session/set_config_option
```

关键 ACP 方法映射（参考 Claudian 的 `methodNames.ts`）：

| 逻辑方法 | ACP 方法名 | 用途 | 对应 OpenCode 特性 |
|---------|-----------|------|-------------------|
| initialize | `initialize` | 协议握手 | - |
| newSession | `session/new` | 创建对话 | Session 管理 |
| loadSession | `session/load` | 加载历史 | 历史恢复 |
| listSessions | `session/list` | 列出会话 | Session 管理 |
| prompt | `session/prompt` | 发送消息（流式） | 对话核心 |
| cancel | `session/cancel` | 取消流 | 中断 |
| readTextFile | `fs/readTextFile` | 读文件 | read / grep / glob |
| writeTextFile | `fs/writeTextFile` | 写文件 | edit / write / apply_patch |
| requestPermission | `session/request_permission` | 权限请求 | Permission system |
| releaseTerminal | `terminal/release` | 释放终端 | bash 工具 |
| terminal/create | `terminal/create` | 创建终端 | shell 执行 |
| terminal/kill | `terminal/kill` | 终止终端 | bash 执行 |
| terminal/output | `terminal/output` | 终端输出流 | bash 实时输出 |
| terminal/wait_for_exit | `terminal/wait_for_exit` | 等待终端退出 | bash 阻塞等待 |

**必须完整支持的能力**：

```typescript
interface OpenCodeCapabilities {
  // Agent 功能
  supportsPlanMode: boolean;        // 计划模式 (plan mode)
  supportsSubagents: boolean;       // 子 agent
  supportsCompaction: boolean;      // 上下文压缩
  supportsThink: boolean;           // 深度思考
  supportsToolCalls: boolean;       // 工具调用
  supportsPermissions: boolean;     // 权限系统
  supportsSkills: boolean;          // 技能系统
  supportsSlashCommands: boolean;   // 斜杠指令
  supportsMcpServers: boolean;      // MCP 集成
  supportsAgents: boolean;          // Agent 定义
  supportsQuestion: boolean;        // Ask user question
  supportsExitPlanMode: boolean;    // Exit plan mode
  supportsAutoTurn: boolean;        // 自动连续对话

  // 工具支持（全部 OpenCode 内置工具）
  toolNames: string[];              // edit, write, read, bash, glob, grep,
                                     // apply_patch, webfetch, websearch, task,
                                     // todo, question, lsp, repo_clone,
                                     // repo_overview, plan, truncate
}
```

**OpenCode 运行时管理**：

Copsidian 需要在 vault 的工作目录下创建 `.opencode/` 运行时配置（类似 Claudian 的 `.claudian/`），包括：
- 自动管理 OpenCode 的 config.json（注入 system prompt、agent 定义等）
- 管理 `.opencode/opencode/config.json` 确保 ACP 会话有正确的配置
- 管理 `.opencode/opencode/system.md` 自定义系统提示词

### 2.4 连接模式

单一模式：ACP 子进程通信。

```typescript
class OpencodeClient implements OpencodeClient {
  private subprocess: AcpSubprocess;
  private connection: AcpClientConnection;

  async connect() {
    // 1. 读取设置中的 CLI 路径
    // 2. 准备 .opencode/ 运行时配置（config + system prompt）
    // 3. 启动 opencode acp 子进程
    // 4. JSON-RPC initialize → 创建会话
  }
}
```

用户只需配置：
- OpenCode CLI 路径（或从 PATH 自动发现）
- ACP 连接参数

---

## Phase 3: 聊天界面

### 3.1 侧边栏视图 (`src/view/copsidianView.ts`)

继承 `ItemView`，结构：

```
┌─────────────────────────────────┐
│  [logo] Copsidian  [+新对话] [历史▼]│  ← Header
├─────────────────────────────────┤
│                                 │
│  [消息列表区域]                  │  ← Chat Messages
│  - 用户消息                      │
│  - AI 回复（流式）               │
│  - Tool 调用折叠块               │
│  - Thinking 块                  │
│                                 │
├─────────────────────────────────┤
│  [文件引用标签] [@main.ts]       │  ← Context Chips
├─────────────────────────────────┤
│  [输入框        ] [发送]         │  ← Input + Toolbar
└─────────────────────────────────┘
```

### 3.2 会话数据模型 (`src/chat/session.ts`)

```typescript
interface Session {
  id: SessionId;              // 与 OpenCode session 对应
  title: string;              // 自动/手动标题
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  opencodeSessionId?: string; // 底层 OpenCode session ID
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;            // Markdown 文本
  type: 'text' | 'tool-call' | 'tool-result' | 'thinking';
  toolCallInfo?: ToolCallInfo; // 如果是 tool 类型
  timestamp: number;
  syncNotePath?: string;       // 如果此消息已同步到 Obsidian 笔记
}
```

### 3.3 消息渲染 (`src/chat/renderer.ts`)

处理三种内容块：

1. **文本消息**：Markdown 渲染（使用 Obsidian 的 MarkdownRenderer）
2. **Tool 调用**：折叠面板，显示工具名、参数、执行状态、结果
3. **Thinking 块**：折叠面板，带"思考中"动画

流式更新：收到 `StreamChunk` → 追加/更新 DOM → 自动滚动

### 3.4 输入与 @mention (`src/chat/input.ts`)

```typescript
class ChatInput {
  // 支持 @mention 引用 Obsidian 笔记
  // 输入 @ 触发下拉，列出 vault 中的笔记
  // 选中后插入 wikilink 格式的引用：[[Note Name]]
  
  // 发送时，上下文解析器自动提取被 @mention 笔记的内容注入 prompt
}
```

---

## Phase 4: OpenCode 深度集成

### 4.1 上下文注入系统 (`src/context/`)

**@mention 系统**：
- 输入 `@` 时下拉显示 vault 中所有笔记（标题 + 路径）
- 支持搜索过滤
- 选中的笔记以 chip/tag 形式显示在输入区
- 发送消息时，自动读取这些笔记的内容，以结构化格式注入 system prompt

**上下文注入格式**：
```markdown
The user has referenced the following Obsidian notes in their message. 
You should consider their content as relevant context for your response:

=== NOTE: [[Architecture Decision]] ===
{full markdown content of the note}
=== END NOTE ===
```

**双向链接**：
- AI 回复中的文件路径 / 笔记引用 → 可点击的 wikilink
- 工具调用结果中涉及的文件 → 自动创建可点击的 Obsidian 文件链接

### 4.2 执行结果同步引擎 (`src/sync/`)

**触发时机**：当 OpenCode 执行 `edit`、`write`、`bash` 工具时，ACP 通知中会携带这些信息。

**同步规则配置**（在设置中管理）：

```typescript
interface SyncRule {
  id: string;
  enabled: boolean;
  // 匹配条件
  match: {
    toolName: 'edit' | 'write' | 'bash' | 'all';
    pathPattern?: string;      // glob 路径匹配
    fileExtension?: string;    // 文件扩展名过滤
  };
  // 同步目标
  target: {
    folder: string;            // 同步到 vault 中的哪个文件夹
    filenameTemplate: string;  // 模板: {{tool}}-{{date}}-{{shortId}}
    format: 'markdown' | 'raw';
  };
  // 内容模板
  template?: string;           // 自定义笔记模板（支持变量）
}
```

**同步笔记模板**（`src/sync/templates.ts`）：

```markdown
---
tool: {{toolName}}
timestamp: {{date}}
session: {{sessionId}}
file: {{filePath}}
status: {{status}}
---

# {{toolName}} 执行结果

{{content}}

## 原始输出
<details>
<summary>查看完整输出</summary>

{{fullOutput}}

</details>
```

**同步流程**：
```
OpenCode tool execution → ACP notification
  → sync.Engine.process()
    → 匹配 sync rules
    → 生成笔记内容（模板渲染）
    → 写入 vault: this.app.vault.create(file)
    → 标记消息 syncNotePath
```

---

## Phase 5: 设置与配置

### 5.1 设置界面 (`src/settings.ts`)

```
┌─────────────────────────────┐
│  Copsidian 设置              │
├─────────────────────────────┤
│  连接设置                     │
│  □ 启用 Copsidian           │
│  OpenCode CLI 路径: [____]  │
│  工作目录: [{vault} ▼]     │
├─────────────────────────────┤
│  Agent 配置                   │
│  默认 Agent: [build ▼]      │
│  默认模式: [safe ▼]         │
│  思考级别: [关闭 ▼]         │
│  服务层级: [default ▼]      │
├─────────────────────────────┤
│  系统提示词                   │
│  [多行文本框 - 自定义 prompt]│
├─────────────────────────────┤
│  笔记引用设置                 │
│  最大引用字数: [8000 ▼]     │
│  默认引用文件夹: [___]      │
├─────────────────────────────┤
│  同步规则                     │
│  [+ 添加规则]               │
│  ┌───────────────────────┐  │
│  │ edit → opencode-sync/ │  │
│  │ write → opencode-sync/│  │
│  │ bash → opencode-sync/ │  │
│  └───────────────────────┘  │
├─────────────────────────────┤
│  外观设置                     │
│  最大 Tab 数: [3 ▼]         │
│  Tab 栏位置: [输入区 ▼]     │
│  自动滚动: [□ 开启]         │
│  语言: [中文 ▼]             │
└─────────────────────────────┘
```

### 5.2 设置存储

设置持久化到 Obsidian 的 plugin data 目录：
```
{vault}/.obsidian/plugins/copsidian/data.json
```

---

## 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 插件入口、View 注册、设置管理 |
| `src/types.ts` | 共享类型（Message, Session, StreamChunk, ToolCallInfo, PermissionRequest 等） |
| `src/client/index.ts` | OpencodeClient 接口定义 |
| `src/client/acp.ts` | ACP 协议客户端实现（唯一连接模式） |
| `src/client/agent.ts` | OpenCode Agent 特性封装（plan mode, subagent, permission, skill 等） |
| `src/view/copsidianView.ts` | 侧边栏 ItemView |
| `src/view/layout.ts` | 面板 DOM 组装 |
| `src/chat/session.ts` | 会话数据模型与持久化 |
| `src/chat/renderer.ts` | 消息渲染引擎 |
| `src/chat/input.ts` | 输入框 + @mention + 斜杠指令 |
| `src/context/mention.ts` | @mention 笔记引用系统 |
| `src/context/injection.ts` | 上下文注入构建器 |
| `src/sync/engine.ts` | 执行结果同步引擎 |
| `src/sync/rules.ts` | 同步规则管理 |
| `src/sync/templates.ts` | 同步笔记模板 |
| `src/settings.ts` | 设置界面 + SettingTab |
| `styles/main.css` | 插件样式 |

---

## 实施步骤

### Step 1: 项目骨架
- [ ] 初始化 package.json, manifest.json, tsconfig.json
- [ ] 配置 esbuild 构建
- [ ] 创建 main.ts 插件入口（注册 View + SettingsTab）
- [ ] 创建空 View 并验证能加载

### Step 2: OpenCode ACP 客户端
- [ ] 定义 OpencodeClient 统一接口 + OpenCodeCapabilities 类型
- [ ] 实现 ACP 协议客户端（subprocess + JSON-RPC）
- [ ] 实现会话创建/加载/列出
- [ ] 实现 prompt 流式发送 + session/update 通知接收
- [ ] 实现 cancel 功能
- [ ] 实现 .opencode/ 运行时配置管理（config.json + system.md）
- [ ] 实现终端管理（create/release/kill/output/wait）

### Step 3: 完整 Agent 特性
- [ ] 实现 Plan Mode 支持（set_mode + exit plan mode）
- [ ] 实现 Subagent 支持（子 agent 生命周期 + 结果渲染）
- [ ] 实现 Permission 系统（ask/allow/deny 决策流程）
- [ ] 实现 Ask User Question（交互式问答卡片）
- [ ] 实现 Compaction（上下文压缩）
- [ ] 实现 Think 模式（深度思考折叠面板）
- [ ] 实现 Skill 系统（技能发现与执行）
- [ ] 实现 Slash Commands（斜杠指令支持）
- [ ] 实现 MCP 集成（MCP 服务器管理）
- [ ] 实现 Agent 定义（多 agent 切换）

### Step 4: 聊天界面
- [ ] 实现侧边栏 View 布局
- [ ] 实现消息渲染器（文本 + tool call + thinking）
- [ ] 实现输入框 + @mention + 斜杠指令
- [ ] 实现流式更新 + 自动滚动
- [ ] 实现会话列表 + 新对话按钮 + Tab 管理

### Step 5: 笔记上下文
- [ ] 实现 @mention 下拉组件
- [ ] 实现笔记内容解析 + 上下文注入
- [ ] 实现回复中的 wikilink 自动转换

### Step 6: 执行同步
- [ ] 实现同步规则配置 UI
- [ ] 实现同步引擎（tool call → 笔记）
- [ ] 实现模板渲染
- [ ] 实现 syncNotePath 标记

### Step 7: 设置与 polish
- [ ] 完整设置界面（连接/agent/系统提示词/笔记引用/同步/外观）
- [ ] 样式完善
- [ ] 测试与调试

---

## 验证方案

1. **基础验证**：编译通过 → 安装到 Obsidian → View 正常打开
2. **连接验证**：设置 OpenCode CLI 路径 → 发送消息 → 收到回复
3. **Agent 特性全覆盖验证**：
   - Plan mode：发送复杂问题 → 验证进入/退出 plan mode 流程
   - Tool 调用：验证所有 OpenCode 工具（edit/write/read/bash/grep/glob/apply_patch/webfetch/websearch/task/todo/question/lsp/repo_clone/repo_overview/plan/truncate）均可正常调用
   - Subagent：验证子 agent 创建、执行、结果渲染
   - Permission：验证 ask/allow/deny 决策流程
   - Ask User Question：验证交互式问答卡片
   - Think 模式：验证深度思考折叠面板
   - Compaction：验证长对话上下文压缩
   - Skill：验证技能发现与执行
   - Slash Commands：验证斜杠指令可用性
   - MCP：验证 MCP 服务器集成
4. **上下文验证**：@mention 笔记 → 验证笔记内容注入 prompt
5. **双向链接验证**：AI 回复中的文件路径 → 验证可点击跳转到 Obsidian
6. **同步验证**：触发 OpenCode edit/write/bash → 验证 Obsidian 笔记自动创建
7. **流式验证**：长时间对话 → 验证流式渲染和自动滚动正常
8. **完整性验证**：用 OpenCode CLI 执行的操作 → 在 Copsidian 中逐一复现 → 确认功能完全一致
9. **跨平台验证**：在 Windows/macOS/Linux 上分别测试 ACP 子进程启动
