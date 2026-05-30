// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Autocomplete } from './autocomplete';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

describe('Autocomplete', () => {
  let container: HTMLDivElement;
  let callbacks: {
    onSelect: ReturnType<typeof vi.fn>;
  };
  let autocomplete: Autocomplete;

  const sampleItems = [
    { value: 'file1', label: 'File 1', description: 'First file' },
    { value: 'file2', label: 'File 2', description: 'Second file' },
    { value: 'file3', label: 'File 3' },
  ];

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    callbacks = {
      onSelect: vi.fn() as any,
    };
    autocomplete = new Autocomplete(container, callbacks as any);
  });

  describe('open', () => {
    it('creates dropdown element', () => {
      autocomplete.open(sampleItems, '@');
      const dropdown = container.querySelector('.copsilot-ac-dropdown');
      expect(dropdown).not.toBeNull();
    });

    it('renders all items', () => {
      autocomplete.open(sampleItems, '@');
      const items = container.querySelectorAll('.copsilot-ac-item');
      expect(items.length).toBe(3);
    });

    it('shows labels', () => {
      autocomplete.open(sampleItems, '@');
      const labels = container.querySelectorAll('.ac-label');
      expect(labels[0].textContent).toBe('File 1');
      expect(labels[1].textContent).toBe('File 2');
      expect(labels[2].textContent).toBe('File 3');
    });

    it('shows descriptions when available', () => {
      autocomplete.open(sampleItems, '@');
      const descs = container.querySelectorAll('.ac-desc');
      expect(descs.length).toBe(2);
      expect(descs[0].textContent).toBe('First file');
    });

    it('selects first item by default', () => {
      autocomplete.open(sampleItems, '@');
      const selected = container.querySelector('.copsilot-ac-item.selected');
      expect(selected).not.toBeNull();
      expect(selected?.querySelector('.ac-label')?.textContent).toBe('File 1');
    });

    it('shows no matches message when empty', () => {
      autocomplete.open([], '@');
      const item = container.querySelector('.copsilot-ac-item');
      expect(item?.textContent).toBe('No matches');
    });
  });

  describe('close', () => {
    it('removes dropdown element', () => {
      autocomplete.open(sampleItems, '@');
      autocomplete.close();
      const dropdown = container.querySelector('.copsilot-ac-dropdown');
      expect(dropdown).toBeNull();
    });

    it('does nothing if not open', () => {
      autocomplete.close();
      // Should not throw
    });
  });

  describe('isOpen', () => {
    it('returns false initially', () => {
      expect(autocomplete.isOpen()).toBe(false);
    });

    it('returns true after open', () => {
      autocomplete.open(sampleItems, '@');
      expect(autocomplete.isOpen()).toBe(true);
    });

    it('returns false after close', () => {
      autocomplete.open(sampleItems, '@');
      autocomplete.close();
      expect(autocomplete.isOpen()).toBe(false);
    });
  });

  describe('keyboard navigation', () => {
    it('selects next item on ArrowDown', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      const selected = container.querySelector('.copsilot-ac-item.selected');
      expect(selected?.querySelector('.ac-label')?.textContent).toBe('File 2');
    });

    it('wraps to first item on ArrowDown at end', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      const selected = container.querySelector('.copsilot-ac-item.selected');
      expect(selected?.querySelector('.ac-label')?.textContent).toBe('File 1');
    });

    it('selects previous item on ArrowUp', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      const selected = container.querySelector('.copsilot-ac-item.selected');
      expect(selected?.querySelector('.ac-label')?.textContent).toBe('File 1');
    });

    it('wraps to last item on ArrowUp at start', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      const selected = container.querySelector('.copsilot-ac-item.selected');
      expect(selected?.querySelector('.ac-label')?.textContent).toBe('File 3');
    });

    it('selects current item on Enter', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(callbacks.onSelect).toHaveBeenCalledWith('file1', '@');
    });

    it('closes on Enter', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(autocomplete.isOpen()).toBe(false);
    });

    it('closes on Escape', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(autocomplete.isOpen()).toBe(false);
    });

    it('filters items on typing', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      const items = container.querySelectorAll('.copsilot-ac-item');
      expect(items.length).toBe(1);
      expect(items[0].querySelector('.ac-label')?.textContent).toBe('File 2');
    });

    it('removes last character on Backspace', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
      const items = container.querySelectorAll('.copsilot-ac-item');
      expect(items.length).toBe(3);
    });

    it('closes on Backspace when filter is empty', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
      expect(autocomplete.isOpen()).toBe(false);
    });
  });

  describe('mouse interactions', () => {
    it('selects item on click', () => {
      autocomplete.open(sampleItems, '@');
      const items = container.querySelectorAll('.copsilot-ac-item');
      (items[1] as HTMLElement).click();
      expect(callbacks.onSelect).toHaveBeenCalledWith('file2', '@');
    });

    it('closes on click outside', () => {
      autocomplete.open(sampleItems, '@');
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(autocomplete.isOpen()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('closes dropdown', () => {
      autocomplete.open(sampleItems, '@');
      autocomplete.destroy();
      expect(autocomplete.isOpen()).toBe(false);
    });
  });
});
