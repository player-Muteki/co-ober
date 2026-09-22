// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Notice } from '../test/obsidianMock';
import { SessionDropdown } from './sessionDropdown';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

describe('SessionDropdown', () => {
  let container: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let sessionStore: {
    list: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let callbacks: {
    onSwitch: ReturnType<typeof vi.fn>;
    onDelete: ReturnType<typeof vi.fn>;
    onNewSession: ReturnType<typeof vi.fn>;
  };
  let dropdown: SessionDropdown;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    anchor = document.createElement('button');
    document.body.appendChild(container);
    document.body.appendChild(anchor);

    sessionStore = {
      list: vi.fn().mockReturnValue([
        { sessionId: 'session-1', title: 'Chat 1' },
        { sessionId: 'session-2', title: 'Chat 2' },
        { sessionId: 'session-3', title: 'Chat 3' },
      ]),
      remove: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };

    callbacks = {
      onSwitch: vi.fn().mockResolvedValue(undefined),
      onDelete: vi.fn().mockResolvedValue(undefined),
      onNewSession: vi.fn().mockResolvedValue(undefined),
    };

    dropdown = new SessionDropdown(
      container,
      anchor,
      sessionStore as any,
      () => 'session-1',
      callbacks as any,
      () => ({ sessionCapabilities: { close: true, fork: true, list: true, resume: true } }),
    );
  });

  describe('open', () => {
    it('creates dropdown element', () => {
      dropdown.open();
      const dropdownEl = container.querySelector('.co-ober-session-list');
      expect(dropdownEl).not.toBeNull();
    });

    it('creates search input', () => {
      dropdown.open();
      const search = container.querySelector('.co-ober-session-search') as HTMLInputElement;
      expect(search).not.toBeNull();
      expect(search.placeholder).toBe('Search sessions…');
    });

    it('renders all sessions', () => {
      dropdown.open();
      const items = container.querySelectorAll('.co-ober-session-item');
      expect(items.length).toBe(3);
    });

    it('marks current session as active', () => {
      dropdown.open();
      const activeItem = container.querySelector('.co-ober-session-item.active');
      expect(activeItem).not.toBeNull();
      expect(activeItem?.querySelector('.session-label')?.textContent).toBe('Chat 1');
    });

    it('shows empty message when no sessions', () => {
      sessionStore.list.mockReturnValue([]);
      dropdown.open();
      const empty = container.querySelector('.co-ober-session-empty');
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toBe('No sessions found');
    });

    it('closes if already open', () => {
      dropdown.open();
      dropdown.open();
      const items = container.querySelectorAll('.co-ober-session-list');
      expect(items.length).toBe(0);
    });

    it('disables fork, resume, and close controls when capabilities are missing', () => {
      dropdown = new SessionDropdown(container, anchor, sessionStore as any, () => 'session-1', callbacks as any, () => ({ sessionCapabilities: {} }));
      dropdown.open();
      expect((container.querySelector('.session-fork') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('.session-resume') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('.session-delete') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables only fork when only fork capability is true', () => {
      dropdown = new SessionDropdown(container, anchor, sessionStore as any, () => 'session-1', callbacks as any, () => ({ sessionCapabilities: { fork: true } }));
      dropdown.open();
      expect((container.querySelector('.session-fork') as HTMLButtonElement).disabled).toBe(false);
      expect((container.querySelector('.session-resume') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('.session-delete') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables resume and close when those capabilities are true', () => {
      dropdown = new SessionDropdown(container, anchor, sessionStore as any, () => 'session-1', callbacks as any, () => ({ sessionCapabilities: { resume: true, close: true } }));
      dropdown.open();
      expect((container.querySelector('.session-fork') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('.session-resume') as HTMLButtonElement).disabled).toBe(false);
      expect((container.querySelector('.session-delete') as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows only current session and no search when list capability is false', () => {
      dropdown = new SessionDropdown(container, anchor, sessionStore as any, () => 'session-2', callbacks as any, () => ({ sessionCapabilities: { list: false, close: true, fork: true, resume: true } }));
      dropdown.open();
      expect(container.querySelector('.co-ober-session-search')).toBeNull();
      const items = container.querySelectorAll('.co-ober-session-item');
      expect(items.length).toBe(1);
      expect(items[0].querySelector('.session-label')?.textContent).toBe('Chat 2');
    });
  });

  describe('close', () => {
    it('removes dropdown element', () => {
      dropdown.open();
      dropdown.close();
      const dropdownEl = container.querySelector('.co-ober-session-list');
      expect(dropdownEl).toBeNull();
    });

    it('does nothing if not open', () => {
      dropdown.close();
      // Should not throw
    });
  });

  describe('isOpen', () => {
    it('returns false initially', () => {
      expect(dropdown.isOpen()).toBe(false);
    });

    it('returns true after open', () => {
      dropdown.open();
      expect(dropdown.isOpen()).toBe(true);
    });

    it('returns false after close', () => {
      dropdown.open();
      dropdown.close();
      expect(dropdown.isOpen()).toBe(false);
    });
  });

  describe('session interactions', () => {
    it('calls onSwitch when clicking a session', async () => {
      dropdown.open();
      const items = container.querySelectorAll('.co-ober-session-item');
      (items[1] as HTMLElement).click();
      await new Promise(r => setTimeout(r, 10));
      expect(callbacks.onSwitch).toHaveBeenCalledWith('session-2', 'local');
    });

    it('calls onNewSession when deleting current session', async () => {
      dropdown.open();
      const deleteBtn = container.querySelector('.co-ober-session-item.active .session-delete') as HTMLElement;
      deleteBtn.click();
      await new Promise(r => setTimeout(r, 10));
      expect(callbacks.onDelete).toHaveBeenCalledWith('session-1');
    });

    it('does not call onNewSession when deleting non-current session', async () => {
      dropdown.open();
      const items = container.querySelectorAll('.co-ober-session-item');
      const deleteBtn = items[1].querySelector('.session-delete') as HTMLElement;
      deleteBtn.click();
      await new Promise(r => setTimeout(r, 10));
      expect(callbacks.onDelete).toHaveBeenCalledWith('session-2');
      expect(callbacks.onNewSession).not.toHaveBeenCalled();
    });

    it('notices the user when a session action rejects', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Notice.messages.length = 0;
      callbacks.onSwitch = vi.fn().mockRejectedValue(new Error('load boom'));
      dropdown.open();
      const items = container.querySelectorAll('.co-ober-session-item');
      (items[1] as HTMLElement).click();
      await new Promise(r => setTimeout(r, 10));
      expect(Notice.messages.some((m) => m.includes('load boom'))).toBe(true);
      errSpy.mockRestore();
    });

    it('notices the user when fork rejects', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Notice.messages.length = 0;
      const onFork = vi.fn().mockRejectedValue(new Error('fork boom'));
      const dd = new SessionDropdown(
        container,
        anchor,
        sessionStore as any,
        () => 'session-1',
        { ...callbacks, onFork } as any,
        () => ({ sessionCapabilities: { close: true, fork: true, list: true, resume: true } }),
      );
      dd.open();
      (container.querySelector('.session-fork') as HTMLElement).click();
      await new Promise(r => setTimeout(r, 10));
      expect(Notice.messages.some((m) => m.includes('fork boom'))).toBe(true);
      errSpy.mockRestore();
      dd.destroy();
    });
  });

  describe('search filtering', () => {
    it('filters sessions by title', () => {
      dropdown.open();
      const search = container.querySelector('.co-ober-session-search') as HTMLInputElement;
      search.value = 'Chat 2';
      search.dispatchEvent(new Event('input'));
      const items = container.querySelectorAll('.co-ober-session-item');
      expect(items.length).toBe(1);
      expect(items[0].querySelector('.session-label')?.textContent).toBe('Chat 2');
    });

    it('shows empty message when no matches', () => {
      dropdown.open();
      const search = container.querySelector('.co-ober-session-search') as HTMLInputElement;
      search.value = 'nonexistent';
      search.dispatchEvent(new Event('input'));
      const empty = container.querySelector('.co-ober-session-empty');
      expect(empty).not.toBeNull();
    });

    it('shows all sessions when search is cleared', () => {
      dropdown.open();
      const search = container.querySelector('.co-ober-session-search') as HTMLInputElement;
      search.value = 'Chat 2';
      search.dispatchEvent(new Event('input'));
      search.value = '';
      search.dispatchEvent(new Event('input'));
      const items = container.querySelectorAll('.co-ober-session-item');
      expect(items.length).toBe(3);
    });
  });

  describe('native OpenCode sessions', () => {
    function makeDropdown(loader: (() => Promise<unknown[]>) | null): SessionDropdown {
      return new SessionDropdown(
        container,
        anchor,
        sessionStore as any,
        () => 'session-1',
        callbacks as any,
        () => ({ sessionCapabilities: { close: true, fork: true, list: true, resume: true } }),
        loader as any,
      );
    }

    it('shows loading placeholder then renders native sessions', async () => {
      let resolveLoader: (sessions: unknown[]) => void = () => {};
      const loader = vi.fn(() => new Promise<unknown[]>((resolve) => { resolveLoader = resolve; }));
      const dd = makeDropdown(loader);
      dd.open();
      expect(container.querySelector('.co-ober-session-native-loading')).not.toBeNull();

      resolveLoader([
        { sessionId: 'ses_native_1', title: 'Terminal chat', updatedAt: '2026-08-22T03:39:57.497Z' },
        { sessionId: 'session-2', title: 'duplicate of local', updatedAt: '2026-08-22T03:39:57.497Z' },
      ]);
      await new Promise((r) => setTimeout(r, 10));

      expect(container.querySelector('.co-ober-session-native-section')).not.toBeNull();
      const nativeItems = container.querySelectorAll('.co-ober-session-native');
      expect(nativeItems.length).toBe(1); // duplicates of local sessions are dropped
      expect(nativeItems[0].querySelector('.session-label')?.textContent).toBe('Terminal chat');
      dd.destroy();
    });

    it('switches to native session with opencode source', async () => {
      const dd = makeDropdown(async () => [{ sessionId: 'ses_native_1', title: 'Terminal chat' }]);
      dd.open();
      await new Promise((r) => setTimeout(r, 10));
      const nativeItem = container.querySelector('.co-ober-session-native') as HTMLElement;
      expect(nativeItem).not.toBeNull();
      nativeItem.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(callbacks.onSwitch).toHaveBeenCalledWith('ses_native_1', 'opencode');
      dd.destroy();
    });

    it('does not render native section when loader is absent', () => {
      const dd = makeDropdown(null);
      dd.open();
      expect(container.querySelector('.co-ober-session-native-section')).toBeNull();
      dd.destroy();
    });

    it('hides loading placeholder when loader rejects', async () => {
      const dd = makeDropdown(() => Promise.reject(new Error('no sqlite')));
      dd.open();
      await new Promise((r) => setTimeout(r, 10));
      expect(container.querySelector('.co-ober-session-native-loading')).toBeNull();
      expect(container.querySelector('.co-ober-session-native-section')).toBeNull();
      dd.destroy();
    });
  });

  describe('destroy', () => {
    it('closes dropdown', () => {
      dropdown.open();
      dropdown.destroy();
      expect(dropdown.isOpen()).toBe(false);
    });
  });
});
