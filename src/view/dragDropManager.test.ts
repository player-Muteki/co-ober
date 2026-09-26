// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DragDropManager } from './dragDropManager';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale, t } from '../i18n/index';
import zhLocale from '../i18n/zh';
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

  // The budget is measured against the encoded payload, so limit tests derive
  // the base64 length from the file's declared size instead of reading bytes.
  function mockSizedImageReader() {
    function MockFileReader(this: any) {
      this.onload = null;
      this.onerror = null;
      this.result = null;
      this.readAsDataURL = vi.fn().mockImplementation((file: File) => {
        this.result = 'data:image/png;base64,' + 'a'.repeat(file.size);
        setTimeout(() => {
          if (this.onload) this.onload({ target: this });
        }, 0);
      });
    }
    vi.spyOn(globalThis, 'FileReader').mockImplementation(MockFileReader as any);
  }

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
        16,
        'test.png'
      );
    });

    it('says so when a dropped image cannot be read', async () => {
      manager.setup();

      const file = new File(['image-data'], 'broken.png', { type: 'image/png' });

      function MockFileReader(this: any) {
        this.onload = null;
        this.onerror = null;
        this.result = null;
        this.readAsDataURL = vi.fn().mockImplementation(() => {
          setTimeout(() => {
            if (this.onerror) this.onerror(new Error('unreadable'));
          }, 0);
        });
      }
      vi.spyOn(globalThis, 'FileReader').mockImplementation(MockFileReader as any);

      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);
      await new Promise(r => setTimeout(r, 50));

      // The other branches all announced themselves; a failed read used to leave
      // the drop looking like a successful attach.
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect((Notice as any).messages.some((m: string) => m.includes('broken.png'))).toBe(true);
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

    it('notices and skips images exceeding the pending-image budget', async () => {
      manager.setup();
      mockSizedImageReader();

      // The encoded payload is derived from the declared size (over 10MB).
      const file = new File(['image-data'], 'large.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      (Notice as any).messages.length = 0;
      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect((Notice as any).messages).toContain('"large.png" exceeds the 10 MB pending-image limit');
    });

    it('says so when a dropped file has no pipeline', async () => {
      manager.setup();
      (Notice as any).messages.length = 0;

      const file = new File(['data'], 'test.txt', { type: 'text/plain' });
      const dataTransfer = { files: [file] };
      const event = new DragEvent('drop', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'preventDefault', { value: vi.fn() });

      dropZone.dispatchEvent(event);

      await new Promise(r => setTimeout(r, 10));

      expect(handlers.onAddNoteRef).not.toHaveBeenCalled();
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      // The drop zone flashed either way, so silence read as "attached".
      expect((Notice as any).messages).toContain('"test.txt" is neither a note nor an image Co-Ober can use');
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

  describe('handleFiles (paste / file picker entry point)', () => {
    function mockImageReader() {
      function MockFileReader(this: any) {
        this.onload = null;
        this.onerror = null;
        this.result = null;
        this.readAsDataURL = vi.fn().mockImplementation(() => {
          this.result = 'data:image/png;base64,aW1hZ2UtZGF0YQ==';
          setTimeout(() => {
            if (this.onload) this.onload({ target: this });
          }, 0);
        });
      }
      vi.spyOn(globalThis, 'FileReader').mockImplementation(MockFileReader as any);
    }

    it('accepts image files routed through handleFiles', async () => {
      mockImageReader();
      const file = new File(['image-data'], 'pasted.png', { type: 'image/png' });

      await manager.handleFiles([file]);

      expect(handlers.onAddImagePart).toHaveBeenCalledWith('aW1hZ2UtZGF0YQ==', 'image/png', 16, 'pasted.png');
    });

    it('rejects images when image capability is false', async () => {
      manager = new DragDropManager(dropZone, overlayContainer, handlers as any, () => ({ promptCapabilities: { image: false } }));
      const file = new File(['image-data'], 'pasted.png', { type: 'image/png' });

      await manager.handleFiles([file]);

      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect((Notice as any).messages).toContain('This OpenCode agent does not support image prompts');
    });

    it('rejects images when the agent named other capabilities but not images', async () => {
      // ACP defaults an unstated prompt capability to false, so an agent that
      // answers `{ audio: true }` has answered "no images".
      manager = new DragDropManager(dropZone, overlayContainer, handlers as any, () => ({ promptCapabilities: { audio: true } }));
      const file = new File(['image-data'], 'pasted.png', { type: 'image/png' });

      await manager.handleFiles([file]);

      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect((Notice as any).messages).toContain('This OpenCode agent does not support image prompts');
    });

    it('does not track bytes for rejected images across multiple calls', async () => {
      mockSizedImageReader();
      (Notice as any).messages.length = 0;
      const file = new File(['image-data'], 'pasted.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 9 * 1024 * 1024 });

      await manager.handleFiles([file]);
      // Total now 9MB of encoded payload; a second 2MB image would exceed the
      // 10MB budget and be skipped.
      const second = new File(['more'], 'second.png', { type: 'image/png' });
      Object.defineProperty(second, 'size', { value: 2 * 1024 * 1024 });
      await manager.handleFiles([second]);

      expect(handlers.onAddImagePart).toHaveBeenCalledTimes(1);
      // 2MB is not a large image; the weight sits in what is already staged. A
      // message blaming this file sent users to shrink the wrong thing.
      expect((Notice as any).messages).toContain('"second.png" was not added — the images already staged fill the 10 MB limit');
    });

    it('ignores an empty file list', async () => {
      await manager.handleFiles([]);
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect(handlers.onAddNoteRef).not.toHaveBeenCalled();
    });

    it('notifies the user about audio files instead of silently dropping them', async () => {
      const file = new File(['data'], 'voice.wav', { type: 'audio/wav' });

      await manager.handleFiles([file]);

      expect((Notice as any).messages).toContain('Audio attachments are not supported');
      expect(handlers.onAddImagePart).not.toHaveBeenCalled();
      expect(handlers.onAddNoteRef).not.toHaveBeenCalled();
    });
  });

  describe('locale subscription', () => {
    function showOverlay() {
      manager.setup();
      const event = new DragEvent('dragover', { bubbles: true });
      Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } });
      dropZone.dispatchEvent(event);
      return overlayContainer.querySelector('.co-ober-drag-overlay div') as HTMLDivElement;
    }

    it('live overlay text follows locale changes while setup', () => {
      setLocale('en');
      const textDiv = showOverlay();
      const enText = t().dragOverlay;
      expect(textDiv.textContent).toBe(enText);

      setLocale('zh');
      expect(textDiv.textContent).toBe(zhLocale.dragOverlay);
      expect(zhLocale.dragOverlay).not.toBe(enText);
      setLocale('en');
    });

    it('teardown() unsubscribes the locale listener', () => {
      setLocale('en');
      const textDiv = showOverlay();
      const enText = textDiv.textContent;

      manager.teardown();
      setLocale('zh');
      // Listener is gone: the leftover overlay keeps its stale English text.
      expect(textDiv.textContent).toBe(enText);
      expect(enText).not.toBe(zhLocale.dragOverlay);
      setLocale('en');
    });
  });
});
