# Changelog

## 0.0.23 - 2026-05-26

### Added
- Add `requestWithFallback` to `AcpClient` to gracefully handle method name changes across different OpenCode CLI versions, falling back to legacy JSON-RPC method aliases when encountering `-32601` (Method not found) errors. Cache successful method names to eliminate redundant fallback attempts on subsequent calls.

## 0.0.22

### Added
- Added support for `http` and `sse` MCP servers in settings and ACP configuration output.
- Added support for `terminal` content in `tool_call_update` payloads for future terminal capabilities.
- Added `mimeType` property to `PromptPart.resource` in types.
- Added unit tests covering the new discriminated unions for MCP server configurations.

### Changed
- Converted `McpServerConfig` into a discriminated union.
- Updated settings UI to display a Type dropdown for selecting `stdio`, `http`, or `sse` MCP servers.

## 0.0.21 - 2026-05-26

### Changed
- Add comprehensive unit tests for full module coverage (36 test files, 403 tests):
  - `utils/vault.ts` — 12 tests for getVaultPath function
  - `client/agent.ts` — 34 tests for AgentRuntime delegation and permission handling
  - `client/AcpMethodNames.ts` — 25 tests for ACP method name aliases
  - `view/renderer.ts` — 31 tests for ChatRenderer message rendering
  - `view/dragDropManager.ts` — 13 tests for drag/drop file handling
  - `view/keybindingManager.ts` — 11 tests for keyboard shortcuts
  - `view/sessionDropdown.ts` — 12 tests for session list UI
  - `view/autocomplete.ts` — 19 tests for autocomplete dropdown
  - `i18n/locale.test.ts` — 5 tests for locale completeness validation

## 0.0.20 - 2026-05-26

### Fixed
- Sync manifest.json version to match package.json
- Fix TypeScript type errors in streamController.test.ts
- Remove coverage directory (should have been deleted by PR #20)

### Changed
- Add PLANNING_REPORT.md with architecture and planning report
- Improve test coverage for ChatInput, StreamController, getLocale, AcpSubprocess

## 0.0.19 - 2026-05-25

### Changed
- Integrate AcpJsonRpcTransport into AcpClient, replacing inline readline/JSON-RPC logic
- Integrate AcpSubprocess into AcpClient, replacing direct child_process.spawn usage
- AcpClient now delegates transport to AcpJsonRpcTransport and process lifecycle to AcpSubprocess
- Add 37 new unit tests for AcpJsonRpcTransport, AcpSubprocess, and AcpErrors (202 total)

## 0.0.18 - 2026-05-25

### Changed
- Extract ACP client layer into modular components for better maintainability:
  - `AcpMethodNames.ts` — Logical method name aliases for OpenCode CLI version compatibility
  - `AcpJsonRpcTransport.ts` — JSON-RPC transport with timeout support and notification handlers
  - `AcpSubprocess.ts` — Process lifecycle management (spawn, shutdown, stderr capture)
  - `AcpErrors.ts` — Hierarchical error types (transport, protocol, timeout, process exit)

## 0.0.17 - 2026-05-25

### Fixed
- Add `reject_always` to permission option kinds for correct safe-mode rejection handling.
- Parse and store `agentCapabilities` from ACP initialize response for capability negotiation.
- Persist `sessionInfo` (sessionId, title, cwd) from `session_info_update` into client snapshot.
- Add `audio` content type to `PromptPart` for ACP protocol alignment.
- Support MCP server environment variable configuration in settings UI and ACP transport.

## 0.0.16 - 2026-05-25

### Added
- Extract WelcomeView component from CopsidianView for welcome page rendering and connection status display.
- Add event-driven i18n locale change mechanism (`onLocaleChange`) so child components self-manage locale updates instead of relying on parent imperative calls.
- Add unit tests for DragDropManager (6 tests), PermissionBanner (3 tests), InlineEditPanel (5 tests), and Mutex (3 tests).

### Changed
- ChatInput, InputToolbar, ChatRenderer, InlineEditPanel, DragDropManager, PermissionBanner, and WelcomeView register their own locale change listeners in constructors.
- Simplify CopsidianView.refreshLocale() by removing manual child component locale update calls.

## 0.0.15 - 2026-05-25

### Fixed
- Sanitize sync note paths to prevent path traversal, absolute paths, drive letters, and illegal filename characters.
- Support `rawInput.path` fallback in sync rule path matching alongside existing `filePath`.
- Restore custom system prompt value display in Settings text area.
- Extract actual edited content from fenced code blocks in inline edit responses, stripping surrounding explanation text.
- Clean up ACP stream lifecycle: clear `activeStreamSessionId` and `chunkHandler` on complete/cancel, null out process reference on close.
- Use `once('close')` with kill fallback and 2s timeout in `disconnect()` to prevent hangs.

### Changed
- Extract drag-and-drop logic into `DragDropManager` component.
- Extract permission approval UI into `PermissionBanner` component.
- Extract inline edit diff panel into `InlineEditPanel` component.
- Replace manual ACP stdout buffer concatenation with `readline` interface for cleaner JSON-RPC line parsing.
- Change agent request timeout from fixed 5-minute total to idle timeout that resets on each streaming chunk.
- Add `Mutex` to `SyncEngine.process()` and session management to prevent concurrent Vault write conflicts and session race conditions.

## 0.0.14 - 2026-05-23

### Changed
- Defer OpenCode connection until first user action (send message or create session).
- Remove automatic connection during plugin startup, settings page load, and view initialization.
- Change autoConnect default from true to false for new installations.
- Update README documentation to reflect lazy connection behavior.

### Tested
- Add regression tests for deferred connection behavior.
- Verify plugin loads without blocking on OpenCode connection.

## 0.0.13 - 2026-05-22

### Fixed
- Preserve configured MCP servers when restoring existing OpenCode sessions.
- Initialize autocomplete after the chat input area is created.
- Deduplicate Copsidian side leaves during plugin reload/open stress scenarios.
- Make Copsidian view cleanup safe before the view finishes opening.

### Tested
- Add regression coverage for MCP session restore, autocomplete initialization, side leaf deduplication, and early view cleanup.
- Run high-pressure Obsidian regression smoke tests.

## 0.0.12 - 2026-05-22

### Changed
- Document custom agents and reusable custom skills in the English and Chinese feature lists.
- Mark completed roadmap and phase-plan items as done.

## 0.0.11 - 2026-05-22

### Added
- Add local custom agents and reusable custom skills with settings management and prompt injection.
- Load runtime agents, models, and skills/commands in Settings, and manage common models there.
- Limit the chat model selector to configured common models when common models are selected.

### Changed
- Apply configured default agent, model, and effort to newly created OpenCode sessions.

### Tested
- Add regression coverage for custom agent validation, prompt composition, common model filtering, runtime settings loading, and default session options.

## 0.0.10 - 2026-05-21

### Fixed
- Keep ACP permission requests responsive when the Obsidian permission UI handler fails by falling back to a safe reject decision.
- Align ACP initialize client metadata with the plugin release version.

### Tested
- Re-ran the full test suite five times during pressure testing and added ACP regression coverage for permission fallback handling.
- Cover live plugin settings language refresh alongside open chat view refresh.

## 0.0.9 - 2026-05-21

### Changed
- Mark inline edit with diff preview as complete and add regression coverage for preview, apply, discard, and locale refresh behavior.

## 0.0.8 - 2026-05-21

### Fixed
- Apply saved English/Chinese language settings on plugin startup and refresh both the plugin settings tab and open Copsidian views immediately after changing language in Settings.
- Complete i18n coverage for runtime notices, toolbar tooltips, inline edit UI and prompt, usage tooltips, sync failure messages, ACP errors, and default session titles.
- Harden permission handling so `safe` mode does not auto-approve tool requests when no UI permission handler is available.
- Prevent connection failures from blocking sidebar initialization, and avoid false “connected” states after failed reconnect attempts.
- Reject pending ACP requests when the OpenCode process exits or stdin is unavailable.
- Clear stale inline-edit state after apply, discard, session reset, or subsequent sends.
- Surface sync rule failures in the chat UI instead of only logging them to the console.
- Use byte-accurate note truncation and real file sizes for image attachment limits.

### Changed
- Split normal build and release packaging so `npm run build` validates version consistency without mutating release artifacts, while `npm run release` prepares release files.
- Update GitHub release workflow to use the release packaging script.

## 0.0.7 - 2026-05-21

### Added
- AI Edit Selection command: select text in any note and invoke to open sidebar with inline edit request
- SessionDropdown component extracted from main view
- Autocomplete component extracted from main view
- parseSessionUpdate, mergeAvailableCommands, extractConfigMeta ACP utilities
- Test coverage for chatState, session, mention, resolver, sync engine, and acp modules

## 0.0.6 - 2026-05-21

### Added
- Add configurable MCP server support for new OpenCode sessions
- Add Settings UI for enabling MCP servers with command and argument configuration

### Changed
- Sync local release artifacts automatically during production builds

## 0.0.5 - 2026-05-21

### Fixed
- Harden sync note generation for nested folders and non-string tool outputs
- Tighten Obsidian workspace, view, and sync typings to remove unsafe production casts

### Changed
- Remove ACP connection debug logs from production runtime
- Restore code block copy button labels through localized UI text

## 0.0.4 - 2026-05-21

### Added
- Add UI language setting with English/Chinese locale switch in Settings → Appearance

### Changed
- Wire i18n dictionaries through settings and interface labels for bilingual UX
- Refresh README with updated i18n feature notes and roadmap status

## 0.0.3 - 2026-05-20

### Fixed
- Fix `@` mention trigger false-positives in emails and paths
- Eliminate internal `(client as any).acp` property access with typed `setClientHandlers()`
- Log ACP write failures instead of silent returns
- Limit total pending image data to 10MB to prevent OOM
- Replace `any` with proper types in ACP protocol parsing and stream handling

## 0.0.2 - 2026-05-20

### Fixed
- Align default permission mode with safer behavior
- Persist auto-scroll setting and apply live to open views
- Prevent duplicate image attachments after sending
- Isolate sync rule failures and improve path pattern matching
- Update session timestamps during streaming output
- Improve Windows ACP spawn robustness without unsafe shells
- Stabilize auto-reference and connection status updates

## 0.0.1 - 2026-05-19

Initial release.

### Added
- Full OpenCode agent integration in Obsidian sidebar via ACP protocol
- Streaming responses with markdown, thinking blocks, tool calls, and plan panels
- Session management with persistence across restarts
- `@mention` notes to inject vault content as context
- Sync engine: tool call results written back to vault as notes
- Diff rendering for file edit operations
- Per-turn token usage and cost display
- Toolbar with model name, elapsed time, and stop button
- Resizable input area with drag handle
- Drag & drop files and images
- Session search and message timestamps
- Code block copy buttons
- Wikilink injection for vault file paths
- Auto-reconnect on OpenCode process crash
- Request timeout (5 minutes)
- Configurable session limits (max messages, retention days)
- Keyboard shortcuts: `Ctrl+N`, `Ctrl+L`, `Ctrl+Shift+C`
- Smart auto-scroll with "New messages" button
- GitHub Actions CI/CD with automatic release on tag push
