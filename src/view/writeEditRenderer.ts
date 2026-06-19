/**
 * WriteEditRenderer — dedicated rendering for Write/Edit tool calls
 * with diff previews and file path display.
 *
 * Layout: [icon] [Write/Edit] [filename] [stats +N -M] [status]
 * Content area shows inline diff when completed.
 *
 * @since Phase 1 (refactored)
 */

import { setIcon } from 'obsidian';
import { setupCollapsible, collapseElement, type CollapsibleState } from './collapsible';
import {
  parseDiffLines,
  renderDiffContent,
  renderDiffStats,
  computeDiffStats,
} from './DiffRenderer';

export interface WriteEditState {
  wrapper: HTMLElement;
  header: HTMLElement;
  nameEl: HTMLElement;
  fileNameEl: HTMLElement;
  statsEl: HTMLElement;
  statusEl: HTMLElement;
  body: HTMLElement;
  collapsibleState: CollapsibleState;
}

/**
 * Create a write/edit block element with collapsible diff content.
 */
export function createWriteEditBlock(
  parentEl: HTMLElement,
  toolCallId: string,
  kind: string,
  filePath?: string,
): WriteEditState {
  const wrapper = parentEl.createDiv({ cls: 'co-ober-write-edit' });
  wrapper.dataset.toolId = toolCallId;

  const header = wrapper.createDiv({ cls: 'co-ober-tool-call-header' });
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-label', `${kind}: ${filePath || 'file'} - click to expand`);

  const iconEl = header.createSpan({ cls: 'tc-icon' });
  const icon = kind === 'edit' ? 'file-pen' : 'file-plus';
  setIcon(iconEl, icon);

  const nameEl = header.createSpan({ cls: 'tc-kind', text: kind });
  const fileNameEl = header.createSpan({ cls: 'tc-file', text: filePath || '' });
  const statsEl = header.createSpan({ cls: 'tc-diff-stats' });
  const statusEl = header.createSpan({ cls: 'tc-stat', text: '' });

  const body = wrapper.createDiv({ cls: 'co-ober-tool-call-body' });

  const collapsibleState: CollapsibleState = { isExpanded: false };
  setupCollapsible(wrapper, header, body, collapsibleState, {
    initiallyExpanded: false,
    baseAriaLabel: `${kind}: ${filePath || 'file'}`,
    scrollOnExpand: true,
  });

  return {
    wrapper, header, nameEl, fileNameEl, statsEl, statusEl, body, collapsibleState,
  };
}

/**
 * Update write/edit block with completed diff content.
 */
export function updateWriteEditContent(
  state: WriteEditState,
  path: string,
  oldText: string,
  newText: string,
): void {
  state.body.empty();
  // Clear status — empty tc-stat is hidden via CSS so stats sit flush right
  state.statusEl.textContent = '';
  state.statusEl.className = 'tc-stat';

  // Compute and render stats in header
  const stats = computeDiffStats(oldText, newText);
  state.statsEl.empty();
  renderDiffStats(state.statsEl, stats);

  // Add done class to wrapper so CSS can hide empty status
  state.wrapper.addClass('status-completed');

  // Render diff in expanded body
  const diffLines = parseDiffLines(oldText, newText);
  renderDiffContent(state.body, diffLines);

  // Collapse by default — user clicks to see the full diff
  collapseElement(state.wrapper, state.header, state.collapsibleState);
}

/**
 * Finalize write/edit block to completed state.
 */
export function finalizeWriteEditBlock(state: WriteEditState): void {
  // Clear status — empty tc-stat is hidden via CSS so stats sit flush right
  state.statusEl.textContent = '';
  state.statusEl.className = 'tc-stat';
  state.wrapper.addClass('status-completed');
  collapseElement(state.wrapper, state.header, state.collapsibleState);
}

/**
 * Mark write/edit block as failed and collapse it.
 */
export function failWriteEditBlock(state: WriteEditState, errorOutput?: Record<string, unknown>): void {
  state.statusEl.textContent = '✗';
  state.statusEl.className = 'tc-stat tc-stat-fail';
  state.wrapper.addClass('status-error');
  if (errorOutput) {
    state.body.empty();
    state.body.createDiv({ text: JSON.stringify(errorOutput, null, 2) });
  }
  collapseElement(state.wrapper, state.header, state.collapsibleState);
}
