/**
 * Tool call renderer — renders individual tool calls as collapsible cards
 * with status indicators and tool-specific content previews.
 *
 * Standard layout: [icon] [tool-name] [file/command summary] [status icon]
 * Status: running(rotating) / completed(check) / error(x) / queued(circle)
 *
 * Uses unified collapsible pattern and DiffRenderer for hunk-based diff.
 *
 * @since Phase 1 (refactored)
 */

import { setIcon } from 'obsidian';
import type { ToolCallContent } from '../types';
import { setupCollapsible, collapseElement, type CollapsibleState } from './collapsible';
import { parseDiffLines, renderDiffContent } from './DiffRenderer';
import { createWriteEditBlock, updateWriteEditContent, type WriteEditState } from './writeEditRenderer';
import { t, lookupLocaleString } from '../i18n/index';

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
  /**
   * The kind as the agent named it, kept so an update that does not repeat it
   * can ask rather than read it back off the label — which is localized, so in
   * any language but English the answer was a display string that is no kind.
   */
  kind: string;
  /** Non-null when the tool is a write/edit type, for dedicated rendering */
  writeEditState?: WriteEditState;
}

// ---- Tool Display Helpers ----

/** Map tool kind to a localized display name; unknown kinds get a capitalized pass-through. */
export function getToolDisplayName(kind: string): string {
  return lookupLocaleString(`toolKind.${kind}`) ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Extract a one-line summary of a tool call from its input. */
export function getToolSummary(kind: string, input?: Record<string, unknown>, locations?: { path: string }[]): string {
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
  kindEl.dataset.i18nKind = kind;

  const summary = getToolSummary(kind, input, locations);
  const summaryEl = header.createSpan({ cls: 'tc-file', text: summary });

  const statusEl = header.createSpan({ cls: 'tc-stat', text: '…' });

  const body = wrapper.createDiv({ cls: 'co-ober-tool-call-body' });

  const collapsibleState: CollapsibleState = { isExpanded: false };
  setupCollapsible(wrapper, header, body, collapsibleState, {
    initiallyExpanded: false,
    // The summary this card shows changes as input arrives, and the fallback is
    // a word the locale owns. Rebuild the announcement from what the header
    // actually says rather than from the strings it was created with.
    baseAriaLabel: () => `${title}: ${summaryEl.textContent?.trim() || getToolDisplayName(kind)}`,
    scrollOnExpand: true,
  });

  return { wrapper, header, body, iconEl, kindEl, summaryEl, statusEl, collapsibleState, kind };
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
    parentEl,
    toolCallId,
    kind,
    getToolSummary(kind, input, locations),
  );

  const { wrapper, header, body, collapsibleState } = bw;
  const iconEl = header.querySelector('.tc-icon') as HTMLElement;
  const kindEl = header.querySelector('.tc-kind') as HTMLElement;
  const summaryEl = header.querySelector('.tc-file') as HTMLElement;
  const statusEl = header.querySelector('.tc-stat') as HTMLElement;

  return {
    wrapper,
    header,
    body,
    iconEl,
    kindEl,
    summaryEl,
    statusEl,
    collapsibleState,
    kind,
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
  // The locale repaint reads the kind back off this attribute, so a card whose
  // kind changed mid-flight would otherwise come back wearing its old name.
  state.kindEl.dataset.i18nKind = kind;
  state.kind = kind;

  // Update summary if new input available
  if (rawInput) {
    const newSummary = getToolSummary(kind, rawInput, locations);
    if (newSummary) summaryEl.textContent = newSummary;
  }

  // Status classes. The list is the four states this renderer can actually put
  // on a card; a fifth was cleared here for a look nothing ever produced.
  wrapper.classList.remove('status-pending', 'status-running', 'status-completed', 'status-error');
  statusEl.className = 'tc-stat';

  // Handle write/edit tools through dedicated renderer
  if ((kind === 'write' || kind === 'edit') && content) {
    for (const item of content) {
      // File creations carry only newText; treat a missing side as empty.
      if (item.type === 'diff' && item.path && (item.oldText !== undefined || item.newText !== undefined)) {
        const oldText = item.oldText ?? '';
        const newText = item.newText ?? '';
        if (state.writeEditState) {
          updateWriteEditContent(state.writeEditState, item.path, oldText, newText);
        } else {
          // Fallback: inline diff via DiffRenderer
          body.empty();
          const diffLines = parseDiffLines(oldText, newText);
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
    nameStatus(state, 'tool.status.running');
  } else if (status === 'completed') {
    wrapper.classList.add('status-completed');
    statusEl.empty();
    setIcon(statusEl, 'check');
    statusEl.addClass('tc-stat-done');
    nameStatus(state, 'tool.status.done');

    // Render body content for non-write/edit tools. The body is cleared first
    // because an agent that repeats the finished frame — or answers a failure
    // with the success it meant — must replace the result, not stack a second
    // copy of the output underneath the first.
    if (kind !== 'write' && kind !== 'edit') {
      body.empty();
      if (content && content.length > 0) {
        renderToolBodyContent(body, kind, content, rawOutput);
      }
    }

    // Auto-collapse on completion
    autoCollapseToolCall(state);
  } else if (status === 'failed') {
    wrapper.classList.add('status-error');
    statusEl.empty();
    setIcon(statusEl, 'x');
    statusEl.addClass('tc-stat-fail');
    nameStatus(state, 'tool.status.failed');
    if (rawOutput) {
      body.empty();
      const message =
        typeof rawOutput.error === 'string' && rawOutput.error
          ? rawOutput.error
          : typeof rawOutput.message === 'string' && rawOutput.message
            ? rawOutput.message
            : JSON.stringify(rawOutput, null, 2);
      body.createDiv({ text: message });
    }
    // Auto-collapse on failure as well
    autoCollapseToolCall(state);
  } else {
    // pending — the call is queued, not yet started. Without its own look it is
    // indistinguishable from a card that finished quietly.
    wrapper.classList.add('status-pending');
    statusEl.empty();
    setIcon(statusEl, 'circle');
    statusEl.addClass('tc-stat-wait');
    nameStatus(state, 'tool.status.queued');
  }
}

/**
 * Give the status glyph the name of the state it stands for. It is the only
 * thing on the card that says what the call is doing, and a reader with the
 * icon hidden — or reading it through a screen reader — gets nothing else.
 * The key goes on the element too, because a card that was finished before the
 * language changed kept answering in the old one.
 */
function nameStatus(state: ToolCallState, key: string): void {
  const label = lookupLocaleString(key) ?? '';
  state.statusEl.dataset.i18nLabel = key;
  state.statusEl.setAttribute('aria-label', label);
  state.statusEl.setAttribute('title', label);
}

/**
 * Settle a restored call the transcript says nothing about.
 *
 * A card is created wearing the in-flight `…` because a live call has not been
 * answered yet. History that carries neither a status nor an error will never be
 * answered — so leaving the mark up shows a command still running in a
 * conversation that stopped the moment it was written down. The name says what
 * is really known: no record. No status class goes on, because there is no state
 * here to depict.
 */
export function settleUnrecordedToolCall(state: ToolCallState): void {
  const label = lookupLocaleString('tool.status.unrecorded') ?? '';
  state.statusEl.textContent = '–';
  state.statusEl.className = 'tc-stat';
  state.statusEl.dataset.i18nLabel = 'tool.status.unrecorded';
  state.statusEl.setAttribute('aria-label', label);
  state.statusEl.setAttribute('title', label);
}

/**
 * Settle a card the turn left open. The reader opening one by hand outranks the
 * turn boundary: collapsing it back buries the output they went looking for, and
 * on a failure it drew the error line and hid it in the same breath.
 */
export function autoCollapseToolCall(state: ToolCallState): void {
  if (state.collapsibleState.userToggled) return;
  collapseElement(state.wrapper, state.header, state.collapsibleState);
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
  let hasStandaloneContent = false;

  for (const item of content) {
    if (item.type === 'diff' && item.path && item.oldText !== undefined && item.newText !== undefined) {
      const diffLines = parseDiffLines(item.oldText, item.newText);
      renderDiffContent(body, diffLines);
      hasDiffContent = true;
    } else if (item.type === 'content' && item.content?.type === 'text' && item.content.text) {
      textParts.push(item.content.text);
    } else if (item.type === 'content' && item.content?.type === 'image') {
      renderToolImage(body, item.content.mimeType, item.content.data);
      hasStandaloneContent = true;
    } else if (item.type === 'unsupported') {
      // Parsing kept the wire tag precisely so this line can name it: an item
      // the reader never hears about is an item they assume the tool did not send.
      body.createDiv({
        cls: 'co-ober-tool-unsupported',
        text: item.originalType
          ? t().tool.unsupportedContent.replace('{type}', item.originalType)
          : t().tool.unsupportedUnknown,
      });
      hasStandaloneContent = true;
    }
  }

  const emptyStateShown = hasDiffContent || hasStandaloneContent;
  const text = textParts.join('\n');
  const outputText = rawOutput
    ? ((rawOutput.text ?? rawOutput.output ?? rawOutput.result ?? rawOutput.content) as string | undefined)
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
      } else if (!emptyStateShown) {
        const emptyEl = body.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noContent });
        emptyEl.dataset.i18nText = 'tool.noContent';
      }
      return;
    }
    case 'search':
    case 'grep': {
      const searchResult = text || outputText || '';
      if (searchResult) {
        renderSearchExpanded(body, searchResult);
      } else if (!emptyStateShown) {
        const emptyEl = body.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noMatches });
        emptyEl.dataset.i18nText = 'tool.noMatches';
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
            text: t().tool.source.replace('{url}', rawOutput.url as string),
          });
        }
      } else if (!emptyStateShown) {
        const emptyEl = body.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noResult });
        emptyEl.dataset.i18nText = 'tool.noResult';
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
      // Default: render content items or raw output. An image or an unreadable
      // item alongside text does not replace that text — showing one and
      // hiding the other loses half of what the tool returned. The JSON dump
      // stays a last resort, so it does not crowd out a drawn result.
      if (text) {
        body.createDiv({ text: renderTruncatedText(text, 20) });
      } else if (rawOutput && !emptyStateShown) {
        const json = JSON.stringify(rawOutput, null, 2);
        if (json !== '{}' && json !== 'undefined') {
          body.createDiv({ text: renderTruncatedText(json, 20) });
        }
      }
      break;
    }
  }
}

/** The only image types this client will hand to an <img> element as a data URL. */
const RENDERABLE_IMAGE_MIME = /^(image\/(png|jpeg|gif|webp|bmp))$/i;

function renderToolImage(body: HTMLElement, mimeType: string, data: string): void {
  if (!RENDERABLE_IMAGE_MIME.test(mimeType) || !data) {
    body.createDiv({
      cls: 'co-ober-tool-unsupported',
      text: mimeType
        ? t().tool.unsupportedContent.replace('{type}', mimeType)
        : t().tool.unsupportedUnknown,
    });
    return;
  }
  const img = body.createEl('img', { cls: 'co-ober-tool-image' });
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.src = `data:${mimeType};base64,${data}`;
}

/**
 * Render bash/execute tool expanded content — command + stdout + stderr.
 */
function renderBashExpanded(container: HTMLElement, text: string, rawOutput?: Record<string, unknown>): void {
  if (text) {
    renderLinesExpanded(container, text, 30);
  }

  // If rawOutput has structured fields, show them too
  if (rawOutput) {
    const exitCode = rawOutput.exit_code ?? rawOutput.exitCode;
    if (typeof exitCode === 'number') {
      const statusEl = container.createDiv({
        cls: 'co-ober-tool-exit-status',
        text: t().tool.exitCode.replace('{code}', String(exitCode)),
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

  // A command that ran and printed nothing expands to an empty box, which reads
  // as a card that failed to load rather than as a silent success.
  if (container.children.length === 0) {
    const emptyEl = container.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noContent });
    emptyEl.dataset.i18nText = 'tool.noContent';
  }
}

/**
 * Render search/grep tool expanded content with file paths.
 */
function renderSearchExpanded(container: HTMLElement, result: string): void {
  const lines = result.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    const emptyEl = container.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noMatchesFound });
    emptyEl.dataset.i18nText = 'tool.noMatchesFound';
    return;
  }

  const maxLines = 20;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const linesEl = container.createDiv({ cls: 'co-ober-tool-lines' });
  for (const line of displayLines) {
    // A search match is not clickable — nothing binds a click to a tool line —
    // so it carries no cursor:pointer promise. renderSearchExpanded used to tag
    // these `hoverable`, drawing a pointing-hand and a hover highlight that
    // offered an action no handler would ever take.
    const lineEl = linesEl.createDiv({ cls: 'co-ober-tool-line' });
    lineEl.setText(line);
  }

  if (truncated) {
    const n = String(lines.length - maxLines);
    const truncEl = linesEl.createDiv({
      cls: 'co-ober-tool-truncated',
      text: t().tool.moreMatches.replace('{count}', n),
    });
    truncEl.dataset.i18nCount = 'tool.moreMatches';
    truncEl.dataset.count = n;
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
        // renderDiffContent empties its container first — give it a dedicated host so the header survives
        renderDiffContent(section.createDiv({ cls: 'co-ober-patch-diff' }), diffLines);
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
        const icon = fd.operation === 'add' ? 'file-plus' : fd.operation === 'delete' ? 'trash' : 'file-pen';
        setIcon(fileHeader.createSpan({ cls: 'co-ober-patch-file-icon' }), icon);
        fileHeader.createSpan({ cls: 'co-ober-patch-file-name', text: fd.filePath });
        // The operation chip is a word the reader reads, not an internal tag —
        // left as a literal it told a Chinese UI "UPDATE" beside a localized
        // delete note. The key rides along so a locale switch re-speaks it.
        const opKey = fd.operation === 'add'
          ? 'tool.patchOp.add'
          : fd.operation === 'delete'
            ? 'tool.patchOp.delete'
            : 'tool.patchOp.update';
        const opEl = fileHeader.createSpan({
          cls: `co-ober-patch-op co-ober-patch-op-${fd.operation}`,
          text: lookupLocaleString(opKey) ?? fd.operation.toUpperCase(),
        });
        opEl.dataset.i18nText = opKey;

        if (fd.diffLines.length > 0) {
          renderDiffContent(section.createDiv({ cls: 'co-ober-patch-diff' }), fd.diffLines);
        } else if (fd.operation === 'delete') {
          const emptyEl = section.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.fileDeleted });
          emptyEl.dataset.i18nText = 'tool.fileDeleted';
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
      const emptyEl = container.createDiv({ cls: 'co-ober-tool-empty', text: t().tool.noResult });
      emptyEl.dataset.i18nText = 'tool.noResult';
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
export function renderLinesExpanded(container: HTMLElement, result: string, maxLines: number): void {
  const lines = result.split(/\r?\n/);
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  const linesEl = container.createDiv({ cls: 'co-ober-tool-lines' });
  for (const line of displayLines) {
    const lineEl = linesEl.createDiv({ cls: 'co-ober-tool-line' });
    lineEl.setText(line || ' ');
  }

  if (truncated) {
    const n = String(lines.length - maxLines);
    const truncEl = linesEl.createDiv({
      cls: 'co-ober-tool-truncated',
      text: t().tool.moreLines.replace('{count}', n),
    });
    truncEl.dataset.i18nCount = 'tool.moreLines';
    truncEl.dataset.count = n;
  }
}

/**
 * Truncate text to a maximum number of lines, appending "X more lines".
 */
export function renderTruncatedText(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n${t().tool.moreLines.replace('{count}', String(lines.length - maxLines))}`;
}

// ---- Internal Helpers ----

function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function rawPathFromInput(rawInput: Record<string, unknown>, locs: { path: string }[]): string {
  return (
    locs[0]?.path ?? (rawInput.file_path as string) ?? (rawInput.filePath as string) ?? (rawInput.path as string) ?? ''
  );
}
