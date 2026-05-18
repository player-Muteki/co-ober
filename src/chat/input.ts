import type { ContextRef } from '../types';

export interface InputCallbacks {
  onSend: (text: string, refs: ContextRef[]) => void;
  onToggleMention: () => void;
  onToggleSlash: () => void;
}

export class ChatInput {
  private textarea: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private disabled = false;

  constructor(
    container: HTMLDivElement,
    private callbacks: InputCallbacks,
  ) {
    this.textarea = container.createEl('textarea', { placeholder: 'Type a message…' });
    this.textarea.rows = 1;
    this.textarea.addClass('copsidian-input');

    this.sendBtn = container.createEl('button', { text: 'Send', cls: 'copsidian-send-btn' });
    this.sendBtn.onclick = () => this.send();

    this.textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.autoResize();
  }

  private send(): void {
    const text = this.textarea.value.trim();
    if (!text || this.disabled) return;
    this.callbacks.onSend(text, []);
    this.textarea.value = '';
    this.autoResize();
  }

  setDisabled(on: boolean): void {
    this.disabled = on;
    this.textarea.disabled = on;
    this.sendBtn.disabled = on;
  }

  focus(): void { this.textarea.focus(); }

  appendValue(text: string): void {
    this.textarea.value += text;
    this.autoResize();
  }

  private autoResize(): void {
    const el = this.textarea;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }
}
