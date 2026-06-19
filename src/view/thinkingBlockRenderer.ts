/**
 * Thinking-block renderer with a live timer and auto-collapse on completion.
 *
 * Live timer: "Thinking 0s…" → "Thinking 12s…"
 * On completion: auto-collapse, label becomes "Thought for 12s"
 * Animated dot indicator, auto-expand after 10s if still running.
 *
 * @since Phase 1
 */

const ANIMATION_INTERVAL_MS = 500;  // dot animation tick
const AUTO_EXPAND_MS = 10_000;      // expand after 10s if still thinking

export interface ThinkingState {
  wrapper: HTMLElement;
  header: HTMLElement;
  labelEl: HTMLElement;
  body: HTMLElement;
  timerEl: HTMLElement;
  startTime: number;
  timerInterval: ReturnType<typeof setInterval> | null;
  dotInterval: ReturnType<typeof setInterval> | null;
  autoExpandTimer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

const DOT_CHARS = ['·', '··', '···'];

/**
 * Create a live thinking block and start the timer + dot animation.
 * Returns a ThinkingState that must be cleaned up via cleanupThinkingBlock().
 */
export function renderLiveThinkingBlock(
  parentEl: HTMLElement,
): ThinkingState {
  const wrapper = parentEl.createDiv({ cls: 'co-ober-thinking-block' });
  wrapper.classList.add('is-thinking');

  const header = wrapper.createDiv({ cls: 'co-ober-thinking-header' });
  const labelEl = header.createSpan({ cls: 'co-ober-thinking-label', text: 'Thinking' });
  const timerEl = header.createSpan({ cls: 'co-ober-thinking-timer', text: '0s' });
  const dotEl = header.createSpan({ cls: 'co-ober-thinking-dot', text: '···' });

  const body = wrapper.createDiv({ cls: 'co-ober-thinking-body' });

  const state: ThinkingState = {
    wrapper,
    header,
    labelEl,
    body,
    timerEl,
    startTime: Date.now(),
    timerInterval: null,
    dotInterval: null,
    autoExpandTimer: null,
    cleanup: () => {},
  };

  // Live timer: update every second
  state.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    state.timerEl.textContent = `${elapsed}s`;
  }, 1000);

  // Dot animation: cycle every 500ms
  let dotIndex = 0;
  state.dotInterval = setInterval(() => {
    dotIndex = (dotIndex + 1) % DOT_CHARS.length;
    dotEl.textContent = DOT_CHARS[dotIndex];
  }, ANIMATION_INTERVAL_MS);

  // Auto-expand after 10 seconds
  state.autoExpandTimer = setTimeout(() => {
    wrapper.classList.remove('is-collapsed');
  }, AUTO_EXPAND_MS);
  wrapper.classList.add('is-collapsed');

  // ARIA setup
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');
  const toggle = (): void => {
    const collapsed = wrapper.classList.contains('is-collapsed');
    if (collapsed) {
      wrapper.classList.remove('is-collapsed');
      header.setAttribute('aria-expanded', 'true');
    } else {
      wrapper.classList.add('is-collapsed');
      header.setAttribute('aria-expanded', 'false');
    }
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  state.cleanup = () => {
    if (state.timerInterval !== null) clearInterval(state.timerInterval);
    if (state.dotInterval !== null) clearInterval(state.dotInterval);
    if (state.autoExpandTimer !== null) clearTimeout(state.autoExpandTimer);
    header.removeEventListener('click', toggle);
  };

  return state;
}

/**
 * Finalize a live thinking block after completion.
 * Stops timers, collapses, updates label to "Thought for Xs".
 */
export function finalizeThinkingBlock(state: ThinkingState): void {
  // Stop timers
  if (state.timerInterval !== null) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.dotInterval !== null) {
    clearInterval(state.dotInterval);
    state.dotInterval = null;
  }
  if (state.autoExpandTimer !== null) {
    clearTimeout(state.autoExpandTimer);
    state.autoExpandTimer = null;
  }

  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  state.labelEl.textContent = 'Thought';
  state.timerEl.textContent = `for ${elapsed}s`;

  // Remove dot indicator
  const dot = state.header.querySelector('.co-ober-thinking-dot');
  if (dot) dot.remove();

  // Collapse after completion
  state.wrapper.classList.add('is-collapsed');
  state.wrapper.classList.remove('is-thinking');
  state.header.setAttribute('aria-expanded', 'false');
}

/**
 * Render a stored (historical) thinking block from a past message.
 * Shows "Thought for Xs" with the stored duration, collapsed by default.
 */
export function renderStoredThinkingBlock(
  parentEl: HTMLElement,
  text: string,
  durationSeconds?: number,
): HTMLElement {
  const wrapper = parentEl.createDiv({ cls: 'co-ober-thinking-block' });
  wrapper.classList.add('is-collapsed');

  const header = wrapper.createDiv({ cls: 'co-ober-thinking-header' });
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

  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');

  const toggle = (): void => {
    wrapper.classList.toggle('is-collapsed');
    header.setAttribute(
      'aria-expanded',
      String(!wrapper.classList.contains('is-collapsed')),
    );
  };
  header.addEventListener('click', toggle);
  header.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return wrapper;
}

/**
 * Clean up a live thinking block to prevent memory leaks.
 */
export function cleanupThinkingBlock(state: ThinkingState): void {
  state.cleanup();
}
