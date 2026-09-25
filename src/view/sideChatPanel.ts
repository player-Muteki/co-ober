import { t } from '../i18n/index';
import { isImeComposing } from '../utils/ime';
import type { AcpResponse, NormalizedUpdate } from '../types';

/** Sends one question to the forked side session; resolves with the turn response. */
export type SideChatAsk = (text: string, onChunk: (u: NormalizedUpdate) => void) => Promise<AcpResponse>;

export interface SideChatPanelDeps {
  containerEl: HTMLElement;
  ask: SideChatAsk;
  isMainBusy: () => boolean;
  onClose?: () => void;
  /** Invoked when the panel closes while a turn is still streaming. */
  abort?: () => void;
}

/**
 * Floating side-chat panel backed by a forked session. Streams answer text
 * only; tool calls and plan updates from the side session are ignored so the
 * scratch thread stays a plain Q&A that never touches the main transcript.
 */
export class SideChatPanel {
  private el: HTMLDivElement | null = null;
  private transcriptEl: HTMLDivElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private busy = false;

  constructor(private deps: SideChatPanelDeps) {}

  isOpen(): boolean {
    return this.el !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  open(initialQuestion?: string): void {
    if (!this.el) this.render();
    const question = (initialQuestion ?? '').trim();
    if (question) void this.send(question);
    else this.inputEl?.focus();
  }

  private render(): void {
    const root = this.deps.containerEl.createDiv({ cls: 'co-ober-side-chat' });
    this.el = root;

    const header = root.createDiv({ cls: 'co-ober-side-chat-header' });
    const heading = header.createDiv({ cls: 'co-ober-side-chat-heading' });
    heading.createDiv({ cls: 'co-ober-side-chat-title', text: t().sideChat.title });
    heading.createDiv({ cls: 'co-ober-side-chat-subtitle', text: t().sideChat.subtitle });
    const closeBtn = header.createEl('button', { cls: 'co-ober-side-chat-close', text: t().sideChat.close });
    closeBtn.onclick = () => this.close();

    this.transcriptEl = root.createDiv({ cls: 'co-ober-side-chat-transcript' });

    const form = root.createDiv({ cls: 'co-ober-side-chat-input' });
    const textarea = form.createEl('textarea', {
      cls: 'co-ober-side-chat-textarea',
      attr: { placeholder: t().sideChat.placeholder, rows: '2' },
    });
    this.inputEl = textarea;
    textarea.onkeydown = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submitFromInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    const sendBtn = form.createEl('button', { cls: 'co-ober-side-chat-send', text: t().sideChat.send });
    sendBtn.onclick = () => this.submitFromInput();
    textarea.focus();
  }

  private submitFromInput(): void {
    const text = (this.inputEl?.value ?? '').trim();
    if (!text) return;
    if (this.inputEl) this.inputEl.value = '';
    void this.send(text);
  }

  async send(text: string): Promise<void> {
    if (!this.el) this.render();
    if (this.busy) {
      this.appendBubble('error', t().sideChat.busy);
      return;
    }
    if (this.deps.isMainBusy()) {
      this.appendBubble('error', t().sideChat.busy);
      return;
    }
    this.busy = true;
    this.appendBubble('user', text);
    const answerEl = this.appendBubble('agent', t().sideChat.thinking);
    answerEl.addClass('is-streaming');
    try {
      await this.deps.ask(text, (u) => {
        if (u.kind === 'message_chunk' && u.role === 'agent') {
          answerEl.setText(u.accumulatedText);
          answerEl.removeClass('co-ober-side-chat-msg-thinking');
          this.scrollToBottom();
        }
      });
    } catch (e) {
      answerEl.setText(t().sideChat.failed.replace('{error}', e instanceof Error ? e.message : String(e)));
      answerEl.removeClass('co-ober-side-chat-msg-agent');
      answerEl.addClass('co-ober-side-chat-msg-error');
    } finally {
      answerEl.removeClass('is-streaming');
      this.busy = false;
    }
  }

  private appendBubble(role: 'user' | 'agent' | 'error', text: string): HTMLDivElement {
    const bubble = this.transcriptEl!.createDiv({
      cls: `co-ober-side-chat-msg co-ober-side-chat-msg-${role}`,
      text,
    });
    this.scrollToBottom();
    return bubble;
  }

  private scrollToBottom(): void {
    if (this.transcriptEl) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  close(): void {
    if (this.busy) this.deps.abort?.();
    this.el?.remove();
    this.el = null;
    this.transcriptEl = null;
    this.inputEl = null;
    this.deps.onClose?.();
  }
}
