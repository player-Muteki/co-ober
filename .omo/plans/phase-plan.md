# Phase Plan: Test → i18n → Inline Edit

## Phase 1: Unit Tests
**Goal**: Set up test infrastructure + cover critical modules
- Tasks:
  - Install vitest + configure
  - Write tests for `src/client/acp.ts` — `parseUpdate()`, `parseLine()`, `applySessionSnapshot()`
  - Write tests for `src/sync/templates.ts` — filename template rendering, path pattern matching
  - Write tests for `src/utils/vault.ts` — path utilities
  - Write tests for `src/commands/executor.ts` — slash command parsing
- QA: `npx vitest run` passes, coverage ≥70% on tested modules

## Phase 2: i18n
**Goal**: Add English/Chinese locale system
- Tasks:
  - Create `src/i18n/` with `en.ts`, `zh.ts`, `index.ts`
  - Extract all hardcoded UI strings from view/ chat/ settings/
  - Wire locale into plugin settings
- QA: Switch language in settings, verify all UI text changes

## Phase 3: Inline Edit
**Goal**: Select note text → AI edit with diff preview
- Tasks:
  - Add context menu item on text selection in markdown editor
  - Build inline edit modal/panel with before/after diff
  - Wire ACP prompt for code/text editing
  - Apply edit on approval
- Complex: needs Obsidian editor API, custom UI, ACP integration
