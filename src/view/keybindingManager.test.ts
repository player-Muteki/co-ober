// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { KeybindingManager } from './keybindingManager';
import { installObsidianDomHelpers } from '../test/domHelpers';

installObsidianDomHelpers();

describe('KeybindingManager', () => {
  let container: HTMLDivElement;
  let callbacks: {
    onNewSession: ReturnType<typeof vi.fn>;
    onClearScreen: ReturnType<typeof vi.fn>;
    onCopyLastMessage: ReturnType<typeof vi.fn>;
    onSwitchTab: ReturnType<typeof vi.fn>;
  };
  let manager: KeybindingManager;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    callbacks = {
      onNewSession: vi.fn() as any,
      onClearScreen: vi.fn() as any,
      onCopyLastMessage: vi.fn() as any,
      onSwitchTab: vi.fn() as any,
    };
    manager = new KeybindingManager(container, callbacks as any);
  });

  describe('register', () => {
    it('registers keydown handler', () => {
      const addSpy = vi.spyOn(container, 'addEventListener');
      manager.register();
      expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('triggers onNewSession on Ctrl+N', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onNewSession).toHaveBeenCalled();
    });

    it('triggers onNewSession on Cmd+N', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'n', metaKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onNewSession).toHaveBeenCalled();
    });

    it('does not trigger onNewSession on Ctrl+Shift+N', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onNewSession).not.toHaveBeenCalled();
    });

    it('triggers onClearScreen on Ctrl+L', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onClearScreen).toHaveBeenCalled();
    });

    it('does not trigger onClearScreen on Ctrl+Shift+L', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, shiftKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onClearScreen).not.toHaveBeenCalled();
    });

    it('triggers onCopyLastMessage on Ctrl+Shift+C', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onCopyLastMessage).toHaveBeenCalled();
    });

    it('triggers onCopyLastMessage on Cmd+Shift+C', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'c', metaKey: true, shiftKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onCopyLastMessage).toHaveBeenCalled();
    });

    it('does not trigger onCopyLastMessage on Ctrl+C (without shift)', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onCopyLastMessage).not.toHaveBeenCalled();
    });

    it('prevents default for handled shortcuts', () => {
      manager.register();
      const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);
      expect(preventSpy).toHaveBeenCalled();
    });
  });

  describe('Alt+digit focuses a tab of the strip', () => {
    function press(key: string, init: KeyboardEventInit = {}) {
      const event = new KeyboardEvent('keydown', { key, altKey: true, ...init });
      const preventSpy = vi.spyOn(event, 'preventDefault');
      container.dispatchEvent(event);
      return preventSpy;
    }

    it('maps the digit onto the zero-based tab position', () => {
      manager.register();
      press('1');
      press('9');
      expect(callbacks.onSwitchTab.mock.calls.map((c) => c[0])).toEqual([0, 8]);
    });

    it('keeps the browser shortcut to itself', () => {
      manager.register();
      expect(press('3', { ctrlKey: true })).not.toHaveBeenCalled();
      expect(press('3', { metaKey: true })).not.toHaveBeenCalled();
      expect(press('0')).not.toHaveBeenCalled();
      expect(press('3', { altKey: false })).not.toHaveBeenCalled();
      expect(callbacks.onSwitchTab).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('removes keydown handler', () => {
      const removeSpy = vi.spyOn(container, 'removeEventListener');
      manager.register();
      manager.unregister();
      expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('does not remove handler if not registered', () => {
      const removeSpy = vi.spyOn(container, 'removeEventListener');
      manager.unregister();
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('stops handling events after unregister', () => {
      manager.register();
      manager.unregister();
      const event = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true });
      container.dispatchEvent(event);
      expect(callbacks.onNewSession).not.toHaveBeenCalled();
    });
  });
});
