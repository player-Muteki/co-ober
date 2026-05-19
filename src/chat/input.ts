import type { ContextRef } from '../types';

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
  private sendBtn: HTMLButtonElement;
  private disabled = false;
  private streaming = false;

  constructor(
    container: HTMLDivElement,
    private callbacks: InputCallbacks,
  ) {
    // Resize handle
    const handle = container.createDiv({ cls: 'copsidian-input-resize-handle' });
    this.setupResizeHandle(handle, container);

    // Input row
    const row = container.createDiv({ cls: 'copsidian-input-row' });

    this.textarea = row.createEl('textarea', { placeholder: 'Type a message…' });
    this.textarea.addClass('copsidian-input');

    this.sendBtn = row.createEl('button', { text: 'Send', cls: 'copsidian-send-btn' });
    this.sendBtn.onclick = () => this.handleButtonClick();

    this.textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.streaming) {
        e.preventDefault();
        this.callbacks.onStop();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
        return;
      }
      if (e.key === '@') {
        e.preventDefault();
        this.callbacks.onToggleMention();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        this.callbacks.onToggleSlash();
        return;
      }
    });
  }

  private setupResizeHandle(handle: HTMLDivElement, container: HTMLDivElement): void {
    let startY = 0;
    let startH = 0;

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      startY = e.clientY;
      startH = container.offsetHeight;
      handle.addClass('dragging');

      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        const newH = Math.min(400, Math.max(80, startH + delta));
        container.style.height = newH + 'px';
      };
      const onUp = () => {
        handle.removeClass('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private handleButtonClick(): void {
    if (this.streaming) {
      this.callbacks.onStop();
    } else {
      this.send();
    }
  }

  private send(): void {
    const text = this.textarea.value.trim();
    if (!text || this.disabled) return;
    this.callbacks.onSend(text, []);
    this.textarea.value = '';
  }

  setStreaming(on: boolean): void {
    this.streaming = on;
    this.sendBtn.textContent = on ? 'Stop' : 'Send';
    this.sendBtn.classList.toggle('mod-stop', on);
    this.textarea.disabled = on;
    this.sendBtn.disabled = false;
  }

  setDisabled(on: boolean): void {
    this.disabled = on;
    this.textarea.disabled = on;
    this.sendBtn.disabled = on;
  }

  focus(): void { this.textarea.focus(); }

  appendValue(text: string): void {
    this.textarea.value += text;
  }
}
