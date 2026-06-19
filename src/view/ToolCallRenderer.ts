/**
 * Tool call renderer — renders individual tool calls as collapsible cards
 * with status indicators and tool-specific content previews.
 *
 * Standard layout: [icon] [tool-name] [file/command summary] [status icon]
 * Status: running(rotating) / completed(check) / error(x) / blocked(shield)
 *
 * @since Phase 1
 */

import { setIcon } from 'obsidian';
import type { ToolCallContent } from '../types';

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
export function getToolSummary(kind: string, input?: Record<string, unknown>, locations?: { path: string }[]): string {
  const locs = locations ?? [];
  const rawInput = input ?? {};

  // bash: show command
  if (kind === 'bash' || kind === 'execute') {
    const cmd = (rawInput.command as string) ?? '';
    return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
  }

  // read / edit / write: show file path
  if (kind === 'read' || kind === 'edit' || kind === 'write') {
    const path = locs[0]?.path ?? rawInput.file_path ?? rawInput.filePath ?? rawInput.path ?? '';
    return path ? (path.split(/[\\/]/).pop() ?? path) : '';
  }

  // grep: show pattern
  if (kind === 'grep' || kind === 'search') {
    const pattern = (rawInput.pattern as string) ?? '';
    return pattern.length > 60 ? pattern.slice(0, 57) + '...' : pattern;
  }

  // apply_patch: show target
  if (kind === 'apply_patch') {
    const path = (rawInput.path as string) ?? '';
    return path ? (path.split(/[\\/]/).pop() ?? path) : '';
  }

  // web_search: show query
  if (kind === 'web_search' || kind === 'fetch') {
    const query = (rawInput.q as string) ?? (rawInput.query as string) ?? (rawInput.url as string) ?? '';
    return query.length > 60 ? query.slice(0, 57) + '...' : query;
  }

  // file_search: show query
  if (kind === 'file_search') {
    const query = (rawInput.query as string) ?? '';
    return query.length > 60 ? query.slice(0, 57) + '...' : query;
  }

  // ls: show path
  if (kind === 'ls') {
    const path = (rawInput.path as string) ?? '';
    return path || '';
  }

  // Default: show first location path or input key
  if (locs[0]?.path) return locs[0].path.split(/[\\/]/).pop() ?? '';
  const firstValue = Object.values(rawInput).find(v => typeof v === 'string');
  if (firstValue) {
    return (firstValue as string).length > 60 ? (firstValue as string).slice(0, 57) + '...' : firstValue as string;
  }
  return '';
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallState {
  wrapper: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  iconEl: HTMLElement;
  kindEl: HTMLElement;
  summaryEl: HTMLElement;
  statusEl: HTMLElement;
}

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
  const wrapper = parentEl.createDiv({ cls: 'co-ober-tool-call' });
  wrapper.dataset.toolId = toolCallId;

  const header = wrapper.createDiv({ cls: 'co-ober-tool-call-header' });
  const iconEl = header.createSpan({ cls: 'tc-icon' });
  setIcon(iconEl, TOOL_ICONS[kind] || 'tool');

  const kindEl = header.createSpan({ cls: 'tc-kind', text: getToolDisplayName(kind) });

  const summary = getToolSummary(kind, input, locations);
  const summaryEl = header.createSpan({ cls: 'tc-file', text: summary });

  const statusEl = header.createSpan({ cls: 'tc-stat', text: '…' });

  const body = wrapper.createDiv({ cls: 'co-ober-tool-call-body' });
  wrapper.classList.add('is-collapsed');

  // Toggle on header click
  header.addEventListener('click', () => {
    wrapper.classList.toggle('is-collapsed');
  });

  return { wrapper, header, body, iconEl, kindEl, summaryEl, statusEl };
}

/**
 * Update a tool call's status and optionally its content/body.
 */
export function updateToolCallElement(
  state: ToolCallState,
  status: ToolCallStatus,
  kind: string,
  rawOutput?: Record<string, unknown>,
  content?: ToolCallContent[],
  rawInput?: Record<string, unknown>,
  locations?: { path: string }[],
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

  if (status === 'in_progress') {
    wrapper.classList.add('status-running');
    statusEl.textContent = '…';
  } else if (status === 'completed') {
    wrapper.classList.add('status-completed');
    statusEl.textContent = '✓';
    statusEl.classList.add('tc-stat-done');

    // Render body content
    if (content && content.length > 0) {
      body.empty();
      let added = 0;
      let removed = 0;
      for (const item of content) {
        if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
          const oldLines = item.oldText.split('\n');
          const newLines = item.newText.split('\n');
          for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
            if (oldLines[i] === undefined) added++;
            else if (newLines[i] === undefined) removed++;
            else if (oldLines[i] !== newLines[i]) { added++; removed++; }
          }
          body.appendChild(renderDiffContent(item.path, item.oldText, item.newText));
        } else if (item.type === 'content' && item.content.type === 'text' && item.content.text) {
          body.createDiv({ text: item.content.text });
        }
      }
      if (added || removed) {
        const statParts: string[] = [];
        if (added) statParts.push(`+${added}`);
        if (removed) statParts.push(`-${removed}`);
        statusEl.textContent = statParts.join(' ') || '✓';
      }
    } else if (rawOutput) {
      body.empty();
      const outputText = JSON.stringify(rawOutput, null, 2);
      const truncated = truncateContent(outputText, 20);
      body.createDiv({ text: truncated });
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
 * Render inline diff content (simple line-by-line).
 */
function renderDiffContent(path: string, oldText: string, newText: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'co-ober-diff';

  const header = container.createDiv({ cls: 'co-ober-diff-header', text: path });
  const body = container.createDiv({ cls: 'co-ober-diff-body' });

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  let displayCount = 0;
  const MAX_DIFF_LINES = 50;

  for (let i = 0; i < maxLen; i++) {
    if (displayCount >= MAX_DIFF_LINES) {
      body.createDiv({ cls: 'diff-line truncated', text: `... ${maxLen - i} more lines` });
      break;
    }
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === undefined) {
      const line = body.createDiv({ cls: 'diff-line added' });
      line.createSpan({ cls: 'diff-marker', text: '+' });
      line.createSpan({ text: newLine });
      displayCount++;
    } else if (newLine === undefined) {
      const line = body.createDiv({ cls: 'diff-line removed' });
      line.createSpan({ cls: 'diff-marker', text: '-' });
      line.createSpan({ text: oldLine });
      displayCount++;
    } else if (oldLine !== newLine) {
      const rmLine = body.createDiv({ cls: 'diff-line removed' });
      rmLine.createSpan({ cls: 'diff-marker', text: '-' });
      rmLine.createSpan({ text: oldLine });
      const addLine = body.createDiv({ cls: 'diff-line added' });
      addLine.createSpan({ cls: 'diff-marker', text: '+' });
      addLine.createSpan({ text: newLine });
      displayCount += 2;
    } else {
      const line = body.createDiv({ cls: 'diff-line context' });
      line.createSpan({ cls: 'diff-marker', text: ' ' });
      line.createSpan({ text: oldLine });
      displayCount++;
    }
  }

  header.addEventListener('click', () => {
    container.classList.toggle('is-collapsed');
  });

  return container;
}

/**
 * Truncate text to a maximum number of lines.
 */
export function truncateContent(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n... ${lines.length - maxLines} more lines`;
}
