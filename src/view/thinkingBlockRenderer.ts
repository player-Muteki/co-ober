/**
 * Thinking-block renderer with a live timer, auto-collapse on completion,
 * content truncation on expand, and scroll-into-view.
 *
 * Live timer: "Thinking 0s…" → "Thinking 12s…"
 * On completion: auto-collapse, label becomes "Thought for 12s"
 * On expand: shows truncated content (first 30 lines) with "Show all" link,
 *            scrolls block into view.
 * Animated dot indicator. The block remains collapsed during streaming
 * — the header timer is the live progress signal.
 *
 * @since Phase 1 (refactored)
 */

import { setupCollapsible, collapseElement, type CollapsibleState } from './collapsible';
import { THINKING_TIMER_INTERVAL_MS } from '../constants';

const ANIMATION_INTERVAL_MS = 500;
/** Max lines shown on first expand — beyond this gets truncated with "Show all" */
const TRUNCATE_LINES = 30;

export interface ThinkingState {
  wrapper: HTMLElement;
  header: HTMLElement;
  labelEl: HTMLElement;
  body: HTMLElement;
  timerEl: HTMLElement;
  startTime: number;
  timerInterval: ReturnType<typeof setInterval> | null;
  dotInterval: ReturnType<typeof setInterval> | null;
  collapsibleState: CollapsibleState;
  /** Full (untruncated) thinking text */
  fullText: string;
  /** Whether the body currently shows full content (after "Show all") */
  showingFull: boolean;
  cleanup: () => void;
}

const DOT_CHARS = ['·', '··', '···'];

/**
 * Truncate text to a max number of lines, returning truncated version + original.
 */
function truncateLines(text: string, maxLines: number): { display: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { display: text, truncated: false };
  return {
    display: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

/**
 * Create a live thinking block and start the timer + dot animation.
 */
export function renderLiveThinkingBlock(
  parentEl: HTMLElement,
): ThinkingState {
  const wrapper = parentEl.createDiv({ cls: 'co-ober-thinking-block' });
  wrapper.classList.add('is-thinking');

  const header = wrapper.createDiv({ cls: 'co-ober-thinking-header' });
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');

  const labelEl = header.createSpan({ cls: 'co-ober-thinking-label', text: 'Thinking' });
  const timerEl = header.createSpan({ cls: 'co-ober-thinking-timer', text: '0s' });
  const dotEl = header.createSpan({ cls: 'co-ober-thinking-dot', text: '···' });

  const body = wrapper.createDiv({ cls: 'co-ober-thinking-body' });

  const collapsibleState: CollapsibleState = { isExpanded: false };

  const state: ThinkingState = {
    wrapper,
    header,
    labelEl,
    body,
    timerEl,
    startTime: Date.now(),
    timerInterval: null,
    dotInterval: null,
    collapsibleState,
    fullText: '',
    showingFull: false,
    cleanup: () => {},
  };

  // Live timer: update every second
  state.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    state.timerEl.textContent = `${elapsed}s`;
  }, THINKING_TIMER_INTERVAL_MS);

  // Dot animation: cycle every 500ms
  let dotIndex = 0;
  state.dotInterval = setInterval(() => {
    dotIndex = (dotIndex + 1) % DOT_CHARS.length;
    dotEl.textContent = DOT_CHARS[dotIndex];
  }, ANIMATION_INTERVAL_MS);

  // Use unified collapsible with scroll-into-view
  setupCollapsible(wrapper, header, body, collapsibleState, {
    initiallyExpanded: false,
    baseAriaLabel: 'Extended thinking',
    scrollOnExpand: true,
    onExpand: () => handleThinkingExpand(state),
  });

  state.cleanup = () => {
    if (state.timerInterval !== null) clearInterval(state.timerInterval);
    if (state.dotInterval !== null) clearInterval(state.dotInterval);
  };

  return state;
}

/**
 * Handle expand event — truncate content and enable scroll.
 */
function handleThinkingExpand(state: ThinkingState): void {
  if (!state.fullText) return;

  const { display, truncated } = truncateLines(state.fullText, TRUNCATE_LINES);
  state.body.empty();

  // First render: show truncated or full content
  if (truncated && !state.showingFull) {
    renderTruncatedBody(state.body, display, () => showFullThinking(state));
  } else {
    state.body.textContent = state.fullText;
  }
}

/**
 * Show full thinking content when "Show all" is clicked.
 */
function showFullThinking(state: ThinkingState): void {
  state.showingFull = true;
  state.body.empty();
  state.body.textContent = state.fullText;
}

/**
 * Render truncated text with "Show all" link.
 */
function renderTruncatedBody(
  bodyEl: HTMLElement,
  displayText: string,
  onShowAll: () => void,
): void {
  const textEl = bodyEl.createDiv({ cls: 'co-ober-thinking-text' });
  textEl.textContent = displayText;

  const showAllBtn = bodyEl.createEl('button', {
    cls: 'co-ober-thinking-show-all',
    text: 'Show all ›',
  });
  showAllBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onShowAll();
    // After showing full content, scroll to see more
    bodyEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

/**
 * Append content to a live thinking block during streaming.
 */
export function appendThinkingContent(
  state: ThinkingState,
  content: string,
): void {
  state.fullText += content;
  // During streaming, don't re-render — StreamController handles that
}

/**
 * Finalize a live thinking block after completion.
 */
export function finalizeThinkingBlock(state: ThinkingState): number {
  // Stop timers
  if (state.timerInterval !== null) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.dotInterval !== null) {
    clearInterval(state.dotInterval);
    state.dotInterval = null;
  }

  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  state.labelEl.textContent = 'Thought';
  state.timerEl.textContent = `for ${elapsed}s`;

  // Remove dot indicator
  const dot = state.header.querySelector('.co-ober-thinking-dot');
  if (dot) dot.remove();

  // Store final full text in body (hidden until expanded)
  state.body.textContent = state.fullText;

  // Collapse after completion via unified collapsible
  collapseElement(state.wrapper, state.header, state.collapsibleState);
  state.wrapper.classList.remove('is-thinking');

  return elapsed;
}

/**
 * Render a stored (historical) thinking block from a past message.
 * Collapsed by default. On expand, truncates to TRUNCATE_LINES.
 */
export function renderStoredThinkingBlock(
  parentEl: HTMLElement,
  text: string,
  durationSeconds?: number,
): HTMLElement {
  const wrapper = parentEl.createDiv({ cls: 'co-ober-thinking-block' });

  const header = wrapper.createDiv({ cls: 'co-ober-thinking-header' });
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');

  const label = durationSeconds ? 'Thought' : 'Thinking';
  const durationText = durationSeconds
    ? `for ${durationSeconds}s`
    : '';
  header.createSpan({ cls: 'co-ober-thinking-label', text: label });
  if (durationText) {
    header.createSpan({ cls: 'co-ober-thinking-timer', text: durationText });
  }

  const body = wrapper.createDiv({ cls: 'co-ober-thinking-body' });
  body.textContent = text;

  let showFull = false;
  const collapsibleState: CollapsibleState = { isExpanded: false };

  setupCollapsible(wrapper, header, body, collapsibleState, {
    initiallyExpanded: false,
    baseAriaLabel: 'Extended thinking',
    scrollOnExpand: true,
    onExpand: () => {
      // On first expand, truncate long content
      const currentText = body.textContent || '';
      const { display, truncated } = truncateLines(currentText, TRUNCATE_LINES);
      if (truncated && !showFull) {
        body.empty();
        renderTruncatedBody(body, display, () => {
          body.empty();
          body.textContent = currentText;
          showFull = true;
          body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    },
  });

  return wrapper;
}

/**
 * Clean up a live thinking block to prevent memory leaks.
 */
export function cleanupThinkingBlock(state: ThinkingState): void {
  state.cleanup();
}
