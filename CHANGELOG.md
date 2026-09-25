## 0.1.37 - 2026-09-25

### Added
- **Elicitation retirement**: when the agent reports an elicitation was answered elsewhere (`elicitation/complete`), the matching permission banner retires on its own instead of waiting for a click.
- **Unrecognized stop-reason badge**: a turn that ends with a stop reason outside the known enum still badges and notes the raw reason — agent enum drift no longer masquerades as a clean completion.
- **Queue-drop notice**: resetting or closing a conversation with prompts still queued reports how many were discarded instead of deleting them silently.
- **Currency-honest usage**: the usage line renders `€`/`¥`/`£` glyphs for known currencies and falls back to the raw code (`BTC 0.5000`) for unknown ones, so a non-USD cost can never be misread as dollars.

### Changed
- **Stable fork wire name**: session fork prefers the official `session/fork` method, with the unstable spellings kept only as fallbacks.
- **Paged session listing**: `session/list` follows `nextCursor` (page-bounded) instead of assuming one response holds the whole history.
- **Idle timeout is honest**: `0` disables it outright (the old setting silently snap-backed to 5 minutes), and while a permission banner is on screen the idle clock pauses — a slow human decision no longer kills the turn, and the full window restarts after the banner resolves.
- **Settings take effect live**: note reference size, terminal timeout and max output size re-push capabilities to the connected client on change — no reconnect needed.
- **Localized chrome**: the thinking timer, "Thought for Ns" duration, tool-source badges, session truncation marker and token units now follow the active language; unknown incoming notifications warn once per method instead of vanishing in silence.

### Fixed
- **Stale client disconnected before replacement**: a reconnect tears down the old client first, so its late callbacks can no longer mutate the new session's view.
- **Retention spares the in-flight turn**: persistence during streaming is exempt from history pruning, so a long turn can no longer save a transcript that truncated away its own messages.
- **Resume swaps the screen**: loading or resuming a session re-renders the transcript instead of layering the old conversation underneath.
- **Stop clears its tool ghosts**: stopping a turn finalizes still-running tool-call rows instead of leaving spinners frozen in "in progress".
- **Newer data is set aside intact**: `data.json` written by a newer plugin version is preserved under a distinct name and the plugin starts clean, instead of round-tripping data it cannot understand.
- **Concurrent loads no longer wipe streamed text**: the update normalizer resets only when no stream is active, so loading another session mid-answer no longer corrupts the message being streamed.
- **Official `plan_removed` honored**: the v2 plan-clearing frame now parses and empties the plan instead of surfacing as an unknown update.

## 0.1.36 - 2026-09-25

### Added
- **Official v2 notice frames**: `notice` session updates (severity/title/description) fold onto one transcript shape — warning and error lines render level-labeled, info renders plain.
- **Compaction upsert state machine**: v2 `compaction_update` frames carrying a `compactionId` pin the boundary marker at the first frame, suppress in-flight patch replays, surface a failure notice on `failed`, and stay silent on `cancelled`; legacy id-less frames behave exactly as before.
- **Idle state usage**: an `state_update` frame at idle carrying a usage record is adopted for the turn footer.
- **Durable stop badges and turn footers**: stop-reason badges persist as transcript system messages and usage stamps persist on the assistant message, so a finished conversation looks the same after reload as it did live.
- **Durable agent images**: images streamed by the agent are stored as image content blocks (deduped per message) and re-render from the transcript on reload.
- **The missing binary gets named**: an ENOENT launch failure reports the configured command and points at installation or the Settings path field instead of a bare connection error.
- **Over-budget image notice**: a pasted or dropped image that would exceed the 10 MB pending-image budget is now announced by file name instead of being skipped quietly.

### Changed
- **Desktop PATH gaps no longer block connect**: POSIX launches resolve a bare command against PATH plus the common install dirs (`~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`); the auto-connect pre-check, diagnostics and the spawn itself all use the same resolver, so they can never disagree.
- **Effort ladder widened**: the default-effort selector offers the full ladder — minimal, low, medium, high, xhigh and max.
- **Auto-connect pre-checks reachability**: an unresolvable command shows the notice and reconnect button immediately rather than spawning a doomed subprocess.

### Fixed
- **Corrupted `data.json` degrades**: a plugin-data load failure now falls back to defaults with a visible Notice and sets the unreadable file aside as `data.corrupt-<timestamp>.json` — the plugin no longer bricks on a damaged file.
- **Save failures are visible**: a failed chat-data save surfaces a throttled Notice instead of being silently dropped by fire-and-forget call sites.
- **Session switch cancels the outgoing turn**: the in-flight turn is cancelled before the session pointer moves, so the cancel actually reaches that turn rather than no-op'ing against the session being switched into.
- **Handshake-raced closes stop reconnect storms**: a subprocess close that races an in-flight handshake no longer schedules a reconnect — the failed connect owns its teardown, so a dead binary is not respawned over and over.

## 0.1.35 - 2026-09-23

### Added
- **Notice updates**: `notice_update` frames (parsed permissively as an extension — not in the official ACP schema yet) render as level-labeled system messages in the transcript.
- **Compaction boundary**: a `compaction_update` inserts a visible "context compacted" marker that is persisted with the transcript, and the replay collector keeps the boundary at its original position across reloads.
- **Non-text chunk placeholder**: streamed chunks that are neither text nor image (audio, resources, …) no longer vanish — a placeholder naming the content type is shown once per message and persisted.
- **Keyboard-accessible toolbar dropdowns**: the model and effort selectors are proper listbox widgets now — focusable trigger, Enter/Space/arrows to open, arrow-key roving focus over options, Enter to choose, Escape and outside clicks to close, with visible focus styles.
- **Native list failure row**: the session dropdown shows an explicit failure line when the OpenCode native session listing cannot be read instead of silently omitting the section.

### Changed
- **Capability-gated attach button**: the image attach button is disabled with an explanatory tooltip when the agent declares `promptCapabilities.image: false`, mirroring the send-path rule that strips images.
- **Stable tool identity**: `tool_call`/`tool_call_update` `name` is carried onto the snapshot as `toolName` and preferred by sync-rule matching, and `planId` on v2 plan envelopes is accepted.

### Fixed
- **Retention spares pins**: automatic history retention now exempts pinned conversations from pruning regardless of age, and the setting description says so.
- **Unload tail persistence**: pending transcript saves are flushed during plugin unload, so the final messages of a just-closed session survive.
- **Toolbar optimistic-update rollback**: a failed model/agent/effort change surfaces a Notice with the error and reloads the authoritative options instead of leaving the label on the rejected value.
- **`tool_calls` stop reason**: turns ending to await tool results render their own badge instead of masquerading as a normal completion.
- **Cost currency honesty**: the usage line reports the currency the agent actually attached to the cost (falling back to USD only when none is given), so non-USD costs are no longer mislabeled.

## 0.1.34 - 2026-09-23

### Added
- **Non-text streamed content**: chunk content now parses permissively instead of being dropped at the schema gate — image payloads render inline through a dedicated assistant-image style, other typed payloads (audio, resources) ride along unpainted, and interleaved text keeps accumulating correctly.
- **Pinned conversations**: each session row gains a star button; pinned chats sort to the top of the dropdown, the rest by most recently active, and pins persist with the plugin data.
- **`data.json` schema versioning**: plugin data is saved under a schema version and older files are sanitized at load (v0→v1), so a truncated or hand-edited `data.json` degrades instead of crashing hydrate.
- **Native agent/model metadata**: the v1 native session listing reads each session's `agent` and `model` columns into `SessionMeta`.

### Fixed
- **Ref-preserving stop**: pressing stop returns plain queued prompts to the input but keeps entries carrying @-mention or image refs queued — the textarea cannot represent refs, and dropping them silently lost context.
- **No more silent error swallowing**: a turn error discarded while disconnected and a cosmetic enrichment save failure now leave a console trace.
- **Plan and update resilience**: plan entries with missing fields fall back to neutral defaults instead of dropping the whole update, and an unknown `sessionUpdate` kind warns once per kind rather than vanishing silently.
- **Side-chat close aborts the turn**: closing the side-chat panel mid-answer cancels the in-flight turn instead of leaving a orphaned stream running.
- **autoConnect actually honored**: the toggle now controls startup behavior — on auto-connects the view, off leaves the manual reconnect button as the entry point — and it defaults to on; a legacy stored `false` (which the dead toggle could never express before 0.1.34) migrates to keep existing auto-connect behavior, while an explicit off after this release is respected.

## 0.1.33 - 2026-09-23

### Added
- **OpenCode v2 database reads**: a forked `opencode.db` (v2) is now read through `session_message` — session listing, native content search, per-session usage, per-message stats and tool errors all recover under v2 via the same reader, keeping v1 working through the cached schema probe.
- **ACP v2-alpha dispatch pre-layer**: `plan_update` frames are coerced into the internal plan shape and config options carried inside `session_info_update` are picked up, so forward-compatible agents no longer lose those frames.
- **Reload-safe turn throughput**: completed-turn `tok/s` is persisted onto each assistant message (TurnStats) and restored with the transcript, so throughput survives a reload; native turn stats are computed client-side from chronological evidence and attached by message id only — never guessed positionally.
- **Leaner data.json**: text-only content blocks that merely duplicate the message text are elided from the persisted copy and rebuilt on load, shrinking the sidecar without the in-memory transcript ever seeing the elided form.
- **Context percentage everywhere**: the header meter and the per-turn usage line/title now share one clamped context-occupancy helper.

### Fixed
- **Forked-schema detection**: the schema probe spots `session_message`/`data_migration`/`session_v2`; a v1-shaped database holding live v2 data classifies as forked and degrades every native read with one clear warning instead of silently serving a stale mirror, while empty v1.18 scaffold tables still classify as v1.
- **Double-escaped literals**: the system prompt now instructs the agent to decode entities exactly once, so `&amp;`-style literals survive round-trips into notes.
- **load vs resume sync notice**: `syncRuntimeSession` no longer silently skips when the agent advertises neither `session/load` nor `session/resume`; it says so in a system message instead.

### Notes
- fork-from-latest-reply was evaluated and deliberately deferred — no anchored fork exists on the ACP side yet; see `docs/decisions/fork-from-latest-reply.md`.

## 0.1.32 - 2026-09-23

### Added
- **Elicitation support**: `elicitation/create` requests from the agent are routed through the permission banner queue — allow/decline map to the spec's accept/decline/cancel outcomes — instead of being auto-rejected with `-32601`; the capability is advertised at initialize.
- **Authentication handshakes**: `authMethods` from initialize are parsed and normalized, and a session creation that fails with an auth-required error authenticates with the preferred method and retries once per connection.
- **`opencode.db` v2 defense**: a cached schema probe classifies the native database as v1, incompatible or unknown; unknown or unreadable never blocks reads, while an incompatible (v2+) database degrades every native read path with a single clear warning instead of throwing on unexpected tables.
- **Turn throughput**: completed turns show a `tok/s` figure derived strictly from native output+thinking evidence over the measured wall clock, with the same number in the usage tooltip.
- **Full config-option surfacing**: the effort dropdown now presents the agent's own option list when it provides one; known tiers get localized labels and custom tiers keep the agent's names, falling back to the built-in list only when the agent sends none.
- **Selection-aware streaming**: markdown re-renders are deferred while the user is selecting text inside the chat, so a live selection survives mid-stream refreshes.

### Fixed
- **Stream routing and stale turns**: `session/update` frames are filtered by sessionId so side-chat traffic can no longer bleed into the main transcript; main and side chat hold independent stream slots, and the agent-call finally hook no longer pollutes a fresh turn past its generation guard.
- **Vault writes**: the filesystem delegate writes through the Obsidian vault API with corrected `normalizePath` handling instead of raw host writes.
- **Stop reasons**: refusal, max-tokens and cancelled turns render with their own badges instead of masquerading as a normal completion.
- **Leak and race hygiene**: `scheduleSave` is disposed-guarded, renderer and session-dropdown timers are cleaned up on teardown, permission requests with unparseable payloads surface a visible warning, and native plan refresh no longer races the streaming plan.
- **Render parity**: mermaid fences are left to Obsidian's post-processor (no copy button injected), rendered markdown placeholders carry `.markdown-rendered` so ordered-list markers survive theming, and the injected system prompt now declares XML escaping for path attributes as well as note bodies.

## 0.1.31 - 2026-09-23

### Added
- **Side chat `/btw`**: fork the current session into a throwaway scratch thread with its own panel — ask a tangential question without disturbing the main conversation. Follow-ups reuse the same fork, and closing the panel disposes it.
- **Native session content search**: the session dropdown now searches OpenCode-native message text in `opencode.db`, not just titles, and shows a snippet around the first match; results are race-guarded so a stale search response never paints over a newer query.
- **Auto session titles**: after the first completed exchange the title is derived from the opening user prompt (slash commands are skipped), so new chats stop being stuck at `Chat 21:00:00`; later manual renames are never overwritten.
- **Queue visualization and merging**: prompts queued while busy render as individual removable rows in the queue bar, and consecutive plain prompts drain as one merged send, while slash-like or context-carrying entries keep their own turn.
- **`/resume` command**: re-opens the session picker straight from the composer.

### Fixed
- **Fork integrity**: switching to a forked session rebuilds the transcript and surfaces sync errors instead of leaving a blank view.
- **Queue robustness**: early returns in the agent-call path still run the finally hook (busy flag released, queue drained), and one failing queued command no longer aborts the rest of the drain.
- **Permission requests**: parallel `session/request_permission` calls now queue behind each other instead of being force-rejected.
- **Note cache**: referenced-note bodies are cached in a bounded LRU that invalidates entries when the vault modifies a note.
- **Locale hygiene**: the locale listener no longer leaks across view reloads, and slash-command titles refresh when the language changes.
- **Capability gating**: `loadSession`, audio input and embedded-context features are gated by the negotiated agent capabilities; transcript restore keeps system messages; the image lightbox captures focus and restores it on close.

## 0.1.30 - 2026-09-22

### Added
- **Real native plan panel**: the OpenCode todo table is read from `opencode.db` and re-attached to the plan panel on session restore, resume and after every turn. (Claudian parity)
- **Native session facts**: the session dropdown badges each OpenCode session with its actual added/removed line and changed-file counts, and restored transcripts show per-message cost/token footers plus persisted tool errors replayed from native step-finish stats.
- **Capability gating**: `initialize` agent capabilities are normalized and gate UI surfaces (MCP http/sse option labels, feature availability) instead of assuming them.
- **`[[wikilinks]]` as context**: links typed in the composer are resolved against the vault and their note bodies attached as context before the prompt is sent.
- **Vault-operations system prompt**: the injected system prompt now carries Obsidian vault editing guidance — read-before-edit, frontmatter/wikilink preservation, quoted-data-is-never-instructions, and the XML-escaping rules learned from broken patches.
- **Image lightbox**: clicking any image in the transcript (assistant markdown or uploaded attachments) opens a dismissable full-size overlay.
- **Turn collapsing**: finished turns with thinking/tool steps fold behind a "N steps" header that expands on click and is keyboard-accessible.
- **Default thinking effort setting**: a `Default Thinking Effort` dropdown in settings applies low/medium/high effort to each newly created session.
- **Full-suite renderer coverage**: new test suites for the diff, thinking and tool-call renderers; en/zh dictionaries stay key-identical.

### Fixed
- **Permission requests worked end-to-end**: `session/request_permission` is registered under all wire aliases with the spec outcome shape — production requests no longer fail with `-32601` — and dismissing or overwriting the permission banner resolves the pending request instead of hanging the agent.
- **Crash recovery reachable**: subprocess deaths classify as `AcpProcessExitError` and surface a restart action; reconnect/ensureSession errors reach the UI, and the `safe` permission tier actually routes requests to the banner (the client stored a constant instead of the assigned mode).
- **Send/Stop integrity**: busy state is claimed synchronously to kill the double-send race, and Stop restores queued prompts into the composer rather than dropping them.
- **Tool rendering**: buffered tool calls finalize at turn end, orphan `tool_call_update` frames synthesize a card, partial diffs with only one side render, and apply-patch file headers survive the diff render.
- **Lifecycle leaks**: file command sources unregister on view close, the ACP child process disconnects on plugin unload, and non-JSON stdout lines log a warning instead of vanishing.
- **`/export` no longer clobbers**: exported notes carry a time component so same-day exports sit side by side.
- **i18n sweep**: thinking blocks, diffs, tool cards, permission locations, toolbar permission labels, ribbon/command names, MCP settings and ACP error messages moved from hardcoded English into the en/zh dictionaries.

## 0.1.29 - 2026-09-22

### Added
- **Real cost and context usage**: adopting a native OpenCode session (load, resume, or selection from the dropdown) now pulls actual cost and token totals from `opencode.db`, and per-response `_meta` usage (context fill, window size, cost) feeds the context meter instead of leaving it stale.
- **`/export` and `/copy`**: save the whole conversation as a dated Markdown note under the configured sync folder, or put the rendered transcript on the clipboard; user bubbles gained per-message copy buttons.
- **Session rename**: pencil action in the session dropdown opens an inline editor for the local session title.
- **Delete confirmation**: removing a session now requires a second confirming click, with the confirmation reverting automatically after a few seconds.
- **Full i18n coverage**: the interrupt indicator, queue badge, help/model/mode command output, builtin command titles and the context-meter tooltip moved into the en/zh dictionaries.

### Fixed
- **Transport correctness**: unknown JSON-RPC requests now answer with `-32601` instead of a silent hang, `stopReason` values outside the ACP enum are normalized, and the idle timeout aborts the underlying request stream rather than only the client-side wait. (Claudian parity)
- **Visible session errors**: fork, resume and reconnection failures are surfaced as notices instead of being swallowed.
- **Rewind truncation timing**: regenerate / edit-and-resend truncates the local transcript before the fresh agent session replays, so the rewind block and stored history stay consistent.
- **Structured history replay**: restoring a session re-renders persisted tool-call blocks (status, title, kind) and image attachments instead of dropping them; image parts sent with a user message are now persisted and re-rendered on restore.
- **Context meter honesty**: the meter no longer falls back to per-turn token totals as an approximation of context fill.

## 0.1.28 - 2026-09-22

### Added
- **Image pipeline completion**: pasted or picker-selected images now actually reach the agent — every send drains pending image parts into the prompt, drag-drop shares the same budgeted entry point, a paperclip button opens the file picker, and unsupported agents are gated with a notice. (Claudian parity)
- **Transcript replay on session load**: `session/load` and `session/resume` replay updates are collected and adopted, so opening a native OpenCode session renders its full conversation instead of an empty pane. (Claudian parity)
- **Regenerate / edit-and-resend**: user bubbles gain hover actions to re-run or edit any earlier turn. Since ACP has no server-side truncate, the rewind rotates to a fresh agent session and replays the retained turns as a context-only block, truncating the local transcript under the edited turn. (Claudian parity)

## 0.1.27 - 2026-09-22

### Added
- **OpenCode native session history**: the session dropdown now lists OpenCode's own terminal sessions read straight from the native `opencode.db` (in-process `node:sqlite`, falling back to a spawned Node helper, then the `sqlite3` CLI). Selecting one restores it over ACP `session/load` so the conversation can continue inside Obsidian. (Claudian parity)
- **Readonly execution tier**: a fourth permission mode that auto-allows only non-mutating tools (read/search/fetch), auto-rejects every write or execution without prompts, and downgrades client-side capabilities to file-write readonly with terminal execution disabled.
- **Session-loss surfacing**: agent-side "session no longer exists" failures during switching, connect and reconnect are classified into a dedicated error and reported in chat instead of failing silently.

### Fixed
- **Generation-fenced reconnection**: every subprocess connection now carries a generation number; stale connect continuations, reconnect timers and `session/update` notifications from a superseded transport can no longer mutate or tear down the live connection.

## 0.1.26 - 2026-08-28

### Fixed
- **Session persistence races**: serialized plugin-data writes, guarded stale stream callbacks, and flush pending stream saves during view shutdown so recent messages are not lost.
- **Permission fallback safety**: clients without a permission callback now select a rejection option rather than inadvertently allowing an operation.

### Changed
- **Session ownership**: moved persisted sessions and active-session state into `SessionRepository`, with explicit hydrate, snapshot, and pruning behavior.
- **Controller boundary**: `CoOberViewController` now depends on a minimal runtime port instead of the concrete plugin class.
- **Quality gate**: CI runs tests, and lint now requires zero warnings; MCP capability settings use the precise agent capability type.

## 0.1.25 - 2026-06-19

### Fixed
- **Stop button not working**: `stopGeneration()` now calls `c.cancel()` before resetting `busy=false`, preventing new sends from starting before the backend agent is properly cancelled.
- **`cancel()` abort order in ACP**: abort controller fires before clearing `activeStreamSessionId`, so `sendMessage()`'s `.finally()` can properly detect the cancelled state.
- **Missing "Interrupted" indicator**: when user clicks stop, the assistant message now shows a red "Interrupted · What should I do instead?" badge, matching claudian's UX.

### Added
- **Queue indicator**: when messages are sent while streaming, a "⌙ N message(s) queued" bar appears above the input area. (claudian parity)

## 0.1.24 - 2026-06-19

### Added
- **Write/Edit diff stats in header**: collapsed tool calls now show `+x -y` directly in the header, with dedicated monospace styling and green/red color coding. Empty status hidden on completion so stats align flush-right. (claudian parity)
- **SVG status icons**: replaced text `…`/`✓`/`✗` with Obsidian SVG icons (`loader` with spin animation, `check`, `x`, `circle`) for running/completed/failed/pending states. (claudian parity)
- **Per-tool expanded content rendering**: bash/execute shows command + stdout/stderr + exit code; read shows first 15 lines; search/grep shows up to 20 hoverable matches; fetch/web_search shows content preview + source URL; think shows up to 30 lines. (claudian parity)
- **apply_patch multi-file diff rendering**: parses `*** Add/Update/Delete File:` markers, renders each file as a bordered section with operation badge (ADD/UPDATE/DELETE) and inline diff. (claudian parity)
- **ContentBlocks ordering**: stream controller now tracks tool call order and persists `contentBlocks[]` on saved messages, preserving interleaved text/tool_use/thinking order on replay. (claudian parity)
- **extractDiffData utility**: extracts structured diff data from SDK `structuredPatch` format, or falls back to computing from Edit `old_string`/`new_string` and Write `content`. (claudian parity)

### Fixed
- **Horizontal scrollbar in dialog**: `.co-ober-messages` now has `overflow-x: hidden`, tool/thinking bodies clip horizontally with internal scroll only, `.diff-line` breaks long lines with `word-break: break-all`. (claudian parity)
- **Text selection disabled**: `.co-ober-message-content` and `.co-ober-text-block` now explicitly set `user-select: text` so chat content can be selected and copied. (claudian parity)
- **tool_use block rendering**: content blocks now check `toolCallStates` first (most reliable), fall back to DOM lookup, then render truncated ID placeholder. (robustness)

### Changed
- **`ToolKind` type extended**: added `'apply_patch'` to the union type for first-class apply_patch tool support.

## 0.1.23 - 2026-06-19

### Fixed
- **Plugin loading failure**: `local-resolver` in esbuild.config.mjs was marking all non-relative imports as `external`, causing `zod` / `tslib` to be unresolvable in Obsidian's runtime. Fixed by restricting the resolver to relative/absolute paths only.
- **Test version drift**: `CLIENT_VERSION` test hardcoded to v0.1.21 now reads from `package.json` dynamically.

## 0.1.22 - 2026-06-19

### Added
- **Zod schema validation layer**: `acpSchemas.ts` defines 12 Zod schemas for all `SessionUpdate` variants, replacing raw `as` assertions in `parseSessionUpdate()` (~33 casts eliminated).
- **Constants extraction**: `constants.ts` centralizes 16 magic numbers (timeouts, thresholds, limits) used across the codebase.
- **Cache fix**: `noteContentCache` in `CoOberViewController` now actually writes entries (was get-only, 0% hit rate); LRU eviction at 100 entries added.

### Changed
- **Type safety overhaul**: all `as Record<string, unknown>` casts in `AcpRequestHandler.ts` replaced with Zod `safeParse` calls. `AcpSubprocess` `onClose()` deduplication fixed.
- **send()/sendTextToAgent() deduplication**: ~80 shared lines extracted into `executeAgentCall()` private method. `send()` reduced from ~117 to ~50 lines.
- **i18n robustness**: `setLocale` now wraps listener invocations in try/catch to isolate failures.
- **`/clear` command fix**: resets `busy`, `genId`, `noteContentCache`, and `cacheSessionId` to prevent stale state leaks.

### Fixed
- **All 7 test failures resolved**: 523 tests now pass (0 failures). Fixed version mismatch, shell detection for .cmd/.bat, autocomplete wrapping, subprocess timeout mock, and stale cancel/abort assertion.

## 0.1.21 - 2026-06-19

### Changed
- **settings.ts refactored**: `render()` method reduced from 398 lines to 22 lines by extracting 11 section methods. Large block-rendering methods (addCustomAgentBlock, addCustomSkillBlock, addCommonModelToggle, addMcpServerBlock, addSyncRuleBlock, renameCustomAgent, renameCustomSkill) moved to `src/settings/settingBlocks.ts` as standalone functions with explicit dependencies.
- **DiffRenderer types cleaned**: `DiffHunk` and `DiffStats` interfaces made non-exported to eliminate conceptual overlap with `types.ts`.
- **Code quality pass**: comprehensive review of error handling patterns across the codebase; all `catch(e)` handlers verified to use proper error narrowing.

# Changelog

## 0.1.20 - 2026-06-19

### Fixed
- **New messages jump button redesign**: replaced accent-colored rectangular button with a subtle floating pill shape, arrow-down icon, hover effects, and slide-up entrance animation.
- **Toolbar send button**: migrated from text labels to Obsidian `setIcon` (`send`/`square`) with `.mod-stop` toggle.

### Changed
- **Session button icon**: replaced "···" text with Obsidian `history` icon.
- **New session button**: migrated text label to `plus-circle` icon.

## 0.1.19 - 2026-06-19

### Changed
- **Claudian-inspired visual overhaul**: transparent tool call and thinking block headers (removed card backgrounds), tree-branch style border-inline-start on expanded content, muted user message colors.
- **Auto-collapse on completion**: thinking blocks and tool call cards now auto-collapse when streaming completes or fails, matching Claudian's post-stream behavior.
- **Width-constrained expanded content**: expanded tool/thinking bodies are constrained by CSS `max-width` for readability, with no inline `maxHeight`/`overflowY` in JS.
- **Real-time thinking markdown rendering**: `scheduleThinkingRender()` renders live thinking content through Obsidian's `MarkdownRenderer` via RAF throttle instead of raw text.

## 0.1.18 - 2026-06-19

### Added
- **Unified collapsible component**: `setupCollapsible()` with scroll-into-view on expand, `onExpand` callback, and `scrollOnExpand` option — replaces 4 independent toggle implementations.
- **Independent DiffRenderer**: `splitIntoHunks()` smart hunk grouping, `computeDiffStats()`, new-file creation truncation at 20 lines, and `parseDiffLines()` for structured diff data.
- **Dedicated WriteEditRenderer**: separate rendering for Write/Edit tool calls with diff previews, `+N -M` stats, and collapsible diff content.
- **Thinking block content truncation**: expanded thinking blocks show first 30 lines with "Show all ›" button for full content, `max-height: 400px` with scroll for long content.
- **Tool call body scrolling**: expanded tool call cards get `max-height: 400px` + `overflow-y: auto` to handle long bash output or diff content.

### Changed
- **ToolCallRenderer** — refactored with `renderLinesExpanded()` truncation pattern, `renderToolBodyContent()` content-type dispatch, and Write/Edit delegation to `writeEditRenderer.ts`.
- **renderer.ts** — three-layer render frame scheduling (text/thinking/toolOutput) using `requestAnimationFrame` + Promise pipelines, replacing `setTimeout`-based throttling. Adds `flushTextRender()`, `flushThinkingRender()`, `scheduleToolRender()`.
- **StreamController** — calls `flushThinkingRender()`/`flushTextRender()` on content type transitions (agent ↔ thought) for consistent rendering.

## 0.1.17 - 2026-06-19

### Added
- **Structured message rendering system**: `ContentBlock` model, `Collapsible` component, `ThinkingBlockRenderer` with live timer, `ToolCallRenderer` with status indicators, `DiffRenderer` for unified diff display.
- **Tool call buffering**: `pendingToolBuffer` in `StreamController` prevents mid-stream tool call interleaving during streaming responses.

### Changed
- **renderer.ts** — new `renderStructuredMessage()`, `renderInline()`, `renderCompactBoundary()`, `renderSubagentBlock()`, `addTextCopyButton()`, `formatDuration()` methods. Full backward compatibility maintained.
- **CSS** — ~255 lines of new styles for structured blocks, thinking block animations, tool status states, compact boundary, response footer, and interrupt badge.

### Fixed
- `CLIENT_VERSION` in `acp.ts` now correctly matches `package.json` version (previous value `0.1.15` was stale).

## 0.1.16 - 2026-06-16

### Changed
- Complete rename from CoPilot to Co-Ober across all files, identifiers, and remote repository.

## 0.1.15 - 2026-06-15

### Added
- **Multi-source command architecture**: `CommandSource` abstraction with pluggable sources (builtin, ACP, file, skill, MCP).
- **File-based commands**: `.opencode/commands/*.md` auto-discovery with YAML frontmatter parsing and vault file watching.
- **Template expansion**: `$ARGUMENTS`, `$1`-`$9` placeholder substitution for file commands.
- **New builtin commands**: `/add-dir [path]`, `/resume`, `/fork`, `/model <id>`, `/mode <id>` with capability gating via `enabled()`.
- **Enhanced autocomplete**: two-row rendering (argument hint in grey italic + description), color-coded source badges (Builtin/ACP/Custom/MCP/Skill).
- **Command visibility gating**: `enabled()` function on `SlashCommandDef` filters commands dynamically based on provider capabilities.
- `commandRegistry.subscribe()` for live UI refresh on command list changes.
- `commandRegistry.getGrouped()` for category-grouped access.
- FrontmatterParser: supports scalars, inline arrays, block arrays, and nested mappings in YAML frontmatter.

### Fixed
- `/compact` now actually sends the compact request to the ACP agent instead of silently doing nothing.

### Changed
- `SlashCommandDef.type` renamed to `source` with expanded `CommandSourceType` union (`builtin` | `acp` | `file` | `mcp` | `skill`).
- Autocomplete items use flex-column layout with `.ac-row` containers for multi-line support.
- Badge CSS classes: `.ac-badge-builtin`, `.ac-badge-acp`, `.ac-badge-custom`, `.ac-badge-mcp`, `.ac-badge-skill`.

## 0.1.14 - 2026-06-14

### Fixed
- **@mention popup simplified**: each item shows only `@filename` with optional ✓ badge. Removed path prefix and secondary description text.
- CSS layout: replaced `space-between` with `gap`, added `flex: 1` to `.ac-label` so filename fills the row.
- Removed `.ac-desc` CSS (no longer used by @ items).

## 0.1.13 - 2026-06-14

### Improved
- **@ mention popup**: files sorted by last modified time (most recent first), grouped by folder, selected notes marked with ✓ badge.
- **Popover layout**: dropdown width matches input area, filename no longer hidden by long path, badge pushed to the right.

## 0.1.12 - 2026-06-14

### Fixed
- **CSS class name mismatch**: dropdown container used class `co-ober-autocomplete` but all CSS rules expected `co-ober-ac-dropdown`. The autocomplete popup (`/` and `@`) was completely unstyled and invisible.
- **Dropdown attached to `document.body`**: changed to mount inside the view's `inputAreaEl` container for correct positioning within Obsidian's iframe layout.
- **Missing CSS styles**: added rules for `ac-badge`, `ac-header`, `ac-separator`, and `<mark>` highlight in the dropdown.

## 0.1.11 - 2026-06-14

### Fixed (critical)
- **Autocomplete popover completely invisible**: `open()` method called `close()` (which nulls `dropdownEl`) but never re-created the dropdown DOM element. `render()` silently returned on the `if (!this.dropdownEl) return;` guard, causing both `/` slash commands and `@` file mentions to be completely non-functional.

## 0.1.10 - 2026-06-14

### Fixed
- Slash command popover not displaying: replaced dynamic `import()` with static import (esbuild bundle incompatibility).
- `/` character eaten on input: same root cause — popover now opens correctly, and `/<trigger>` is properly inserted on selection.
- @mention chip now shows `@name (path)` format for disambiguation.
- Popover search highlighting: matching keywords wrapped in `<mark>` in @mention mode.
- Note content caching: same file not re-read across messages in the same session.
- ContextMention constructor updated from `Vault` to `App` for future metadata cache access.

## 0.1.9 - 2026-06-14

### Features
- Slash command system overhaul: `CommandRegistry` with builtin + ACP proxy commands.
- New builtin slash commands: `/new` (new session), `/clear` (clear display), `/help` (show all commands).
- ACP `available_commands_update` notifications now sync into the registry automatically.
- Popover UI (`Autocomplete`) upgraded with category grouping, type badges (ACP/Builtin), and improved keyboard navigation.
- Command alias support (`/summarize` → `/compact`).
- `addSystemMessage()` renderer method for richly formatted system messages.
- Slash command interception in `send()` — builtin commands execute locally without ACP round-trip.

### Housekeeping
- Remove dead `isBuiltInCommand()` from executor (replaced by `CommandRegistry.isBuiltin()`).
- Import cleanup: inline `import('../types')` replaced with proper top-level imports.

## 0.1.8 - 2026-06-14

### Refactoring
- Comprehensive architecture review: unified types, security hardening, memory lifecycle management.
- Extract Windows command resolution to dedicated utility module.
- safeClone polyfill for structuredClone cross-environment compatibility.
- SyncEngine path security: deduplicate redundant isSafePath check.
- TerminalManager: robust command parsing with proper token splitting, stderr capture, output truncation.

### Fixed
- Cancel race condition: send RPC before clearing local streaming state.
- PermissionBanner show() semantics: eliminate fragile double-assignment pattern.
- disposeConnection ordering: notify onClose before clearing transport.
- methodCache cleared on reconnect to avoid stale method names.
- console.debug usage_update noise: conditional on DEBUG_CO_OBER env var.
- Remove duplicate sessionInfo parsing in extractSessionSnapshot.
- Remove dead code AcpClient.requestPermission (unused, handled by AcpRequestHandler).
- SessionUpdateNormalizer memory leak: add trimMap eviction (200/100 entry caps).
- ChatInput: add dispose() with global event listener cleanup + locale unsubscribe.
- InputToolbar: add dispose() with locale unsubscribe.
- PermissionBanner: add dispose() with locale unsubscribe.
- CoOberView.onClose: integrate input/toolbar/permissionBanner dispose().
- pruneSessions deferred via setTimeout to avoid blocking save IO.

### Housekeeping
- Unified UsageInfo type definition, removed 3 duplicate interfaces.
- OpencodeClient.permissionMode typed as PermissionLevel (was string).
- AgentRuntime.permissionMode explicitly typed.
- Inline import('../types') references replaced with top-level imports.

## 0.1.7 - 2026-06-12

### Refactoring
- Strip `injection.ts` to just `BASE_IDENTITY` and `buildSystemPrompt()` — agent now explores vault autonomously using its own tools rather than relying on programmatic context injection.
- Remove intelligent sync classification (`intelligentFolder`) and its related UI/Settings/i18n.
- Remove conversational memory system (`UserPreferenceStore`).

### Fixed
- Restore `@mention` notes content injection that was broken during refactoring.

### Documentation
- Replace BRAT and manual installation with Obsidian Community Plugins marketplace.
- Remove ACP capability matrix from README.
- Polish README tone and formatting.

### Features
- Enhanced agent identity: Co-Ober now understands Obsidian's bi-directional linking, graph view, backlinks, tags, daily notes, and templates — speaks naturally as an Obsidian-native AI partner.
- Plugin detection: automatically detects enabled Obsidian plugins (Dataview, Tasks, Calendar, Templater, Kanban) and injects awareness into agent system prompt.
- Workflow fluency: agent scans vault structure (Daily/Journal, Templates, Projects folders) and adapts responses based on user's organizational patterns.
- Contextual awareness: agent knows which heading/section the user's cursor is in and whether they're inside a task list, bullet list, blockquote, table, or code block.
- Conversational memory: learns user's writing style and preferences over time, adapting response tone accordingly.
- Intelligent sync placement: new "Intelligent Placement" toggle on sync rules routes AI output to smart folders (Meetings, Tasks, Journal, Learning) based on content analysis.

## 0.1.5 - 2026-06-11

### Fixed
- Pass Obsidian plugin review v2: replace bare `document` fallback with `activeDocument` global for popout window compatibility (5 files).
- Eliminate remaining control-character regex by using charCodeAt loop instead of regex literal.

## 0.1.4 - 2026-06-11

### Fixed
- Pass Obsidian plugin review: replace `style.setProperty` with `setCssProps`, split control-character regex, fix `async onclick` promise returns, suppress `display` deprecation with compatibility note.
- Popout window compatibility: replace bare `document`/`clearTimeout`/`setTimeout`/`requestAnimationFrame` with `window.*` / `ownerDocument` across all modules.
- Type safety: add type guards for unsafe any access, wrap non-Error rejections, remove unnecessary type assertions.
- Command ID/name no longer include plugin name.
- Plugin now passes Obsidian community plugin review checklist (no Errors, no Warnings — only one Recommendation for `display` deprecation held back by minAppVersion 1.8.0).

## 0.1.3 - 2026-06-10

### Features
- Tool call blocks now show icons per tool kind (read/edit/write/execute/glob/grep/search).
- Tool call headers now display the filename being operated on, extracted from ACP locations or rawInput.

### Fixed
- `SyncEngine.isTFile` uses `instanceof TFile` instead of duck-type property checks.
- Add `setIcon` to obsidian mock and fix test expectations for updated `addToolCall`/`updateToolCall` signatures.

## 0.1.2 - 2026-06-09

### Features
- Tool call blocks now display the filename being operated on (read/write/edit) in the header, extracted from ACP `locations` or `rawInput.file_path`.

### Fixed
- Windows command injection: `quoteCmdArg` now escapes backslashes before quotes, preventing cmd.exe quote boundary bypass.
- `AcpSubprocess.shutdown` now sends SIGKILL after timeout (previously only resolved the promise) and sets `closed = true` to prevent spurious close-listener calls.
- Inverted condition in `CoOberViewController.send()` — `inlineEditPanel.clearState()` was called when there was no pending edit instead of when there was one.
- `stopGeneration` now clears the prompt queue before aborting, preventing queued messages from resuming after the user requests a stop.
- `onClose` now awaits `stopGeneration()` to cancel in-flight generation and prevent post-destroy DOM/timer writes.
- SVG arc-meter clip-path ID is now unique per view instance, fixing clipping when multiple Co-Ober leaves are open simultaneously.
- `SyncEngine.isTFile` uses `instanceof TFile` instead of duck-type property checks.
- Sync engine validates that resolved note paths do not contain path traversal sequences before writing.

## 0.1.1 - 2026-06-07

### Security
- Add ALLOWED_COMMANDS whitelist to TerminalManager to prevent arbitrary command execution.
- Remove unconditional shell:true (only .cmd/.bat use shell on Windows).
- Terminate terminal processes on ACP disconnect.
- Show MCP environment variable security warning in settings UI.

### Features
- Prompt input is always usable during streaming. Messages typed while the agent is responding are queued and sent automatically when the current turn finishes.
- Tab / Shift+Tab cycles agent modes forward and backward.
- Stop button interrupts the current response and drains queued prompts.

### Refactoring
- Extract AcpRequestHandler from AcpClient (FS, terminal, and permission request logic). AcpClient reduced from ~920 to ~690 lines.
- Replace setInterval polling in TerminalManager.waitForExit with process exit event.
- Add genId guard to prevent stale finally blocks from corrupting state during stop+drain.

### Fixed
- closeSession no longer silently swallows errors.
- Add session race condition guard in send() after syncRuntimeSession.
- Send errors now correctly set streaming state to false.

## 0.1.0 - 2026-05-31

First public beta release.

### Changed
- Context arc meter moved to right of "Co-Ober" title in header.
- All slash commands now route through ACP agent — removed local `compact` interception.
- `isBuiltInCommand()` always returns false; no commands are handled locally.
- Toolbar redesigned as single row: model selector, mode cycle button, effort dropdown, permission cycle, send button.
- Context arc meter moved to header bar, freeing toolbar space.
- Mode selector changed from segmented button group to single click-to-cycle button.
- Permission toggle uses color-coded border (green/amber/orange) instead of dot indicator.
- Sending indicator merged into send button (button turns red "Stop" during generation).

## 0.0.41 - 2026-05-30

### Changed
- Context meter redesigned as semicircle arc gauge — SVG arc fills from left to right, percentage text on right.
- Effort selector now uses custom hover dropdown instead of native `<select>`, matching model selector style.
- All toolbar elements now use consistent custom UI (no native form controls).

## 0.0.40 - 2026-05-30

### Fixed
- Fix token usage tracking: restore `response.usage` handling from prompt response (primary token source).
- Fix token usage tracking: `usage_update` notification now merges with existing response usage instead of overwriting.
- Fix toolbar spacing: consistent 6px gap between elements, model selector flex fills, permission toggle auto-pushes right.

## 0.0.39 - 2026-05-30

### Fixed
- Fix session stability: `send()` no longer shows error UI when connection is already lost.
- Fix session stability: reconnect now shows a recovery prompt instead of silently losing the in-flight message.
- Fix session stability: `ensureRuntimeSession` falls back to creating a new session when sync fails.
- Fix abort race condition in `AcpJsonRpcTransport` — abort handler checks if request is still pending.
- Fix token usage tracking: enhanced `parseSessionUpdate` field fallback for different server versions.
- Remove dead `response.usage` code path (opencode returns empty object from prompt).

### Changed
- Toolbar split into two rows: top row (model selector + mode buttons), bottom row (effort + context meter + permission + send).
- Idle timeout now disabled when set to 0 (short-circuit instead of wrapping in timeout logic).
- Added debug logging for `usage_update` notifications.

## 0.0.38 - 2026-05-30

### Added
- Add a compact "liquid glass" context usage meter in the toolbar.
- Context meter shows percentage, warning/critical states, and token details on hover.

### Changed
- Usage updates now refresh the toolbar meter during streaming and after final response usage is received.

## 0.0.37 - 2026-05-30

### Changed
- Agent mode selector now uses segmented button group instead of native `<select>`.
- Added permission mode toggle in toolbar (safe → plan → yolo cycle).
- Permission toggle shows color indicator (green/yellow/orange) for current mode.

## 0.0.36 - 2026-05-30

### Fixed
- Fix model list not loading on initial connection - now syncs saved session before loading toolbar options.
- Fix model list not loading after reconnect - clears session state on disconnect so reconnect forces reload.
- Fix abort handler in `AcpJsonRpcTransport` to properly reject with `AcpAbortError`.

### Changed
- Model selector now uses custom hover dropdown instead of native `<select>`, with provider grouping.
- Idle timeout is now configurable via Settings (default 300000ms, 0 to disable).
- `disposeConnection()` now clears session state (sessionId, stream handler, normalizer).

## 0.0.35 - 2026-05-30

### Fixed
- Fix toolbar options not loading after reconnect - now calls `loadToolbarOptions()` after connection establishment.
- Fix abort handler in `AcpJsonRpcTransport` to not prematurely reject with `AcpAbortError`, allowing proper request cleanup.

### Changed
- Prompt requests now use transport-level timeout of 0 (disabled), matching claudian's `ACP_PROMPT_TURN_TIMEOUT_MS` approach. The idle timeout in `AgentRuntime` handles cancellation instead.
- `AgentRuntime.sendMessage` now throws `AcpTimeoutError` instead of generic error for timeout, providing better error classification.

## 0.0.34 - 2026-05-28

### Fixed
- Fix session output interruption by removing unnecessary server cancel request during abort.
- Fix error banner showing on user-initiated cancellation (AcpAbortError now properly suppressed).
- Fix plugin not reconnecting when view opens - now always attempts connection on view open.

### Changed
- `stopGeneration()` now only calls `abort()` without sending `session/cancel` to server.
- `AcpJsonRpcTransport` no longer sends cancel request when abort signal is triggered.
- View now always tries to connect when opened, regardless of `autoConnect` setting.

## 0.0.33 - 2026-05-28

### Added
- Enhance `PermissionBanner` with tool kind badge, location list, and input parameter summary.
- Add CSS styles for new permission UI elements (kind badge, locations, input summary).

### Changed
- Permission banner now shows: tool type badge (e.g., READ, EDIT, EXECUTE), file paths (up to 3), and key input parameters.
- Improved permission banner layout with better visual hierarchy.

## 0.0.32 - 2026-05-28

### Added
- Add `writeTextFile` method to `FsDelegate` for vault file writing with boundary protection.
- Register `fs/write_text_file` handler for OpenCode agent to write vault files.
- Add `readonly` option to `FsCapabilityMode` for read-only file system access.
- Update `clientCapabilities.fs.writeTextFile` based on FS capability mode.

### Changed
- FS capability mode now supports three options: `enabled` (read/write), `readonly` (read only), `disabled` (no access).
- Default FS capability mode is `enabled` (read & write).

## 0.0.31 - 2026-05-28

### Added
- Add `TerminalManager` class for terminal process lifecycle management (create, output, kill, release, waitForExit).
- Register 5 terminal handlers: `terminal/create`, `terminal/output`, `terminal/kill`, `terminal/release`, `terminal/wait_for_exit`.
- Declare `clientCapabilities.terminal = true` in ACP initialize request.
- Add `TerminalCapabilityMode` setting (enabled/disabled) to control terminal access.
- Add terminal timeout setting (default 30000ms) and max output buffer size setting (default 100000 bytes).
- Add `setTerminalCapabilityMode()` method to `AcpClient` and `AgentRuntime`.
- Add unit tests for `TerminalManager` lifecycle operations.

### Security
- Terminal commands run in vault directory by default.
- Output buffer limited to prevent OOM.
- Process timeout prevents hanging commands.

## 0.0.30 - 2026-05-28

### Added
- Add `FsDelegate` class for vault-boundary file system access with path traversal protection.
- Register `fs/read_text_file` handler for OpenCode agent to read vault files.
- Declare `clientCapabilities.fs` in ACP initialize request.
- Add `FsCapabilityMode` setting (enabled/disabled) to control file system access.
- Add `setFsCapabilityMode()` method to `AcpClient` and `AgentRuntime`.
- Add unit tests for `FsDelegate` vault boundary checks and file reading.

### Changed
- Agent can now read files within the vault boundary when FS capability is enabled.
- File size limited by `maxNoteSize` setting (default 8000 bytes).
- Files exceeding the limit are truncated with `... [truncated]` suffix.

## 0.0.29 - 2026-05-28

### Added
- Add `AbortSignal` support to `AcpJsonRpcTransport.request()` for request-level cancellation.
- Add `AcpAbortError` error type for aborted requests.
- Add `abort()` method to `AcpClient` and `AgentRuntime` for external cancellation.
- Add error classification UI with retry/restart buttons for timeout and process exit errors.
- Add `addError()` action parameter to `ChatRenderer` for inline error actions.

### Changed
- `AcpClient.sendMessage()` now uses `AbortController` for cancellation.
- `stopGeneration()` calls `abort()` to immediately cancel in-flight JSON-RPC requests.
- Removed DOM references from `ChatState` (`currentTextEl`, `ThinkingState.el`, `pendingTools[].parentEl`, `toolCallEls`, `planEl`).
- Error messages now show contextual action buttons (retry for timeout, restart for process exit).

### Tested
- Updated tests for `ChatState`, `AcpClient`, and `CoOberViewController` to reflect new abort behavior.

## 0.0.28 - 2026-05-26

### Changed
- Extracted business/session/streaming logic from `CoOberView` into new `CoOberViewController` class.
- View now handles only DOM creation, UI event binding, and Obsidian lifecycle hooks.
- Controller owns connection management, session lifecycle, message sending, toolbar sync, and state.
- View delegates all operations to controller via `ControllerDeps` and `ControllerCallbacks` interfaces.

## 0.0.27 - 2026-05-26

### Fixed
- Eliminated all 33 ESLint `@typescript-eslint/no-explicit-any` warnings across codebase.
- Replaced `as any` casts in `buildMcpServers()` with proper `McpServerConfig` discriminated union narrowing.
- Replaced `as any` casts in `addMcpServerBlock()` with `Extract<McpServerConfig, ...>` type assertions.
- Replaced `Object.assign` + `delete` pattern in MCP type switching with direct array entry replacement.
- Used `Record<string, unknown>[]` instead of `any[]` in `parseSessionUpdate` content mapping.

## 0.0.26 - 2026-05-26

### Added
- Introduce `SessionUpdateNormalizer` in client to encapsulate and normalize session updates and chunks into `NormalizedUpdate` states.
- Offload chunk aggregation logic from `StreamController` to client-side.

## 0.0.25 - 2026-05-26

### Tooling
- Add ESLint, Prettier, simple-git-hooks, and lint-staged configuration for conservative TypeScript linting and formatting.
- Ignore generated build artifacts, release output, and local QA vault data.
- Add a non-blocking CI lint step.

### Documentation
- Add English and Chinese ACP capability matrices to the README.

### Known issues
- `npm run lint` currently reports 32 warnings in existing source files.

## 0.0.24 - 2026-05-26

### Added
- Add typed ACP agent capabilities covering session, prompt, MCP, and authentication metadata.
- Show OpenCode authentication methods in the welcome view with terminal login guidance when reported by the agent.

### Changed
- Drive session dropdown controls, image drag-and-drop, and MCP type options from negotiated agent capabilities.
- Disable unsupported session and MCP actions with localized explanatory labels.

### Tested
- Add unit coverage for welcome auth method rendering, session capability combinations, image drop rejection, and MCP type disabling.

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
- Extract WelcomeView component from CoOberView for welcome page rendering and connection status display.
- Add event-driven i18n locale change mechanism (`onLocaleChange`) so child components self-manage locale updates instead of relying on parent imperative calls.
- Add unit tests for DragDropManager (6 tests), PermissionBanner (3 tests), InlineEditPanel (5 tests), and Mutex (3 tests).

### Changed
- ChatInput, InputToolbar, ChatRenderer, InlineEditPanel, DragDropManager, PermissionBanner, and WelcomeView register their own locale change listeners in constructors.
- Simplify CoOberView.refreshLocale() by removing manual child component locale update calls.

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
- Deduplicate Co-Ober side leaves during plugin reload/open stress scenarios.
- Make Co-Ober view cleanup safe before the view finishes opening.

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
- Apply saved English/Chinese language settings on plugin startup and refresh both the plugin settings tab and open Co-Ober views immediately after changing language in Settings.
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
