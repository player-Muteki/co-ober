import type { ContextRef } from '../types';
import { t } from '../i18n/index';

export interface InputCallbacks {
  onSend: (text: string, refs?: ContextRef[]) => void;
  onStop: () => void;
  onToggleMention: () => void;
  onToggleSlash: () => void;
  onAddRef: (ref: ContextRef) => void;
  onRemoveRef: (id: string) => void;
}

export class ChatInput {
  private textarea: HTMLTextAreaElement;
  private disabled = false;
  private streaming = false;

  constructor(
    container: HTMLDivElement,
    private callbacks: InputCallbacks,
  ) {
    const handle = container.createDiv({ cls: 'copsidian-input-resize-handle' });
    this.setupResizeHandle(handle, container);

    const row = container.createDiv({ cls: 'copsidian-input-row' });
    this.textarea = row.createEl('textarea', { placeholder: t().input.placeholder });
    this.textarea.addClass('copsidian-input');

    this.textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.streaming) { e.preventDefault(); this.callbacks.onStop(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); return; }
      if (e.key === '@' && this.isAtWordBoundary()) { e.preventDefault(); this.callbacks.onToggleMention(); return; }
      if (e.key === '/' && this.isAtWordBoundary()) { e.preventDefault(); this.callbacks.onToggleSlash(); return; }
    });
  }

  private setupResizeHandle(handle: HTMLDivElement, container: HTMLDivElement): void {
    let startY = 0, startH = 0;
    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY; startH = container.offsetHeight;
      handle.addClass('dragging');
      const onMove = (ev: MouseEvent) => {
        container.style.height = Math.min(400, Math.max(144, startH + startY - ev.clientY)) + 'px';
      };
      const onUp = () => { handle.removeClass('dragging'); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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
    this.textarea.disabled = on;
  }

  setDisabled(on: boolean): void {
    this.disabled = on;
    this.textarea.disabled = on;
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
