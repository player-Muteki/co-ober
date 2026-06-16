// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DragDropManager } from './dragDropManager';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';
import { Notice } from 'obsidian';

installObsidianDomHelpers();

describe('DragDropManager', () => {
  let dropZone: HTMLDivElement;
  let overlayContainer: HTMLDivElement;
  let handlers: {
    onAddNoteRef: ReturnType<typeof vi.fn>;
    onAddImagePart: ReturnType<typeof vi.fn>;
    onRemoveImagePart: ReturnType<typeof vi.fn>;
  };
  let manager: DragDropManager;

  beforeEach(() => {
    setLocale('en');
    (Notice as any).messages = [];
    dropZone = document.createElement('div');
    overlayContainer = document.createElement('div');
    document.body.appendChild(dropZone);
    document.body.appendChild(overlayContainer);

    handlers = {
      onAddNoteRef: vi.fn() as any,
      onAddImagePart: vi.fn() as any,
      onRemoveImagePart: vi.fn() as any,
    };

    manager = new DragDropManager(dropZone, overlayContainer, handlers as any);
  });

  describe('setup and teardown', () => {
    it('adds event listeners on setup', () => {
      const addSpy = vi.spyOn(dropZone, 'addEventListener');
      manager.setup();
      expect(addSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('drop', expect.any(Function));
    });

    it('removes event listeners on teardown', () => {
      const removeSpy = vi.spyOn(dropZone, 'removeEventListener');
      manager.setup();
      manager.teardown();
      expect(removeSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('drop', expect.any(Function));
    });

    it('does not remove listeners if not setup', () => {
      const removeSpy = vi.spyOn(dropZone, 'removeEventListener');
      manager.teardown();
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  describe('drag overlay', () => {
    it('shows overlay on dragover', () => {
      manager.setup();
      const event = new DragEvent('dragover', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } });
      dropZone.dispatchEvent(event);

      const overlay = overlayContainer.querySelector('.co-ober-drag-overlay');
      expect(overlay).not.toBeNull();
    });

    it('does not create multiple overlays', () => {
      manager.setup();
      const event = new DragEvent('dragover', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } });
      dropZone.dispatchEvent(event);
      dropZone.dispatchEvent(event);

      const overlays = overlayContainer.querySelectorAll('.co-ober-drag-overlay');
      expect(overlays.length).toBe(1);
    });

    it('hides overlay on dragleave when leaving dropZone', () => {
      manager.setup();
      const dragoverEvent = new DragEvent('dragover', { bubbles: true });
      Object.defineProperty(dragoverEvent, 'dataTransfer', { value: { dropEffect: '' } });
      dropZone.dispatchEvent(dragoverEvent);

      const leaveEvent = new DragEvent('dragleave', { bubbles: true });
      Object.defineProperty(leaveEvent, 'relatedTarget', { value: document.body });
      dropZone.dispatchEvent(leaveEvent);

      const overlay = overlayContainer.querySelector('.co-ober-drag-overlay');
      expect(overlay).toBeNull();
    });

    it('does not hide overlay on dragleave when moving to child', () => {
      manager.setup();
      const child = document.createElement('div');
      dropZone.appendChild(child);

      const dragoverEvent = new DragEvent('dragover', { bubbles: true });
      Object.defineProperty(dragoverEvent, 'dataTransfer', { value: { dropEffect: '' } });
      dropZone.dispatchEvent(dragoverEvent);

      const leaveEvent = new DragEvent('dragleave', { bubbles: true });
      Object.defineProperty(leaveEvent, 'relatedTarget', { value: child });
      dropZone.dispatchEvent(leaveEvent);

      const overlay = overlayContainer.querySelector('.co-ober-drag-overlay');
      expect(overlay).not.toBeNull();
    });
  });

  describe('image size tracking', () => {
    it('tracks image bytes via resetBytes and onRemoveImagePart', () => {
      manager.resetBytes();
      manager.onRemoveImagePart('data', 1024);
      expect(handlers.onRemoveImagePart).toHaveBeenCalledWith('data', 1024);
    });
  });

  describe('drop handling', () => {
    it('handles markdown file drop', async () => {
      manager.setup();

      const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' });
      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);

      // Wait for async handler
      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddNoteRef).toHaveBeenCalledWith(expect.objectContaining({
        type: 'note',
        name: 'test',
        path: 'test.md',
      }));
    });

    it('handles image file drop', async () => {
      manager.setup();

      // Create a mock image file
      const file = new File(['image-data'], 'test.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 1024 });

      // Mock FileReader using a function constructor
      function MockFileReader(this: any) {
        this.onload = null;
        this.onerror = null;
        this.result = null;
        this.readAsDataURL = vi.fn().mockImplementation((_file: File) => {
          this.result = 'data:image/png;base64,aW1hZ2UtZGF0YQ==';
          setTimeout(() => {
            if (this.onload) this.onload({ target: this });
          }, 0);
        });
      }

      vi.spyOn(globalThis, 'FileReader').mockImplementation(MockFileReader as any);

      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 50));

      expect(handlers.onAddImagePart).toHaveBeenCalledWith(
        'aW1hZ2UtZGF0YQ==',
        'image/png',
        1024,
        'test.png'
      );
    });

    it('rejects image file drop when image capability is false', async () => {
      manager = new DragDropManager(dropZone, overlayContainer, handlers as any, () => ({ promptCapabilities: { image: false } }));
      manager.setup();

      const file = new File(['image-data'], 'test.png', { type: 'image/png' });
      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);
      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect((Notice as any).messages).toContain('This OpenCode agent does not support image prompts');
    });

    it('skips images exceeding size limit', async () => {
      manager.setup();

      // Create a large image file (over 10MB)
      const file = new File(['image-data'], 'large.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('ignores unsupported file types', async () => {
      manager.setup();

      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddNoteRef).not.toHaveBeenCalled();
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
    });

    it('handles empty drop', async () => {
      manager.setup();

      const dataTransfer = { files: [] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddNoteRef).not.toHaveBeenCalled();
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
    });
  });
});
