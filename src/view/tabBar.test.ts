// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TabBar } from './tabBar';
import type { TabDescriptor } from './CoOberViewController';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale, t } from '../i18n/index';

installObsidianDomHelpers();

function tab(overrides: Partial<TabDescriptor> & { tabId: string }): TabDescriptor {
  return {
    index: 0,
    title: `Chat ${overrides.tabId}`,
    streaming: false,
    queued: false,
    unread: false,
    active: false,
    ...overrides,
  };
}

function createBar(tabs: TabDescriptor[], maxTabs = 6) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const callbacks = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
  };
  const bar = new TabBar(container, callbacks);
  bar.render(tabs, maxTabs);
  return { bar, container, callbacks };
}

const badges = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.co-ober-tab'));
const closeButtons = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('.co-ober-tab-close'));

describe('TabBar', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('renders one numbered badge per tab under a tablist', () => {
    const { container } = createBar([tab({ tabId: 'tab-1' }), tab({ tabId: 'tab-2' })]);
    const root = container.querySelector('.co-ober-tab-bar');

    expect(root?.getAttribute('role')).toBe('tablist');
    expect(root?.getAttribute('aria-label')).toBe(t().tabs.tray);
    expect(badges(container).map((el) => el.querySelector('.co-ober-tab-number')?.textContent)).toEqual(['1', '2']);
    expect(badges(container)[1].dataset.tabId).toBe('tab-2');
  });

  it('marks only the active badge as selected and roving-focused', () => {
    const { container } = createBar([tab({ tabId: 'tab-1', active: true }), tab({ tabId: 'tab-2' })]);

    expect(badges(container)[0].getAttribute('aria-selected')).toBe('true');
    expect(badges(container)[0].tabIndex).toBe(0);
    expect(badges(container)[1].getAttribute('aria-selected')).toBe('false');
    expect(badges(container)[1].tabIndex).toBe(-1);
  });

  it('tooltips the conversation title and appends what the tab is doing', () => {
    const { container } = createBar([
      tab({ tabId: 'tab-1', title: 'Thesis draft' }),
      tab({ tabId: 'tab-2', streaming: true }),
      tab({ tabId: 'tab-3', queued: true }),
      tab({ tabId: 'tab-4', unread: true }),
    ]);
    const titles = badges(container).map((el) => el.getAttribute('title'));

    expect(titles[0]).toBe('Thesis draft');
    expect(titles[1]).toBe(`Chat tab-2 — ${t().tabs.streaming}`);
    expect(titles[2]).toBe(`Chat tab-3 — ${t().tabs.waitingSlot.replace('{index}', '3')}`);
    expect(titles[3]).toBe(`Chat tab-4 — ${t().tabs.unread.replace('{index}', '4')}`);
  });

  it('shows a pulse and state class only while generating', () => {
    const { container } = createBar([tab({ tabId: 'tab-1', streaming: true }), tab({ tabId: 'tab-2', unread: true })]);

    expect(badges(container)[0].classList.contains('is-streaming')).toBe(true);
    expect(badges(container)[0].querySelector('.co-ober-tab-pulse')).not.toBeNull();
    expect(badges(container)[1].querySelector('.co-ober-tab-pulse')).toBeNull();
    expect(badges(container)[1].classList.contains('is-unread')).toBe(true);
  });

  it('selects a hidden tab without touching the one already in front', () => {
    const { container, callbacks } = createBar([tab({ tabId: 'tab-1', active: true }), tab({ tabId: 'tab-2' })]);

    badges(container)[1].click();
    badges(container)[0].click();

    expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
    expect(callbacks.onSelect).toHaveBeenCalledWith('tab-2');
  });

  it('walks the strip with the arrow keys', () => {
    const { container, callbacks } = createBar([tab({ tabId: 'tab-1' }), tab({ tabId: 'tab-2' })]);
    const key = (el: HTMLElement, k: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    };

    key(badges(container)[0], 'ArrowRight');
    key(badges(container)[1], 'ArrowRight');
    key(badges(container)[0], 'Enter');

    expect(callbacks.onSelect.mock.calls.map((c) => c[0])).toEqual(['tab-2', 'tab-1', 'tab-1']);
  });

  it('closes an idle tab with a single click', () => {
    const { container, callbacks } = createBar([tab({ tabId: 'tab-1' })]);

    closeButtons(container)[0].click();

    expect(callbacks.onClose).toHaveBeenCalledWith('tab-1');
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it('asks a streaming tab to confirm, then closes it', () => {
    const { container, callbacks } = createBar([tab({ tabId: 'tab-1', streaming: true })]);
    const close = closeButtons(container)[0];

    close.click();

    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(close.classList.contains('is-confirm')).toBe(true);
    expect(close.textContent).toBe('✓');
    expect(close.getAttribute('title')).toBe(t().tabs.closeStreaming);

    close.click();

    expect(callbacks.onClose).toHaveBeenCalledWith('tab-1');
  });

  it('forgets the confirmation when the second click never comes', () => {
    vi.useFakeTimers();
    const { container, callbacks } = createBar([tab({ tabId: 'tab-1', streaming: true })]);

    closeButtons(container)[0].click();
    vi.advanceTimersByTime(4000);

    expect(closeButtons(container)[0].textContent).toBe('×');
    expect(closeButtons(container)[0].classList.contains('is-confirm')).toBe(false);

    closeButtons(container)[0].click();

    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(closeButtons(container)[0].classList.contains('is-confirm')).toBe(true);
  });

  it('keeps the armed confirmation through a repaint', () => {
    const { bar, container, callbacks } = createBar([tab({ tabId: 'tab-1', streaming: true })]);

    closeButtons(container)[0].click();
    callbacks.onClose.mockClear();
    // A turn boundary repaints the strip while the user is reaching for it.
    bar.render([tab({ tabId: 'tab-1', streaming: true, unread: true })], 6);

    expect(closeButtons(container)[0].classList.contains('is-confirm')).toBe(true);
    closeButtons(container)[0].click();
    expect(callbacks.onClose).toHaveBeenCalledWith('tab-1');
  });

  it('opens new tabs and refuses past the limit', () => {
    const under = createBar([tab({ tabId: 'tab-1' })], 3);
    under.container.querySelector<HTMLElement>('.co-ober-tab-new')?.click();
    expect(under.callbacks.onNew).toHaveBeenCalled();

    const full = createBar([tab({ tabId: 'tab-1' }), tab({ tabId: 'tab-2' }), tab({ tabId: 'tab-3' })], 3);
    const add = full.container.querySelector<HTMLButtonElement>('.co-ober-tab-new');

    expect(add?.disabled).toBe(true);
    expect(add?.getAttribute('title')).toBe(t().tabs.limitReached.replace('{max}', '3'));
    add?.click();
    expect(full.callbacks.onNew).not.toHaveBeenCalled();
  });

  it('relabels itself when the locale changes', () => {
    const { container } = createBar([tab({ tabId: 'tab-1', active: true, unread: true })]);
    expect(badges(container)[0].getAttribute('title')).toBe(`Chat tab-1 — tab 1 finished while hidden`);

    setLocale('zh');

    expect(badges(container)[0].getAttribute('aria-label')).toContain('切换到标签 1');
    expect(container.querySelector('.co-ober-tab-new')?.getAttribute('aria-label')).toBe(t().tabs.new);
    setLocale('en');
  });

  it('goes away on dispose and ignores later renders', () => {
    const { bar, container } = createBar([tab({ tabId: 'tab-1' })]);

    bar.dispose();
    bar.render([tab({ tabId: 'tab-2' })], 6);

    expect(container.querySelector('.co-ober-tab-bar')).toBeNull();
  });
});
