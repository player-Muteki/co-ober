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

import { t } from '../i18n/index';

/**
 * A header's aria-label base is often composed — the kind word plus the path or
 * summary it names — so a string resolved once cannot be re-spoken after the
 * locale changes. Headers built with a label keep their builder here, which is
 * how a collapse updates the action word and a locale switch updates the rest.
 */
const ariaBuilders = new WeakMap<HTMLElement, (expanded: boolean) => void>();

export interface CollapsibleState {
  isExpanded: boolean;
  /**
   * Set the first time the reader opens or shuts this block themselves.
   * Programmatic collapse — a turn boundary settling a card — is allowed to
   * close a block that came up open on its own, but not one the reader put
   * where it is.
   */
  userToggled?: boolean;
}
export interface CollapsibleOptions {
  /** Initial expanded state (default: false) */
  initiallyExpanded?: boolean;
  /** Callback when state changes */
  onToggle?: (isExpanded: boolean) => void;
  /** Callback when expanded (fires after state change + optional scroll) */
  onExpand?: (wrapperEl: HTMLElement) => void;
  /** Base label for aria-label (will append "click to expand/collapse") */
  baseAriaLabel?: string | (() => string);
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

  const actionWord = (expanded: boolean): string =>
    expanded ? t().collapsible.collapse : t().collapsible.expand;

  const updateAriaLabel = (expanded: boolean) => {
    if (baseAriaLabel === undefined) return;
    const base = typeof baseAriaLabel === 'function' ? baseAriaLabel() : baseAriaLabel;
    headerEl.setAttribute('aria-label', `${base} - ${actionWord(expanded)}`);
    // Tag the header so a locale switch relabels the live aria-label in place.
    headerEl.dataset.i18nToggle = base;
  };
  if (baseAriaLabel !== undefined) ariaBuilders.set(headerEl, updateAriaLabel);

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
    state.userToggled = true;
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
  // The action word has to follow the state it describes. It lives in the
  // aria-label only, and only the builder here can rewrite it: a card the
  // reader opened ("… - click to collapse") that the turn then settled invited
  // a click to collapse a block that was already collapsed.
  ariaBuilders.get(headerEl)?.(false);
}

/**
 * Re-speak every collapsible header under `root` in the current locale. A label
 * whose base was resolved when the element was created would otherwise keep
 * answering in that older language while the action word after it changed.
 */
export function relabelCollapsibleHeaders(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n-toggle]').forEach((el) => {
    const build = ariaBuilders.get(el);
    if (build) {
      build(el.getAttribute('aria-expanded') === 'true');
      return;
    }
    const expanded = el.getAttribute('aria-expanded') === 'true';
    el.setAttribute(
      'aria-label',
      `${el.dataset.i18nToggle ?? ''} - ${expanded ? t().collapsible.collapse : t().collapsible.expand}`,
    );
  });
}
