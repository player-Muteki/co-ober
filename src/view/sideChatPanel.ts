import { t, onLocaleChange } from '../i18n/index';
import { isImeComposing } from '../utils/ime';
import { humanizeError } from '../utils/errorText';
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
  private titleEl: HTMLDivElement | null = null;
  private subtitleEl: HTMLDivElement | null = null;
  private closeBtnEl: HTMLButtonElement | null = null;
  private sendBtnEl: HTMLButtonElement | null = null;
  private unsubscribeLocale: (() => void) | null = null;
  private busy = false;

  constructor(private deps: SideChatPanelDeps) {}

  isOpen(): boolean {
    return this.el !== null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Put this tab's thread in front; the scratch Q&A survives a tab switch. */
  show(): void {
    if (!this.el) return;
    this.el.removeClass('co-ober-side-chat-hidden');
    this.inputEl?.focus();
  }

  /** Take it out of sight without closing it — closing would release the session. */
  hide(): void {
    this.el?.addClass('co-ober-side-chat-hidden');
  }

  open(initialQuestion?: string): void {
    if (!this.el) this.render();
    // Asking again from a tab whose panel was hidden behind another brings it
    // back; hide() only takes it out of sight.
    this.el?.removeClass('co-ober-side-chat-hidden');
    const question = (initialQuestion ?? '').trim();
    if (question) void this.send(question);
    else this.inputEl?.focus();
  }

  private render(): void {
    const root = this.deps.containerEl.createDiv({ cls: 'co-ober-side-chat' });
    this.el = root;

    const header = root.createDiv({ cls: 'co-ober-side-chat-header' });
    const heading = header.createDiv({ cls: 'co-ober-side-chat-heading' });
    this.titleEl = heading.createDiv({ cls: 'co-ober-side-chat-title', text: t().sideChat.title });
    this.subtitleEl = heading.createDiv({ cls: 'co-ober-side-chat-subtitle', text: t().sideChat.subtitle });
    const closeBtn = header.createEl('button', { cls: 'co-ober-side-chat-close', text: t().sideChat.close });
    this.closeBtnEl = closeBtn;
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
    this.sendBtnEl = sendBtn;
    sendBtn.onclick = () => this.submitFromInput();
    // Relabel the chrome in place when the user switches locale while open.
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = onLocaleChange(() => this.relabel());
    textarea.focus();
  }

  private relabel(): void {
    if (this.titleEl) this.titleEl.textContent = t().sideChat.title;
    if (this.subtitleEl) this.subtitleEl.textContent = t().sideChat.subtitle;
    if (this.closeBtnEl) this.closeBtnEl.textContent = t().sideChat.close;
    if (this.sendBtnEl) this.sendBtnEl.textContent = t().sideChat.send;
    if (this.inputEl) this.inputEl.placeholder = t().sideChat.placeholder;
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
    // One bubble per message the side session is writing. A streamed answer
    // that arrives as several messages restarts its accumulated text at each
    // new id, so pouring every chunk into the one waiting bubble let the second
    // message overwrite the first — words the agent had already said vanished
    // off the panel with no trace of the gap.
    const bubblesByMessage = new Map<string, HTMLDivElement>();
    try {
      await this.deps.ask(text, (u) => {
        // Closing the panel takes the transcript away and aborts the ask; a chunk
        // already on its way here would be poured into a panel that no longer
        // exists, and the bubble it needed to land in threw on the way out.
        if (!this.transcriptEl) return;
        if (u.kind === 'message_chunk' && u.role === 'agent') {
          const key = u.messageId ?? '';
          let target = bubblesByMessage.get(key);
          if (!target) {
            target = bubblesByMessage.size === 0 ? answerEl : this.appendBubble('agent', '');
            bubblesByMessage.set(key, target);
          }
          target.setText(u.accumulatedText);
          target.removeClass('co-ober-side-chat-msg-thinking');
          this.scrollToBottom();
        }
      });
    } catch (e) {
      // Nothing had arrived yet, so the waiting bubble is still the placeholder
      // the reader was shown; it becomes the error in place. Once any text has
      // landed, that text is the agent's and stays on screen, with the failure
      // added below it rather than written over it. A panel closed mid-ask has
      // no place left to add that line, so the detached bubble takes it.
      const failingEl = bubblesByMessage.size === 0 || !this.transcriptEl
        ? answerEl
        : this.appendBubble('agent', '');
      failingEl.setText(t().sideChat.failed.replace('{error}', humanizeError(e)));
      failingEl.removeClass('co-ober-side-chat-msg-agent');
      failingEl.addClass('co-ober-side-chat-msg-error');
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
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = null;
    this.el?.remove();
    this.el = null;
    this.transcriptEl = null;
    this.inputEl = null;
    this.titleEl = null;
    this.subtitleEl = null;
    this.closeBtnEl = null;
    this.sendBtnEl = null;
    this.deps.onClose?.();
  }
}
