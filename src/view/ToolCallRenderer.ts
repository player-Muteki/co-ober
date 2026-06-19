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
import { setupCollapsible, collapseElement, type CollapsibleState } from './collapsible';
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
  apply_patch: 'wand',
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

  const { wrapper, header, body, collapsibleState } = bw;
  const iconEl = header.querySelector('.tc-icon') as HTMLElement;
  const kindEl = header.querySelector('.tc-kind') as HTMLElement;
  const summaryEl = header.querySelector('.tc-file') as HTMLElement;
  const statusEl = header.querySelector('.tc-stat') as HTMLElement;

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
    statusEl.empty();
    setIcon(statusEl, 'loader');
    statusEl.addClass('spin');
  } else if (status === 'completed') {
    wrapper.classList.add('status-completed');
    statusEl.empty();
    setIcon(statusEl, 'check');
    statusEl.addClass('tc-stat-done');

    // Render body content for non-write/edit tools
    if (kind !== 'write' && kind !== 'edit' && content && content.length > 0) {
      renderToolBodyContent(body, kind, content, rawOutput);
    }

    // Auto-collapse on completion
    collapseElement(wrapper, state.header, state.collapsibleState);
  } else if (status === 'failed') {
    wrapper.classList.add('status-error');
    statusEl.empty();
    setIcon(statusEl, 'x');
    statusEl.addClass('tc-stat-fail');
    if (rawOutput) {
      body.empty();
      body.createDiv({ text: JSON.stringify(rawOutput, null, 2) });
    }
    // Auto-collapse on failure as well
    collapseElement(wrapper, state.header, state.collapsibleState);
  } else {
    // pending
    statusEl.empty();
    setIcon(statusEl, 'circle');
  }
}

/**
 * Render tool body content — dispatch by content types and tool kind.
 *
 * - bash/execute: command + terminal output in code blocks
 * - read: file content with line count
 * - search/grep: list of matched results
 * - fetch/web_search: truncated content preview
 * - think: reasoning text
 * - Default: content items or raw output
 */
function renderToolBodyContent(
  body: HTMLElement,
  kind: string,
  content: ToolCallContent[],
  rawOutput?: Record<string, unknown>,
): void {
  // Extract text content from content items
  const textParts: string[] = [];
  let hasDiffContent = false;

  for (const item of content) {
    if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
      const diffLines = parseDiffLines(item.oldText, item.newText);
      renderDiffContent(body, diffLines);
      hasDiffContent = true;
    } else if (item.type === 'content' && item.content?.type === 'text' && item.content.text) {
      textParts.push(item.content.text);
    }
  }

  const text = textParts.join('\n');
  const outputText = rawOutput
    ? (rawOutput.text ?? rawOutput.output ?? rawOutput.result ?? rawOutput.content) as string | undefined
    : undefined;

  // Tool-specific rendering
  switch (kind) {
    case 'bash':
    case 'execute': {
      renderBashExpanded(body, text || outputText || '', rawOutput);
      return;
    }
    case 'read': {
      if (text || outputText) {
        renderLinesExpanded(body, text || outputText!, 15);
      } else if (!hasDiffContent) {
        body.createDiv({ cls: 'co-ober-tool-empty', text: 'No content' });
      }
      return;
    }
    case 'search':
    case 'grep': {
      const searchResult = text || outputText || '';
      if (searchResult) {
        renderSearchExpanded(body, searchResult);
      } else if (!hasDiffContent) {
        body.createDiv({ cls: 'co-ober-tool-empty', text: 'No matches' });
      }
      return;
    }
    case 'fetch':
    case 'web_search': {
      if (text || outputText) {
        renderLinesExpanded(body, text || outputText!, 20);
        if (rawOutput?.url) {
          body.createDiv({
            cls: 'co-ober-tool-url',
            text: `Source: ${rawOutput.url as string}`,
          });
        }
      } else if (!hasDiffContent) {
        body.createDiv({ cls: 'co-ober-tool-empty', text: 'No result' });
      }
      return;
    }
    case 'think': {
      if (text || outputText) {
        renderLinesExpanded(body, text || outputText!, 30);
      }
      return;
    }
    case 'apply_patch': {
      renderApplyPatchExpanded(body, text || outputText || '', rawOutput, content);
      return;
    }
    default: {
      // Default: render content items or raw output
      if (!hasDiffContent) {
        if (text) {
          body.createDiv({ text: renderTruncatedText(text, 20) });
        } else if (rawOutput) {
          const json = JSON.stringify(rawOutput, null, 2);
          if (json !== '{}' && json !== 'undefined') {
            body.createDiv({ text: renderTruncatedText(json, 20) });
          }
        }
      }
      break;
    }
  }
}

/**
 * Render bash/execute tool expanded content — command + stdout + stderr.
 */
function renderBashExpanded(
  container: HTMLElement,
  text: string,
  rawOutput?: Record<string, unknown>,
): void {
  if (text) {
    renderLinesExpanded(container, text, 30);
  }

  // If rawOutput has structured fields, show them too
  if (rawOutput) {
    const exitCode = rawOutput.exit_code ?? rawOutput.exitCode;
    if (typeof exitCode === 'number') {
      const statusEl = container.createDiv({
        cls: 'co-ober-tool-exit-status',
        text: `Exit code: ${exitCode}`,
      });
      if (exitCode !== 0) {
        statusEl.addClass('error');
      }
    }
    const error = rawOutput.error as string | undefined;
    if (error) {
      container.createDiv({
        cls: 'co-ober-tool-stderr',
        text: renderTruncatedText(error, 10),
      });
    }
  }
}

/**
 * Render search/grep tool expanded content with file paths.
 */
function renderSearchExpanded(
  container: HTMLElement,
  result: string,
): void {
  const lines = result.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    container.createDiv({ cls: 'co-ober-tool-empty', text: 'No matches found' });
    return;
  }

  const maxLines = 20;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const linesEl = container.createDiv({ cls: 'co-ober-tool-lines' });
  for (const line of displayLines) {
    const lineEl = linesEl.createDiv({ cls: 'co-ober-tool-line hoverable' });
    lineEl.setText(line);
  }

  if (truncated) {
    linesEl.createDiv({
      cls: 'co-ober-tool-truncated',
      text: `... ${lines.length - maxLines} more matches`,
    });
  }
}

/**
 * Render apply_patch tool expanded content — multi-file diff sections.
 *
 * Parses the patch text or rawOutput for file-level diffs and renders
 * each as a collapsible section with change markers.
 *
 * Supports formats:
 * - Raw text with file markers (*** Add/Update/Delete File: path)
 * - content items with diff type
 * - rawOutput with structured file lists
 */
function renderApplyPatchExpanded(
  container: HTMLElement,
  text: string,
  rawOutput?: Record<string, unknown>,
  content?: ToolCallContent[],
): void {
  // 1. Try content items first (diff type)
  let hasContent = false;
  if (content) {
    for (const item of content) {
      if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
        const section = container.createDiv({ cls: 'co-ober-patch-section' });
        const fileHeader = section.createDiv({ cls: 'co-ober-patch-file' });
        setIcon(fileHeader.createSpan({ cls: 'co-ober-patch-file-icon' }), 'file');
        fileHeader.createSpan({ cls: 'co-ober-patch-file-name', text: item.path });
        const diffLines = parseDiffLines(item.oldText, item.newText);
        renderDiffContent(section, diffLines);
        hasContent = true;
      }
    }
  }

  // 2. Try parsing file diffs from text (*** markers)
  if (!hasContent && text) {
    const fileDiffs = parseApplyPatchFileDiffs(text);
    if (fileDiffs.length > 0) {
      for (const fd of fileDiffs) {
        const section = container.createDiv({ cls: 'co-ober-patch-section' });
        const fileHeader = section.createDiv({ cls: 'co-ober-patch-file' });
        const icon = fd.operation === 'add' ? 'file-plus'
          : fd.operation === 'delete' ? 'trash'
          : 'file-pen';
        setIcon(fileHeader.createSpan({ cls: 'co-ober-patch-file-icon' }), icon);
        fileHeader.createSpan({ cls: 'co-ober-patch-file-name', text: fd.filePath });
        const opText = fd.operation === 'add' ? 'ADD'
          : fd.operation === 'delete' ? 'DELETE'
          : 'UPDATE';
        fileHeader.createSpan({ cls: `co-ober-patch-op co-ober-patch-op-${fd.operation}`, text: opText });

        if (fd.diffLines.length > 0) {
          renderDiffContent(section, fd.diffLines);
        } else if (fd.operation === 'delete') {
          section.createDiv({ cls: 'co-ober-tool-empty', text: 'File deleted' });
        }
        hasContent = true;
      }
    }
  }

  // 3. Fallback to raw text
  if (!hasContent) {
    if (text) {
      renderLinesExpanded(container, text, 20);
    } else if (rawOutput) {
      const json = JSON.stringify(rawOutput, null, 2);
      if (json !== '{}' && json !== 'undefined') {
        container.createDiv({ text: renderTruncatedText(json, 20) });
      }
    } else {
      container.createDiv({ cls: 'co-ober-tool-empty', text: 'No result' });
    }
  }
}

interface ParsedFileDiff {
  filePath: string;
  operation: 'add' | 'update' | 'delete';
  diffLines: import('./DiffRenderer').DiffLine[];
}

/**
 * Parse apply_patch text output into file-level diffs.
 */
function parseApplyPatchFileDiffs(patchText: string): ParsedFileDiff[] {
  const result: ParsedFileDiff[] = [];
  const lines = patchText.split(/\r?\n/);
  let current: { filePath: string; operation: ParsedFileDiff['operation']; rawLines: string[] } | null = null;

  const flushCurrent = () => {
    if (!current) return;
    const diffLines: import('./DiffRenderer').DiffLine[] = [];
    for (const line of current.rawLines) {
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === '+') {
        diffLines.push({ type: 'insert', text });
      } else if (prefix === '-') {
        diffLines.push({ type: 'delete', text });
      } else if (prefix === ' ') {
        diffLines.push({ type: 'equal', text });
      }
    }
    result.push({
      filePath: current.filePath,
      operation: current.operation,
      diffLines,
    });
    current = null;
  };

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      flushCurrent();
      current = { filePath: addMatch[1].trim(), operation: 'add', rawLines: [] };
      continue;
    }
    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      flushCurrent();
      current = { filePath: updateMatch[1].trim(), operation: 'update', rawLines: [] };
      continue;
    }
    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      flushCurrent();
      result.push({
        filePath: deleteMatch[1].trim(),
        operation: 'delete',
        diffLines: [],
      });
      continue;
    }

    if (!current) continue;
    const prefix = line[0];
    if (prefix === '+' || prefix === '-' || prefix === ' ') {
      current.rawLines.push(line);
    }
  }

  flushCurrent();
  return result;
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
