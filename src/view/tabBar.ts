import type { TabDescriptor } from './CoOberViewController';
import { t, onLocaleChange } from '../i18n/index';

/** Second click inside this window confirms closing a tab that is still generating. */
const CLOSE_CONFIRM_TIMEOUT_MS = 3000;

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
    const root = this.root;
    root.empty();
    root.setAttribute('aria-label', t().tabs.tray);

    tabs.forEach((tab, i) => this.renderTab(root, tab, i, tabs));

    const add = root.createEl('button', { cls: 'co-ober-tab-new', text: '+' });
    add.setAttribute('aria-label', t().tabs.new);
    if (tabs.length >= maxTabs) {
      add.disabled = true;
      add.addClass('is-disabled');
      add.setAttribute('title', t().tabs.limitReached.replace('{max}', String(maxTabs)));
    }
    add.onclick = () => this.callbacks.onNew();
  }

  dispose(): void {
    for (const timer of this.armed.values()) window.clearTimeout(timer);
    this.armed.clear();
    this.unsubscribeLocale();
    this.disposed = true;
    this.root.remove();
    this.lastTabs = [];
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
    if (tab.queued) status = t().tabs.waitingSlot.replace('{index}', String(number));
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
