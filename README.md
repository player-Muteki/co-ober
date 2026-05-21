# Copsidian

![GitHub stars](https://img.shields.io/github/stars/player-Muteki/copsidian?style=social)
![GitHub release](https://img.shields.io/github/v/release/player-Muteki/copsidian)
![License](https://img.shields.io/github/license/player-Muteki/copsidian)

> English | [中文](#中文)

An Obsidian plugin that embeds the complete [OpenCode](https://opencode.ai) AI Agent in your vault. Your notes become the agent's context — ask, summarize, organize, and create content without ever leaving Obsidian.

## Why Copsidian

Existing AI plugins for Obsidian fall into two categories: those that require third-party API keys (incurring ongoing token costs) and those that rely on middleware layers (increasing token consumption). Copsidian connects directly to your local OpenCode CLI, which provides free token quotas sufficient for most note-taking users. No API keys, no middlemen — just direct, lightweight Agent access.

## Features

**Chat Sidebar** — Open from the ribbon icon or command palette. Talk to the OpenCode Agent directly inside Obsidian, with streaming responses rendered in real-time.

**`@mention` Notes** — Type `@` to reference any note in your vault. The agent reads and understands your existing knowledge base, then answers, summarizes, or creates content based on it.

**Auto-Save Output as Notes** — AI-generated content saves directly to your local Vault via the sync engine. No manual copy-paste needed.

**Drag & Drop** — Drop files and images directly into the chat for the agent to analyze or reference.

**Multi-Session Management** — Run multiple conversations simultaneously. Sessions persist across Obsidian restarts with configurable retention policies.

**Model & Mode Switching** — Switch AI models and Agent modes (`build` / `plan` / `docs`) directly in the UI.

**Streaming Response Rendering** — Real-time rendering of Markdown, thinking blocks, tool calls, and plan panels.

**Sync Engine** — Tool call results (file edits, writes) are automatically written back to Vault notes based on configurable sync rules with filename templates.

**Permission Modes** — Choose your level of control: `yolo` (auto-approve all), `plan` (approve safe operations), or `safe` (confirm every action).

**Auto-Reconnect** — Automatically recovers when the OpenCode process crashes.

**i18n (Internationalization)** — Switch between English and Chinese UI in Settings → Appearance. Community translations welcome.

Language changes apply immediately to the settings tab and open Copsidian views, including notices, toolbar labels, inline edit UI, and runtime error messages. The selected language persists across plugin restarts.

**MCP Servers** — Configure local MCP servers in Settings and attach them automatically when creating new OpenCode sessions.

## Requirements

- [OpenCode CLI](https://opencode.ai) installed and accessible
- Obsidian v1.7.0+
- Desktop only (macOS, Linux, Windows)

## Installation

### Manual (recommended)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder called `copsidian` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/copsidian/
   ```
3. Copy the downloaded files into the `copsidian` folder
4. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Copsidian"

### Via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Open BRAT settings → **Add Beta Plugin**
3. Enter this repository URL
4. Enable the plugin in Obsidian settings

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/player-Muteki/copsidian.git
   cd copsidian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Copsidian"

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| OpenCode CLI Path | Path to the `opencode` executable | `opencode` |
| Default Agent | Agent mode on startup (`build` / `plan` / `docs`) | `build` |
| Permission Mode | `yolo` (auto-approve all) / `plan` (approve safe ops) / `safe` (confirm all) | `safe` |
| Custom System Prompt | Additional instructions injected into the agent | — |
| Default Sync Folder | Folder where sync notes are created | `opencode-sync` |
| Max Note Reference Size | Maximum bytes when reading a referenced note | `8000` |
| Max Messages per Session | Truncate session when exceeded | `200` |
| Session Retention Days | Remove empty sessions older than this | `30` |
| Sync Rules | Map tool call results to vault notes (tool → folder → filename template) | — |
| MCP Servers | Local stdio MCP server definitions (name → command → args) passed to new OpenCode sessions | — |
| Language | UI language (`en` / `zh`) | `en` |
| Auto Connect | Connect to OpenCode on Obsidian startup | `true` |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + N` | New session |
| `Ctrl/Cmd + L` | Clear screen |
| `Ctrl/Cmd + Shift + C` | Copy last assistant message |
| `Enter` | Send message |
| `Escape` | Stop generation |
| `@` | Reference a vault note |
| `/` | Slash commands |

## Privacy & Data Use

- **Sent to API**: Your input, referenced notes, attached files/images, and tool call outputs. All communication goes through your local OpenCode CLI, which handles provider API calls.
- **Local storage**: Copsidian settings and session data stored in Obsidian's plugin data (`data.json` within `.obsidian/plugins/copsidian/`). Synced notes are created in your configured folder (default: `opencode-sync/`).
- **No telemetry**: Copsidian does not send any telemetry or analytics data. Network activity is limited to the OpenCode CLI subprocess communicating with AI providers.
- **Environment**: The OpenCode subprocess inherits the Obsidian process environment for PATH resolution and proxy configuration.

## Troubleshooting

### OpenCode CLI not found

If you see `Failed to connect to OpenCode`, the plugin can't locate the `opencode` executable.

**Solution**: Set the full path to `opencode` in Settings → OpenCode CLI Path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which opencode` | `/usr/local/bin/opencode` |
| Windows (native) | `where.exe opencode` | `C:\Program Files\opencode\opencode.exe` |
| Windows (npm) | `npm root -g` | `{global-node-modules}\opencode\bin\opencode` |

**Alternative**: Add the directory containing `opencode` to your system PATH.

### Session not persisting

Sessions are stored in Obsidian's plugin data. If sessions disappear after restart:
- Check that Obsidian has write access to the `.obsidian/` directory
- Verify that session retention days is not set too low

### Sync rules not creating notes

- Ensure the target folder exists in your vault
- Check that the sync rule is enabled in Settings
- Verify the tool name matches the agent's tool call (e.g., `edit`, `write`)

## Architecture

```
src/
├── main.ts                      # Plugin entry point, lifecycle, unified storage
├── settings.ts                  # Settings tab with connection, agent, sync rule config
├── types.ts                     # Shared type definitions and defaults
│
├── client/                      # OpenCode Agent client layer
│   ├── acp.ts                   # Agent Client Protocol (JSON-RPC) transport
│   ├── agent.ts                 # Agent runtime: session management, streaming, permissions
│   └── index.ts                 # Module exports
│
├── view/                        # Sidebar chat view
│   ├── copsidianView.ts         # Main view component: session tabs, input, message list
│   └── renderer.ts              # Message rendering: markdown, tool calls, thinking blocks
│
├── context/                     # Vault context management
│   ├── mention.ts               # @mention note picker and resolution
│   ├── resolver.ts              # Resolve note/file references to content
│   └── injection.ts             # Inject resolved context into agent prompts
│
├── sync/                        # Sync engine: agent → vault
│   ├── engine.ts                # Execute sync rules, write tool results as notes
│   └── templates.ts             # Filename template rendering ({{tool}}, {{date}}, {{shortId}})
│
├── commands/                    # Slash command definitions
├── i18n/                        # Internationalization (EN/ZH locale dictionaries)
└── utils/                       # Cross-cutting utilities (vault path, etc.)
```

## Roadmap

- [x] OpenCode ACP integration
- [x] `@mention` vault notes
- [x] Multi-session management
- [x] Sync engine with configurable rules
- [x] Model and mode switching
- [x] Drag & drop files and images
- [x] Inline edit (select text in note → AI edit with diff preview)
- [x] MCP server support
- [ ] Custom agents and skills
- [x] i18n (internationalization)
- [ ] More to come!

## License

Licensed under the [MIT License](LICENSE).

## Star History

<a href="https://www.star-history.com/?repos=player-Muteki%2Fcopsidian&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&legend=top-left" />
 </picture>
</a>

## Acknowledgments

- [Obsidian](https://obsidian.md) for the plugin API
- [OpenCode](https://opencode.ai/) for the free AI Agent platform and ACP protocol

---

# 中文

> [English](#copsidian) | 中文

将完整的 [OpenCode](https://opencode.ai) AI Agent 嵌入 Obsidian 侧边栏。你的笔记就是 Agent 的上下文——在笔记中直接提问、总结、整理和创作。

## 为什么做 Copsidian

现有的 Obsidian AI 插件大致分两类：需要自行配置第三方 API Key（长期产生 Token 费用）或依赖中间层中转（增加 Token 消耗）。Copsidian 直连本地 OpenCode CLI，而 OpenCode 本身提供免费 Token 额度，对绝大多数笔记用户完全够用。无需 API Key，无需中间层——直接、轻量、零成本。

## 功能特性

**侧边栏对话** — 通过工具栏图标或命令面板打开。在 Obsidian 内直接与 OpenCode Agent 对话，流式响应实时渲染。

**`@提及` 笔记** — 输入 `@` 即可引用 Vault 中的任意笔记。Agent 能读取并理解你现有的知识库，然后基于笔记内容进行回答、总结或创作。

**输出自动保存为笔记** — AI 生成的内容通过同步引擎直接保存到本地 Vault，无需手动复制粘贴。

**拖拽文件/图片** — 将文件和图片直接拖入对话框，供 Agent 分析或引用。

**多会话管理** — 同时运行多个对话。会话在 Obsidian 重启后自动恢复，支持可配置的保留策略。

**模型与模式切换** — 在界面中直接切换 AI 模型和 Agent 模式（`build` / `plan` / `docs`）。

**流式响应渲染** — 实时渲染 Markdown、思考块、工具调用和计划面板。

**同步引擎** — 工具调用结果（文件编辑、写入）根据可配置的同步规则和文件名模板，自动写回 Vault 笔记。

**权限模式** — 选择你的控制级别：`yolo`（全部自动批准）/ `plan`（批准安全操作）/ `safe`（逐一确认）。

**自动重连** — OpenCode 进程崩溃后自动恢复连接。

**国际化（i18n）** — 在设置 → 外观中切换中英文界面，社区翻译欢迎提交 PR。

语言切换会立即应用到设置页和已打开的 Copsidian 视图，包括通知、工具栏文案、行内编辑界面和运行时错误提示。所选语言会在插件重启后保持生效。

**MCP 服务器** — 在设置中配置本地 MCP 服务器，新建 OpenCode 会话时自动附加。

## 系统要求

- 已安装并可访问 [OpenCode CLI](https://opencode.ai)
- Obsidian v1.7.0+
- 仅桌面端（macOS、Linux、Windows）

## 安装方式

### 手动安装（推荐）

1. 从[最新 Release](../../releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`
2. 在 Vault 的插件目录中创建 `copsidian` 文件夹：
   ```
   /path/to/vault/.obsidian/plugins/copsidian/
   ```
3. 将下载的文件复制到 `copsidian` 文件夹
4. 在 Obsidian 中启用插件：
   - 设置 → 第三方插件 → 启用 "Copsidian"

### 通过 BRAT 安装

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 打开 BRAT 设置 → **Add Beta Plugin**
3. 输入本仓库地址
4. 在 Obsidian 设置中启用插件

### 从源码安装（开发）

1. 将仓库克隆到 Vault 的插件目录：
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/player-Muteki/copsidian.git
   cd copsidian
   ```

2. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```

3. 在 Obsidian 中启用插件：
   - 设置 → 第三方插件 → 启用 "Copsidian"

## 配置说明

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| OpenCode CLI 路径 | `opencode` 可执行文件路径 | `opencode` |
| 默认 Agent | 启动时的 Agent 模式（`build` / `plan` / `docs`） | `build` |
| 权限模式 | `yolo`（全部自动批准）/ `plan`（批准安全操作）/ `safe`（逐一确认） | `safe` |
| 自定义系统提示词 | 注入 Agent 的额外指令 | — |
| 默认同步文件夹 | 同步笔记的创建位置 | `opencode-sync` |
| 最大笔记引用大小 | 引用笔记时的最大字节数 | `8000` |
| 每会话最大消息数 | 超出后截断 | `200` |
| 会话保留天数 | 超出天数的空会话将被清除 | `30` |
| 同步规则 | 将工具调用结果映射为 Vault 笔记（工具 → 文件夹 → 文件名模板） | — |
| MCP 服务器 | 本地 stdio MCP 服务器定义（名称 → 命令 → 参数），用于新建 OpenCode 会话 | — |
| 界面语言 | UI 语言（`en` / `zh`） | `en` |
| 自动连接 | Obsidian 启动时自动连接 OpenCode | `true` |

## 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Ctrl/Cmd + N` | 新建会话 |
| `Ctrl/Cmd + L` | 清空屏幕 |
| `Ctrl/Cmd + Shift + C` | 复制最后一条助手消息 |
| `Enter` | 发送消息 |
| `Escape` | 停止生成 |
| `@` | 引用 Vault 笔记 |
| `/` | 斜杠命令 |

## 隐私与数据

- **发送至 API**：你的输入、引用的笔记、附加的文件/图片以及工具调用结果。所有通信都经过本地 OpenCode CLI，由它处理与 AI 提供商的 API 调用。
- **本地存储**：Copsidian 的设置和会话数据存储在 Obsidian 的插件数据中（`.obsidian/plugins/copsidian/data.json`）。同步的笔记保存在你配置的文件夹中（默认：`opencode-sync/`）。
- **无遥测**：Copsidian 不发送任何遥测或分析数据。网络活动仅限于 OpenCode CLI 子进程与 AI 提供商的通信。
- **环境变量**：OpenCode 子进程继承 Obsidian 进程的环境变量，用于 PATH 解析和代理配置。

## 故障排除

### 找不到 OpenCode CLI

如果看到 `Failed to connect to OpenCode`，说明插件找不到 `opencode` 可执行文件。

**解决方案**：在设置 → OpenCode CLI 路径中填入 `opencode` 的完整路径。

| 平台 | 命令 | 示例路径 |
|------|------|----------|
| macOS/Linux | `which opencode` | `/usr/local/bin/opencode` |
| Windows（原生） | `where.exe opencode` | `C:\Program Files\opencode\opencode.exe` |
| Windows（npm） | `npm root -g` | `{global-node-modules}\opencode\bin\opencode` |

**替代方案**：将包含 `opencode` 的目录添加到系统 PATH。

### 会话重启后丢失

会话存储在 Obsidian 的插件数据中。如果重启后会话消失：
- 检查 Obsidian 是否对 `.obsidian/` 目录有写入权限
- 确认会话保留天数没有设置过低

### 同步规则没有创建笔记

- 确保目标文件夹在 Vault 中存在
- 检查设置中该同步规则是否已启用
- 确认工具名称与 Agent 的工具调用匹配（如 `edit`、`write`）

## 项目架构

```
src/
├── main.ts                      # 插件入口、生命周期管理、统一存储
├── settings.ts                  # 设置面板：连接、Agent、同步规则配置
├── types.ts                     # 共享类型定义和默认值
│
├── client/                      # OpenCode Agent 客户端层
│   ├── acp.ts                   # Agent Client Protocol (JSON-RPC) 通信
│   ├── agent.ts                 # Agent 运行时：会话管理、流式响应、权限控制
│   └── index.ts                 # 模块导出
│
├── view/                        # 侧边栏对话视图
│   ├── copsidianView.ts         # 主视图组件：会话标签、输入框、消息列表
│   └── renderer.ts              # 消息渲染：Markdown、工具调用、思考块
│
├── context/                     # Vault 上下文管理
│   ├── mention.ts               # @提及笔记选择器和解析
│   ├── resolver.ts              # 将笔记/文件引用解析为实际内容
│   └── injection.ts             # 将解析的上下文注入到 Agent 提示中
│
├── sync/                        # 同步引擎：Agent → Vault
│   ├── engine.ts                # 执行同步规则，将工具结果写入笔记
│   └── templates.ts             # 文件名模板渲染（{{tool}}、{{date}}、{{shortId}}）
│
├── commands/                    # 斜杠命令定义
├── i18n/                        # 国际化（中英双语词典）
└── utils/                       # 通用工具函数（Vault 路径等）
```

## 开发路线图

- [x] OpenCode ACP 集成
- [x] `@提及` Vault 笔记
- [x] 多会话管理
- [x] 可配置规则的同步引擎
- [x] 模型和模式切换
- [x] 拖拽文件和图片
- [x] 行内编辑（选中笔记文字 → AI 编辑并显示 Diff 预览）
- [x] MCP 服务器支持
- [ ] 自定义 Agent 和技能
- [x] 国际化（i18n）
- [ ] 更多功能持续开发中！

## 许可证

本项目采用 [MIT 许可证](LICENSE)。

## Star 历史

<a href="https://www.star-history.com/?repos=player-Muteki%2Fcopsidian&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=player-Muteki/copsidian&type=date&legend=top-left" />
 </picture>
</a>

## 致谢

- [Obsidian](https://obsidian.md) 提供的插件 API
- [OpenCode](https://opencode.ai/) 提供的免费 AI Agent 平台和 ACP 协议
