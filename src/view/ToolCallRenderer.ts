/**
 * Tool call renderer — renders individual tool calls as collapsible cards
 * with status indicators and tool-specific content previews.
 *
 * Standard layout: [icon] [tool-name] [file/command summary] [status icon]
 * Status: running(rotating) / completed(check) / error(x) / blocked(shield)
 *
 * Uses unified collapsible pattern and DiffRenderer for hunk-based diff.
 *
 * @since Phase 1 (refactored)
 */

import { setIcon } from 'obsidian';
import type { ToolCallContent } from '../types';
import { setupCollapsible, type CollapsibleState } from './collapsible';
import {
  parseDiffLines,
  renderDiffContent,
} from './DiffRenderer';
import { createWriteEditBlock, updateWriteEditContent, type WriteEditState } from './writeEditRenderer';

// ---- Constants ----

const TOOL_ICONS: Record<string, string> = {
  read: 'file-text',
  edit: 'file-pen',
  write: 'file-plus',
  execute: 'terminal',
  search: 'search',
  think: 'brain',
  fetch: 'globe',
  delete: 'trash',
  move: 'folder-move',
  switch_mode: 'repeat',
  other: 'settings',
};

// ---- Tool Call State ----

export interface ToolCallState {
  wrapper: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  iconEl: HTMLElement;
  kindEl: HTMLElement;
  summaryEl: HTMLElement;
  statusEl: HTMLElement;
  collapsibleState: CollapsibleState;
  /** Non-null when the tool is a write/edit type, for dedicated rendering */
  writeEditState?: WriteEditState;
}

// ---- Tool Display Helpers ----

/** Map tool kind to a human-readable display name. */
export function getToolDisplayName(kind: string): string {
  const map: Record<string, string> = {
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    execute: 'Execute',
    search: 'Search',
    think: 'Think',
    fetch: 'Fetch',
    delete: 'Delete',
    move: 'Move',
    switch_mode: 'Switch Mode',
    plan: 'Plan',
    bash: 'Bash',
    grep: 'Grep',
    ls: 'List',
    apply_patch: 'Apply Patch',
    web_search: 'Web Search',
    file_search: 'File Search',
  };
  return map[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Extract a one-line summary of a tool call from its input. */
export function getToolSummary(
  kind: string,
  input?: Record<string, unknown>,
  locations?: { path: string }[],
): string {
  const locs = locations ?? [];
  const rawInput = input ?? {};

  // bash: show command
  if (kind === 'bash' || kind === 'execute') {
    const cmd = (rawInput.command as string) ?? '';
    return truncateText(cmd, 80);
  }

  // read / edit / write: show file path
  if (kind === 'read' || kind === 'edit' || kind === 'write') {
    const filePath = rawPathFromInput(rawInput, locs);
    return filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : '';
  }

  // grep: show pattern
  if (kind === 'grep' || kind === 'search') {
    const pattern = (rawInput.pattern as string) ?? '';
    return truncateText(pattern, 60);
  }

  // apply_patch: show target
  if (kind === 'apply_patch') {
    const path = (rawInput.path as string) ?? '';
    return path ? (path.split(/[\\/]/).pop() ?? path) : '';
  }

  // web_search/fetch: show query/url
  if (kind === 'web_search' || kind === 'fetch') {
    const query = (rawInput.q as string) ?? (rawInput.query as string) ?? (rawInput.url as string) ?? '';
    return truncateText(query, 60);
  }

  // file_search: show query
  if (kind === 'file_search') {
    const query = (rawInput.query as string) ?? '';
    return truncateText(query, 60);
  }

  // ls: show path
  if (kind === 'ls') {
    const path = (rawInput.path as string) ?? '';
    return path || '';
  }

  // Default: show first location path or input key
  if (locs[0]?.path) return locs[0].path.split(/[\\/]/).pop() ?? '';
  const firstValue = Object.values(rawInput).find((v) => typeof v === 'string');
  if (firstValue) {
    return truncateText(firstValue as string, 60);
  }
  return '';
}

// ---- Tool Rendering ----

/**
 * Create a tool call card element.
 */
export function createToolCallElement(
  parentEl: HTMLElement,
  toolCallId: string,
  kind: string,
  title: string,
  input?: Record<string, unknown>,
  locations?: { path: string }[],
): ToolCallState {
  // Write/Edit tools get their own dedicated renderer
  if (kind === 'write' || kind === 'edit') {
    return createWriteEditToolCall(parentEl, toolCallId, kind, title, input, locations);
  }

  const wrapper = parentEl.createDiv({ cls: 'co-ober-tool-call' });
  wrapper.dataset.toolId = toolCallId;

  if (kind === 'bash' || kind === 'execute') {
    wrapper.addClass('co-ober-tool-call-bash');
  }

  const header = wrapper.createDiv({ cls: 'co-ober-tool-call-header' });
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');

  const iconEl = header.createSpan({ cls: 'tc-icon' });
  setIcon(iconEl, TOOL_ICONS[kind] || 'tool');

  const kindEl = header.createSpan({ cls: 'tc-kind', text: getToolDisplayName(kind) });

  const summary = getToolSummary(kind, input, locations);
  const summaryEl = header.createSpan({ cls: 'tc-file', text: summary });

  const statusEl = header.createSpan({ cls: 'tc-stat', text: '…' });

  const body = wrapper.createDiv({ cls: 'co-ober-tool-call-body' });

  const collapsibleState: CollapsibleState = { isExpanded: false };
  setupCollapsible(wrapper, header, body, collapsibleState, {
    initiallyExpanded: false,
    baseAriaLabel: `${title}: ${summary || kind}`,
    scrollOnExpand: true,
    onExpand: () => {
      // Add scrollable body for long content on expand
      body.style.maxHeight = '400px';
      body.style.overflowY = 'auto';
    },
    onToggle: (expanded) => {
      if (!expanded) {
        // Remove scroll constraints on collapse
        body.style.maxHeight = '';
        body.style.overflowY = '';
      }
    },
  });

  return { wrapper, header, body, iconEl, kindEl, summaryEl, statusEl, collapsibleState };
}

/**
 * Create a write/edit tool call with dedicated diff rendering.
 */
function createWriteEditToolCall(
  parentEl: HTMLElement,
  toolCallId: string,
  kind: string,
  _title: string,
  input?: Record<string, unknown>,
  locations?: { path: string }[],
): ToolCallState {
  const bw = createWriteEditBlock(
    parentEl, toolCallId,
    getToolDisplayName(kind),
    getToolSummary(kind, input, locations),
  );

  const { wrapper, header, body } = bw;
  const iconEl = header.querySelector('.tc-icon') as HTMLElement;
  const kindEl = header.querySelector('.tc-kind') as HTMLElement;
  const summaryEl = header.querySelector('.tc-file') as HTMLElement;
  const statusEl = header.querySelector('.tc-stat') as HTMLElement;

  const collapsibleState: CollapsibleState = { isExpanded: false };

  return {
    wrapper, header, body, iconEl, kindEl, summaryEl, statusEl,
    collapsibleState,
    writeEditState: bw,
  };
}

/**
 * Update a tool call's status and optionally its content/body.
 */
export function updateToolCallElement(
  state: ToolCallState,
  status: string,
  kind: string,
  rawOutput?: Record<string, unknown>,
  content?: ToolCallContent[],
  rawInput?: Record<string, unknown>,
  locations?: { path: string }[],
  _toolKind?: string,
): void {
  const { wrapper, body, iconEl, statusEl, summaryEl } = state;

  // Re-set icon if kind changed
  setIcon(iconEl, TOOL_ICONS[kind] || 'tool');
  state.kindEl.textContent = getToolDisplayName(kind);

  // Update summary if new input available
  if (rawInput) {
    const newSummary = getToolSummary(kind, rawInput, locations);
    if (newSummary) summaryEl.textContent = newSummary;
  }

  // Status classes
  wrapper.classList.remove('status-running', 'status-completed', 'status-error', 'status-blocked');
  statusEl.className = 'tc-stat';

  // Handle write/edit tools through dedicated renderer
  if ((kind === 'write' || kind === 'edit') && content) {
    for (const item of content) {
      if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
        if (state.writeEditState) {
          updateWriteEditContent(state.writeEditState, item.path, item.oldText, item.newText);
        } else {
          // Fallback: inline diff via DiffRenderer
          body.empty();
          const diffLines = parseDiffLines(item.oldText, item.newText);
          renderDiffContent(body, diffLines);
        }
      }
    }
  }

  if (status === 'in_progress') {
    wrapper.classList.add('status-running');
    statusEl.textContent = '…';
  } else if (status === 'completed') {
    wrapper.classList.add('status-completed');
    statusEl.textContent = '✓';
    statusEl.classList.add('tc-stat-done');

    // Render body content for non-write/edit tools
    if (kind !== 'write' && kind !== 'edit' && content && content.length > 0) {
      renderToolBodyContent(body, kind, content, rawOutput);
    }
  } else if (status === 'failed') {
    wrapper.classList.add('status-error');
    statusEl.textContent = '✗';
    statusEl.classList.add('tc-stat-fail');
    if (rawOutput) {
      body.empty();
      body.createDiv({ text: JSON.stringify(rawOutput, null, 2) });
    }
  } else {
    // pending
    statusEl.textContent = '…';
  }
}

/**
 * Render tool body content — dispatch by content types.
 */
function renderToolBodyContent(
  body: HTMLElement,
  _kind: string,
  content: ToolCallContent[],
  _rawOutput?: Record<string, unknown>,
): void {
  let hasDiffContent = false;

  for (const item of content) {
    if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
      const diffLines = parseDiffLines(item.oldText, item.newText);
      renderDiffContent(body, diffLines);
      hasDiffContent = true;
    } else if (item.type === 'content' && item.content?.type === 'text' && item.content.text) {
      body.createDiv({ text: item.content.text });
    }
  }

  if (!hasDiffContent) {
    // Render raw output as truncated text
    const outputText = JSON.stringify(_rawOutput, null, 2);
    if (outputText !== '{}' && outputText !== 'undefined') {
      body.createDiv({ text: renderTruncatedText(outputText, 20) });
    }
  }
}

// ---- Generic Rendering Utilities ----

/**
 * Render lines with truncation — the unified "renderLinesExpanded" pattern.
 * Shows up to `maxLines` lines, then "X more lines" truncation.
 */
export function renderLinesExpanded(
  container: HTMLElement,
  result: string,
  maxLines: number,
  hoverable = false,
): void {
  const lines = result.split(/\r?\n/);
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const linesEl = container.createDiv({ cls: 'co-ober-tool-lines' });
  for (const line of displayLines) {
    const lineEl = linesEl.createDiv({ cls: 'co-ober-tool-line' });
    if (hoverable) lineEl.addClass('hoverable');
    lineEl.setText(line || ' ');
  }

  if (truncated) {
    linesEl.createDiv({
      cls: 'co-ober-tool-truncated',
      text: `... ${lines.length - maxLines} more lines`,
    });
  }
}

/**
 * Truncate text to a maximum number of lines, appending "X more lines".
 */
export function renderTruncatedText(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n... ${lines.length - maxLines} more lines`;
}

// ---- Internal Helpers ----

function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function rawPathFromInput(
  rawInput: Record<string, unknown>,
  locs: { path: string }[],
): string {
  return (
    locs[0]?.path ??
    (rawInput.file_path as string) ??
    (rawInput.filePath as string) ??
    (rawInput.path as string) ??
    ''
  );
}
