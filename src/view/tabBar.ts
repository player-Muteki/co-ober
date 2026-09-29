import type { TabDescriptor } from './CoOberViewController';
import { type Locale, t, onLocaleChange } from '../i18n/index';

/** Second click inside this window confirms closing a tab that is still generating. */
const CLOSE_CONFIRM_TIMEOUT_MS = 3000;

/** Which control inside the strip held the caret, so a rebuild can hand it back. */
type HeldFocus = { kind: 'tab' | 'close'; tabId: string } | { kind: 'new' } | null;

export interface TabBarCallbacks {
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
}

/**
 * Strip of open conversations under the header: the badge shows the position,
 * the tooltip the title, and a dot marks a tab generating out of view.
 */
export class TabBar {
  private readonly root: HTMLDivElement;
  private lastTabs: TabDescriptor[] = [];
  private lastMaxTabs = 0;
  private rendered = '';
  private renderedArmed = '';
  private renderedLocale: Locale | null = null;
  private readonly armed = new Map<string, number>();
  private readonly unsubscribeLocale: () => void;
  private disposed = false;

  constructor(
    containerEl: HTMLElement,
    private callbacks: TabBarCallbacks,
  ) {
    this.root = containerEl.createDiv({ cls: 'co-ober-tab-bar' });
    this.root.setAttribute('role', 'tablist');
    this.unsubscribeLocale = onLocaleChange(() => this.render(this.lastTabs, this.lastMaxTabs));
  }

  render(tabs: TabDescriptor[], maxTabs: number): void {
    if (this.disposed) return;
    this.lastTabs = tabs;
    this.lastMaxTabs = maxTabs;
    // Rebuilding empties the strip, which takes the caret with it, restarts the
    // generating pulse from zero and drops the place the reader had scrolled to.
    // A turn boundary — or a background tab's frame — repaints it with nothing
    // about it changed, so a strip that would come back identical is left alone.
    // An armed closing counts as content: a button showing ✓ is not the button
    // this same list was last painted with.
    const signature = this.describe(tabs, maxTabs);
    const armed = this.armedSignature();
    const locale = t();
    if (signature === this.rendered && armed === this.renderedArmed && locale === this.renderedLocale) return;
    this.rendered = signature;
    this.renderedArmed = armed;
    this.renderedLocale = locale;

    const root = this.root;
    const held = this.captureFocus();
    const scrollLeft = root.scrollLeft;
    root.empty();
    root.setAttribute('aria-label', t().tabs.tray);

    tabs.forEach((tab, i) => this.renderTab(root, tab, i, tabs));

    const add = root.createEl('button', { cls: 'co-ober-tab-new', text: '+' });
    add.setAttribute('aria-label', t().tabs.new);
    if (tabs.length >= maxTabs) {
      const limit = t().tabs.limitReached.replace('{max}', String(maxTabs));
      add.disabled = true;
      add.addClass('is-disabled');
      add.setAttribute('title', limit);
      // A disabled button still announces itself by its accessible name. Left as
      // "Open a new tab", a screen reader offered an action this button cannot
      // carry; the title already said why, so the name now says the same.
      add.setAttribute('aria-label', limit);
    }
    add.onclick = () => this.callbacks.onNew();

    root.scrollLeft = scrollLeft;
    this.restoreFocus(held);
  }

  dispose(): void {
    for (const timer of this.armed.values()) window.clearTimeout(timer);
    this.armed.clear();
    this.unsubscribeLocale();
    this.disposed = true;
    this.root.remove();
    this.lastTabs = [];
  }

  /** The badges and what each is doing — everything a repaint would redo. */
  private describe(tabs: TabDescriptor[], maxTabs: number): string {
    const marks = tabs
      .map((tab) => `${tab.tabId}:${tab.active}${tab.streaming}${tab.queued}${tab.unread}${tab.title}`)
      .join('|');
    return `${maxTabs}\u0000${marks}`;
  }

  /** Which closing buttons are currently showing ✓ — a painted difference. */
  private armedSignature(): string {
    return [...this.armed.keys()].sort().join(',');
  }

  private captureFocus(): HeldFocus {
    const active = this.root.ownerDocument?.activeElement;
    if (!active || !this.root.contains(active)) return null;
    if (active.closest('.co-ober-tab-new')) return { kind: 'new' };
    const close = active.closest('.co-ober-tab-close');
    const badge = active.closest<HTMLElement>('.co-ober-tab');
    const tabId = badge?.dataset.tabId;
    if (!tabId) return null;
    return { kind: close ? 'close' : 'tab', tabId };
  }

  private restoreFocus(held: HeldFocus): void {
    if (!held) return;
    if (held.kind === 'new') {
      const add = this.root.querySelector<HTMLButtonElement>('.co-ober-tab-new');
      if (add && !add.disabled) add.focus();
      return;
    }
    const badge = this.root.querySelector<HTMLElement>(`.co-ober-tab[data-tab-id="${cssEscape(held.tabId)}"]`);
    if (!badge) return;
    if (held.kind === 'close') {
      badge.querySelector<HTMLElement>('.co-ober-tab-close')?.focus();
      return;
    }
    badge.focus();
  }

  private renderTab(root: HTMLElement, tab: TabDescriptor, index: number, tabs: TabDescriptor[]): void {
    const number = index + 1;
    const badge = root.createDiv({ cls: 'co-ober-tab' });
    badge.dataset.tabId = tab.tabId;
    badge.setAttribute('role', 'tab');
    badge.setAttribute('aria-selected', String(tab.active));
    badge.tabIndex = tab.active ? 0 : -1;
    if (tab.active) badge.addClass('is-active');
    if (tab.streaming) badge.addClass('is-streaming');
    if (tab.queued) badge.addClass('is-queued');
    if (tab.unread) badge.addClass('is-unread');

    let status = '';
    if (tab.streaming && tab.queued) {
      // Both hold whenever a prompt is queued while an answer is streaming: the
      // tab is working AND has work waiting for a slot. Naming only the wait
      // introduced a tab that was generating as one standing by, in the title
      // and to the screen reader that reads the pulse as hidden.
      status = t().tabs.streamingQueued;
    } else if (tab.queued) status = t().tabs.waitingSlot.replace('{index}', String(number));
    else if (tab.streaming) status = t().tabs.streaming;
    else if (tab.unread) status = t().tabs.unread.replace('{index}', String(number));

    badge.setAttribute('title', status ? `${tab.title} — ${status}` : tab.title);
    const switchTo = t().tabs.switchTo.replace('{index}', String(number));
    badge.setAttribute('aria-label', status ? `${switchTo}: ${status}` : switchTo);
    badge.createDiv({ cls: 'co-ober-tab-number', text: String(number) });
    if (tab.streaming) {
      const pulse = badge.createDiv({ cls: 'co-ober-tab-pulse' });
      pulse.setAttribute('aria-hidden', 'true');
    }

    badge.onclick = () => {
      if (!tab.active) this.callbacks.onSelect(tab.tabId);
    };
    badge.onkeydown = (e: KeyboardEvent) => this.onTabKey(e, tab, index, tabs);

    const close = badge.createEl('button', { cls: 'co-ober-tab-close', text: '×' });
    const label = t().tabs.close.replace('{index}', String(number));
    close.setAttribute('aria-label', label);
    if (this.armed.has(tab.tabId)) this.paintArmed(close);
    close.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      if (tab.streaming && !this.armed.has(tab.tabId)) {
        this.armClose(tab.tabId, close);
        return;
      }
      this.disarmClose(tab.tabId);
      this.callbacks.onClose(tab.tabId);
    };
  }

  /** Arrow keys walk the strip; Enter/Space take focus, which never cancels a stream. */
  private onTabKey(e: KeyboardEvent, tab: TabDescriptor, index: number, tabs: TabDescriptor[]): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!tab.active) this.callbacks.onSelect(tab.tabId);
      // Activating rebuilds the strip, so the badge this key was pressed on no
      // longer exists; the arrow keys already land the reader on its successor
      // and this keeps Enter from dropping the caret onto the document instead —
      // from there the next arrow key reached nothing.
      this.focusTab(tab.tabId);
      return;
    }
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (!next) return;
    this.callbacks.onSelect(next.tabId);
    // Activation rerenders the strip, so the badge to land on is the new one.
    this.focusTab(next.tabId);
  }

  private focusTab(tabId: string): void {
    this.root.querySelector<HTMLElement>(`.co-ober-tab[data-tab-id="${cssEscape(tabId)}"]`)?.focus();
  }

  private armClose(tabId: string, button: HTMLElement): void {
    this.paintArmed(button);
    const timer = window.setTimeout(() => {
      this.armed.delete(tabId);
      this.render(this.lastTabs, this.lastMaxTabs);
    }, CLOSE_CONFIRM_TIMEOUT_MS);
    this.armed.set(tabId, timer);
    // The ✓ was painted outside render(), so the same list the strip was built
    // from is now stale. Forgetting this leaves the timeout's rebuild convinced
    // nothing changed, and the confirmation sits there after its window closed.
    this.renderedArmed = this.armedSignature();
  }

  private disarmClose(tabId: string): void {
    const timer = this.armed.get(tabId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.armed.delete(tabId);
  }

  private paintArmed(button: HTMLElement): void {
    button.addClass('is-confirm');
    button.setText('✓');
    button.setAttribute('aria-label', t().tabs.closeStreaming);
    button.setAttribute('title', t().tabs.closeStreaming);
  }
}

/** Tab ids are internally minted (`tab-<n>`), but keep the selector quote-proof. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
