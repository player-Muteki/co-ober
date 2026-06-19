/**
 * Reusable collapsible component.
 * Provides ARIA-compliant toggle behaviour for foldable UI sections.
 *
 * @since Phase 1
 */

export interface CollapsibleOptions {
  /** CSS class added to the wrapper when collapsed (default: 'is-collapsed') */
  collapsedClass?: string;
  /** ARIA label for the toggle button region */
  ariaLabel?: string;
  /** Called after each state change */
  onToggle?: (collapsed: boolean) => void;
}

const DEFAULT_OPTIONS: CollapsibleOptions = {
  collapsedClass: 'is-collapsed',
};

/**
 * Set up a collapsible section. The header acts as the toggle trigger.
 * Returns a cleanup function.
 */
export function setupCollapsible(
  wrapper: HTMLElement,
  header: HTMLElement,
  content: HTMLElement,
  collapsed: boolean,
  options?: CollapsibleOptions,
): () => void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const collapsedClass = opts.collapsedClass!;

  // Initial state
  if (collapsed) {
    wrapper.classList.add(collapsedClass);
  } else {
    wrapper.classList.remove(collapsedClass);
  }

  // ARIA attributes
  const contentId = `collapsible-content-${Math.random().toString(36).slice(2, 8)}`;
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', String(!collapsed));
  header.setAttribute('aria-controls', contentId);
  if (opts.ariaLabel) {
    header.setAttribute('aria-label', opts.ariaLabel);
  }
  content.id = contentId;
  content.setAttribute('role', 'region');

  const toggle = (): void => {
    const isCollapsed = wrapper.classList.contains(collapsedClass);
    if (isCollapsed) {
      wrapper.classList.remove(collapsedClass);
      header.setAttribute('aria-expanded', 'true');
    } else {
      wrapper.classList.add(collapsedClass);
      header.setAttribute('aria-expanded', 'false');
    }
    opts.onToggle?.(!isCollapsed);
  };

  // Click handler
  const clickHandler = (e: MouseEvent): void => {
    // Don't toggle if user clicked a link or button inside header
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select')) return;
    toggle();
  };
  header.addEventListener('click', clickHandler);

  // Keyboard handler
  const keyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };
  header.addEventListener('keydown', keyHandler);

  // Cleanup
  return () => {
    header.removeEventListener('click', clickHandler);
    header.removeEventListener('keydown', keyHandler);
  };
}

/**
 * Programmatically collapse or expand a collapsible section.
 */
export function collapseElement(
  wrapper: HTMLElement,
  header: HTMLElement,
  _content: HTMLElement,
  collapsed: boolean,
  collapsedClass?: string,
): void {
  const cls = collapsedClass ?? 'is-collapsed';
  if (collapsed) {
    wrapper.classList.add(cls);
    header.setAttribute('aria-expanded', 'false');
  } else {
    wrapper.classList.remove(cls);
    header.setAttribute('aria-expanded', 'true');
  }
}
