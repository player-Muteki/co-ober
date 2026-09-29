// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
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

  it('names a tab that is generating with work still queued as generating, not idle', () => {
    const { container } = createBar([tab({ tabId: 'tab-1', streaming: true, queued: true })]);
    const badge = badges(container)[0];
    // Both flags hold while a prompt waits behind a streaming answer. Saying
    // only "waiting for a slot" introduced a working tab as one standing by.
    expect(badge.getAttribute('title')).toBe(`Chat tab-1 — ${t().tabs.streamingQueued}`);
    expect(badge.getAttribute('aria-label')).toContain(t().tabs.streamingQueued);
    expect(badge.classList.contains('is-streaming')).toBe(true);
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

  describe('the caret after a keyboard activation', () => {
    const key = (el: HTMLElement, k: string): void => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    };

    function rebuildOnSelect(tabs: TabDescriptor[]) {
      const created = createBar(tabs);
      created.callbacks.onSelect.mockImplementation((tabId: unknown) => {
        created.bar.render(
          tabs.map((t) => ({ ...t, active: t.tabId === tabId })),
          6,
        );
      });
      return created;
    }

    it('stays on the badge Enter moved the conversation to, once the strip was rebuilt', () => {
      const tabs = [tab({ tabId: 'tab-1', active: true }), tab({ tabId: 'tab-2' })];
      const { container } = rebuildOnSelect(tabs);

      badges(container)[1].focus();
      key(badges(container)[1], 'Enter');

      // Activating rerenders the strip, so the element that held focus no longer
      // exists; without picking the caret back up it fell to the document and the
      // next arrow key reached nothing — the reader was left outside the strip
      // looking at a tab they could not leave.
      expect(container.ownerDocument.activeElement?.getAttribute('data-tab-id')).toBe('tab-2');
    });

    it('stays put when Enter lands on the tab already in front', () => {
      const tabs = [tab({ tabId: 'tab-1', active: true }), tab({ tabId: 'tab-2' })];
      const { container, callbacks } = rebuildOnSelect(tabs);

      badges(container)[0].focus();
      key(badges(container)[0], ' ');

      expect(callbacks.onSelect).not.toHaveBeenCalled();
      expect(container.ownerDocument.activeElement?.getAttribute('data-tab-id')).toBe('tab-1');
    });
  });

  it('styles the state it applies, so a parked tab is not left looking idle', () => {
    const css = readFileSync('styles/main.css', 'utf8');

    // The strip puts is-queued on a turn waiting for the shared slot. With no
    // rule behind it the badge looked exactly like an idle one while its own
    // tooltip promised a slot, so a state the code tracks never reached the eye.
    // The dim is scoped :not(.is-streaming): a tab that carries both classes is
    // working, and painting it the waiting-slot look contradicted its pulse and
    // its "generating, more queued" name. So a waiting tab still gets a rule —
    // but never one that reaches past into a streaming tab.
    expect(css).toMatch(/\.co-ober-tab\.is-queued:not\(\.is-streaming\)\s*\{/);
    expect(css).not.toMatch(/\.co-ober-tab\.is-queued\s*\{[^}]*opacity:/);
  });

  it('closes an idle tab with a single click', () => {    const { container, callbacks } = createBar([tab({ tabId: 'tab-1' })]);

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

  it('drops the stale confirm once the turn the tab was armed for has ended', () => {
    const { bar, container, callbacks } = createBar([tab({ tabId: 'tab-1', streaming: true })]);
    closeButtons(container)[0].click();
    expect(closeButtons(container)[0].textContent).toBe('✓');
    callbacks.onClose.mockClear();

    // The agent answers, so the tab stops generating before the confirm's timer
    // runs out. The arm still holds the id, but re-painting its ✓ would claim a
    // stream to stop and a two-step press that the finished turn no longer has.
    bar.render([tab({ tabId: 'tab-1', streaming: false })], 6);

    const close = closeButtons(container)[0];
    expect(close.textContent).toBe('×');
    expect(close.classList.contains('is-confirm')).toBe(false);
    // And one press now closes — the confirm it stopped advertising is genuinely
    // gone, not merely mislabelled.
    close.click();
    expect(callbacks.onClose).toHaveBeenCalledWith('tab-1');
  });

  describe('the strip under a repaint it did not need', () => {
    const tabList = (): TabDescriptor[] => [
      tab({ tabId: 'tab-1', active: true }),
      tab({ tabId: 'tab-2' }),
      tab({ tabId: 'tab-3', unread: true }),
    ];

    it('leaves the badges standing when nothing about the list changed', () => {
      const { bar, container } = createBar(tabList());
      const badgesBefore = badges(container);
      badgesBefore[0].focus();

      // A turn boundary repaints every open tab, most of them unchanged. Rebuilding
      // those strips restarted the generating pulse from zero and took the caret
      // out of the reader's hands for a repaint with nothing to show.
      bar.render(tabList(), 6);

      expect(badges(container)).toEqual(badgesBefore);
      expect(container.ownerDocument.activeElement).toBe(badgesBefore[0]);
    });

    it('hands the caret back to the badge it was on', () => {
      const { bar, container } = createBar(tabList());
      badges(container)[1].focus();

      bar.render(
        tabList().map((t2) => (t2.tabId === 'tab-2' ? { ...t2, streaming: true } : t2)),
        6,
      );

      expect(container.ownerDocument.activeElement?.getAttribute('data-tab-id')).toBe('tab-2');
    });

    it('hands the caret back to the close button it was on', () => {
      const { bar, container } = createBar(tabList());
      closeButtons(container)[2].focus();

      bar.render(
        tabList().map((t2) => (t2.tabId === 'tab-1' ? { ...t2, streaming: true } : t2)),
        6,
      );

      const active = container.ownerDocument.activeElement;
      expect(active?.classList.contains('co-ober-tab-close')).toBe(true);
      expect(active?.closest('[data-tab-id]')?.getAttribute('data-tab-id')).toBe('tab-3');
    });

    it('hands the caret back to the new-tab button', () => {
      const { bar, container } = createBar(tabList());
      const add = container.querySelector<HTMLElement>('.co-ober-tab-new');
      add?.focus();

      bar.render([...tabList(), tab({ tabId: 'tab-4' })], 6);

      const after = container.querySelector<HTMLElement>('.co-ober-tab-new');
      expect(after).not.toBe(add);
      expect(container.ownerDocument.activeElement).toBe(after);
    });

    it('does not take the caret when it was never in the strip', () => {
      const { bar, container } = createBar(tabList());
      const outside = document.createElement('input');
      document.body.appendChild(outside);
      outside.focus();

      bar.render(
        tabList().map((t2) => (t2.tabId === 'tab-2' ? { ...t2, unread: true } : t2)),
        6,
      );

      // A reader typing in the composer, or selecting text in another panel, has
      // nothing to do with the strip; stealing their caret each turn would leave
      // them typing into a tab badge.
      expect(container.ownerDocument.activeElement).toBe(outside);
    });

    it('leaves the caret alone when the button it held is gone', () => {
      const { bar, container } = createBar(tabList());
      container.querySelector<HTMLElement>('.co-ober-tab-new')?.focus();

      bar.render(tabList(), 1);

      expect(container.ownerDocument.activeElement).not.toBe(container.querySelector('.co-ober-tab-new'));
    });

    it('keeps the strip at the position the reader scrolled to', () => {
      const { bar, container } = createBar(tabList());
      const root = container.querySelector<HTMLElement>('.co-ober-tab-bar');
      if (!root) throw new Error('missing tab bar root');
      root.scrollLeft = 120;

      bar.render([...tabList(), tab({ tabId: 'tab-4' })], 6);

      expect(container.querySelector<HTMLElement>('.co-ober-tab-bar')?.scrollLeft).toBe(120);
    });
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

  it('names the add button by what it can actually do', () => {
    // Under the limit the button really opens a tab, so it says so. At the
    // limit it is disabled and cannot, but its accessible name still promised
    // "Open a new tab" — a screen reader offered an action with no effect. The
    // name now follows the disabled state, matching the title.
    const under = createBar([tab({ tabId: 'tab-1' })], 3);
    expect(under.container.querySelector('.co-ober-tab-new')?.getAttribute('aria-label')).toBe(t().tabs.new);

    const full = createBar([tab({ tabId: 'a' }), tab({ tabId: 'b' }), tab({ tabId: 'c' })], 3);
    const add = full.container.querySelector('.co-ober-tab-new');
    expect(add?.getAttribute('aria-label')).toBe(t().tabs.limitReached.replace('{max}', '3'));
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
