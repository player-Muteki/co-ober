import type { ContextRef } from '../types';
import { t, onLocaleChange } from '../i18n/index';

export interface InputCallbacks {
  onSend: (text: string, refs?: ContextRef[]) => void;
  onStop: () => void;
  onCycleMode?: (direction: 1 | -1) => void;
  onToggleMention: () => void;
  onToggleSlash: () => void;
  onAddRef: (ref: ContextRef) => void;
  onRemoveRef: (id: string) => void;
}

export class ChatInput {
  private textarea: HTMLTextAreaElement;
  private disabled = false;
  private streaming = false;
  private doc: Document;
  private readonly resizeHandle: HTMLDivElement;
  private readonly keydownHandler: (e: KeyboardEvent) => void;
  private readonly mousedownHandler: (e: MouseEvent) => void;
  private readonly unsubscribeLocale: () => void;

  constructor(
    container: HTMLDivElement,
    private callbacks: InputCallbacks,
  ) {
    this.doc = container.ownerDocument ?? activeDocument;
    this.resizeHandle = container.createDiv({ cls: 'co-ober-input-resize-handle' });

    const row = container.createDiv({ cls: 'co-ober-input-row' });
    this.textarea = row.createEl('textarea', { placeholder: t().input.placeholder });
    this.textarea.addClass('co-ober-input');

    this.unsubscribeLocale = onLocaleChange(() => this.refreshLocale());

    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.streaming) { e.preventDefault(); this.callbacks.onStop(); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); this.callbacks.onCycleMode?.(1); return; }
      if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); this.callbacks.onCycleMode?.(-1); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); return; }
      if (e.key === '@' && this.isAtWordBoundary()) { e.preventDefault(); this.callbacks.onToggleMention(); return; }
      if (e.key === '/' && this.isAtWordBoundary()) { e.preventDefault(); this.callbacks.onToggleSlash(); return; }
    };
    this.textarea.addEventListener('keydown', this.keydownHandler);

    this.mousedownHandler = (e: MouseEvent) => {
      e.preventDefault();
      let startY = e.clientY;
      const startH = container.offsetHeight;
      this.resizeHandle.addClass('dragging');
      const onMove = (ev: MouseEvent) => {
        container.style.height = Math.min(400, Math.max(144, startH + startY - ev.clientY)) + 'px';
      };
      const onUp = () => {
        this.resizeHandle.removeClass('dragging');
        this.doc.removeEventListener('mousemove', onMove);
        this.doc.removeEventListener('mouseup', onUp);
      };
      this.doc.addEventListener('mousemove', onMove);
      this.doc.addEventListener('mouseup', onUp);
    };
    this.resizeHandle.addEventListener('mousedown', this.mousedownHandler);
  }

  dispose(): void {
    this.unsubscribeLocale();
    this.textarea.removeEventListener('keydown', this.keydownHandler);
    this.resizeHandle.removeEventListener('mousedown', this.mousedownHandler);
  }

  triggerSend(): void { this.send(); }
  triggerStop(): void { this.callbacks.onStop(); }
  isStreaming(): boolean { return this.streaming; }

  private send(): void {
    const text = this.textarea.value.trim();
    if (!text || this.disabled) return;
    this.callbacks.onSend(text, []);
    this.textarea.value = '';
  }

  setStreaming(on: boolean): void {
    this.streaming = on;
  }

  setDisabled(on: boolean): void {
    this.disabled = on;
    this.textarea.disabled = on;
  }

  refreshLocale(): void {
    this.textarea.placeholder = t().input.placeholder;
  }

  /** Check if the character before the cursor is whitespace or start-of-input */
  private isAtWordBoundary(): boolean {
    const cursor = this.textarea.selectionStart;
    if (cursor <= 0) return true;
    const ch = this.textarea.value[cursor - 1];
    return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
  }

  focus(): void { this.textarea.focus(); }
  appendValue(text: string): void { this.textarea.value += text; }
}
