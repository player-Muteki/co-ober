/**
 * Unified collapsible behavior — one pattern for all collapsible UI elements.
 *
 * Handles:
 * - Click to toggle
 * - Enter/Space keyboard navigation
 * - aria-expanded attribute
 * - CSS 'is-collapsed' class on wrapper
 * - Optional scrollOnExpand (scroll element into view on expand)
 * - Optional onToggle/onExpand callbacks
 * - Optional baseAriaLabel for auto-generated aria-label
 *
 * @since Phase 1 (refactored)
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CollapsibleState {
  isExpanded: boolean;
}

export interface CollapsibleOptions {
  /** Initial expanded state (default: false) */
  initiallyExpanded?: boolean;
  /** Callback when state changes */
  onToggle?: (isExpanded: boolean) => void;
  /** Callback when expanded (fires after state change + optional scroll) */
  onExpand?: (wrapperEl: HTMLElement) => void;
  /** Base label for aria-label (will append "click to expand/collapse") */
  baseAriaLabel?: string;
  /**
   * When true, scrolls the wrapper element into view on expand.
   * Uses `scrollIntoView({ behavior: 'smooth', block: 'nearest' })`.
   * Default: false
   */
  scrollOnExpand?: boolean;
}

/**
 * Setup collapsible behavior on a header/content pair.
 */
export function setupCollapsible(
  wrapperEl: HTMLElement,
  headerEl: HTMLElement,
  contentEl: HTMLElement,
  state: CollapsibleState,
  options: CollapsibleOptions = {},
): void {
  const { initiallyExpanded = false, onToggle, onExpand, baseAriaLabel, scrollOnExpand = false } = options;

  const updateAriaLabel = (expanded: boolean) => {
    if (baseAriaLabel) {
      const action = expanded ? 'click to collapse' : 'click to expand';
      headerEl.setAttribute('aria-label', `${baseAriaLabel} - ${action}`);
    }
  };

  // Set initial state
  state.isExpanded = initiallyExpanded;
  if (initiallyExpanded) {
    wrapperEl.removeClass('is-collapsed');
    headerEl.setAttribute('aria-expanded', 'true');
  } else {
    wrapperEl.addClass('is-collapsed');
    headerEl.setAttribute('aria-expanded', 'false');
  }
  updateAriaLabel(initiallyExpanded);

  const toggleExpand = () => {
    state.isExpanded = !state.isExpanded;
    if (state.isExpanded) {
      wrapperEl.removeClass('is-collapsed');
      headerEl.setAttribute('aria-expanded', 'true');
      // Scroll into view if requested
      if (scrollOnExpand) {
        wrapperEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      // Fire onExpand callback
      onExpand?.(wrapperEl);
    } else {
      wrapperEl.addClass('is-collapsed');
      headerEl.setAttribute('aria-expanded', 'false');
    }
    updateAriaLabel(state.isExpanded);
    onToggle?.(state.isExpanded);
  };

  headerEl.addEventListener('click', toggleExpand);
  headerEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });
}

/**
 * Programmatically collapse a collapsible and sync state.
 */
export function collapseElement(
  wrapperEl: HTMLElement,
  headerEl: HTMLElement,
  state: CollapsibleState,
): void {
  state.isExpanded = false;
  wrapperEl.addClass('is-collapsed');
  headerEl.setAttribute('aria-expanded', 'false');
}
