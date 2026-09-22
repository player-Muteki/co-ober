// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SideChatPanel, type SideChatAsk } from './sideChatPanel';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale, t } from '../i18n/index';
import type { AcpResponse, NormalizedUpdate } from '../types';

installObsidianDomHelpers();

const okResponse: AcpResponse = { stopReason: 'end_turn' };

function makeAsk() {
  const handlers: Array<(u: NormalizedUpdate) => void> = [];
  const ask = vi.fn<SideChatAsk>(async (_text, onChunk) => {
    handlers.push(onChunk);
    return okResponse;
  });
  return { ask, handlers };
}

describe('SideChatPanel', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  function makePanel(overrides: Partial<{ ask: SideChatAsk; isMainBusy: () => boolean; onClose: () => void }> = {}) {
    const base = makeAsk();
    const deps = {
      containerEl: container,
      ask: (overrides.ask ?? base.ask) as SideChatAsk,
      isMainBusy: overrides.isMainBusy ?? (() => false),
      onClose: overrides.onClose ?? vi.fn(),
    };
    return { panel: new SideChatPanel(deps), ...base, deps };
  }

  it('open() renders the shell and marks itself open', () => {
    const { panel } = makePanel();
    expect(panel.isOpen()).toBe(false);

    panel.open();

    expect(panel.isOpen()).toBe(true);
    const root = container.querySelector('.co-ober-side-chat');
    expect(root).not.toBeNull();
    expect(root?.querySelector('.co-ober-side-chat-title')?.textContent).toBe(t().sideChat.title);
    expect(root?.querySelector('.co-ober-side-chat-subtitle')?.textContent).toBe(t().sideChat.subtitle);
    expect(root?.querySelector('.co-ober-side-chat-textarea')).not.toBeNull();
  });

  it('open(question) immediately asks it and streams agent chunks into the bubble', async () => {
    const { panel, handlers, ask } = makePanel();
    panel.open('what is a fork?');

    expect(ask).toHaveBeenCalledWith('what is a fork?', expect.any(Function));
    const bubbles = container.querySelectorAll('.co-ober-side-chat-msg');
    expect(bubbles[0].textContent).toBe('what is a fork?');
    expect(bubbles[0].classList.contains('co-ober-side-chat-msg-user')).toBe(true);
    expect(bubbles[1].textContent).toBe(t().sideChat.thinking);

    handlers[0]({ kind: 'message_chunk', role: 'agent', messageId: 'm1', chunkText: 'A ', accumulatedText: 'A copy' });
    handlers[0]({ kind: 'message_chunk', role: 'agent', messageId: 'm1', chunkText: ' branch', accumulatedText: 'A copy branch' });
    // Non-agent updates must not touch the answer bubble.
    handlers[0]({ kind: 'plan', entries: [] });
    handlers[0]({
      kind: 'message_chunk',
      role: 'thought',
      messageId: 'm1',
      chunkText: 'hmm',
      accumulatedText: 'hmm',
    });
    expect(bubbles[1].textContent).toBe('A copy branch');
    await new Promise((r) => setTimeout(r, 0));
    expect(bubbles[1].classList.contains('is-streaming')).toBe(false);
  });

  it('renders ask failures inline without breaking the panel', async () => {
    const failing: SideChatAsk = async () => {
      throw new Error('stream busy');
    };
    const { panel } = makePanel({ ask: failing });
    await panel.send('hello');

    const agentBubble = container.querySelectorAll('.co-ober-side-chat-msg')[1];
    expect(agentBubble.textContent).toContain('stream busy');
    expect(agentBubble.classList.contains('co-ober-side-chat-msg-error')).toBe(true);
    expect(panel.isOpen()).toBe(true);
    expect(panel.isBusy()).toBe(false);
  });

  it('refuses to ask while the main conversation is generating', async () => {
    const { panel, ask } = makePanel({ isMainBusy: () => true });
    await panel.send('hello');

    expect(ask).not.toHaveBeenCalled();
    const bubble = container.querySelector('.co-ober-side-chat-msg-error');
    expect(bubble?.textContent).toBe(t().sideChat.busy);
  });

  it('ignores a second send while the first answer is still streaming', async () => {
    let release: (() => void) | null = null;
    const slow: SideChatAsk = () => new Promise<AcpResponse>((resolve) => {
      release = () => resolve(okResponse);
    });
    const { panel } = makePanel({ ask: slow });
    void panel.send('first');
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isBusy()).toBe(true);

    await panel.send('second');
    expect(container.querySelectorAll('.co-ober-side-chat-msg-user')).toHaveLength(1);
    expect(container.querySelector('.co-ober-side-chat-msg-error')?.textContent).toBe(t().sideChat.busy);
    release!();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('Enter sends the textarea content and clears it; Shift+Enter does not', async () => {
    const { panel, ask } = makePanel();
    panel.open();
    const textarea = container.querySelector('.co-ober-side-chat-textarea') as HTMLTextAreaElement;

    textarea.value = 'typed question';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(ask).toHaveBeenCalledWith('typed question', expect.any(Function));
    expect(textarea.value).toBe('');

    textarea.value = 'multi\nline';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('Escape and the close button both close the panel and notify onClose', () => {
    const onClose = vi.fn();
    const { panel } = makePanel({ onClose });
    panel.open();

    const textarea = container.querySelector('.co-ober-side-chat-textarea') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(panel.isOpen()).toBe(false);
    expect(container.querySelector('.co-ober-side-chat')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);

    panel.open();
    (container.querySelector('.co-ober-side-chat-close') as HTMLButtonElement).click();
    expect(panel.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the send button submits the textarea', async () => {
    const { panel, ask } = makePanel();
    panel.open();
    const textarea = container.querySelector('.co-ober-side-chat-textarea') as HTMLTextAreaElement;
    textarea.value = 'button question';
    (container.querySelector('.co-ober-side-chat-send') as HTMLButtonElement).click();
    expect(ask).toHaveBeenCalledWith('button question', expect.any(Function));
  });

  it('re-opening an open panel only asks the new question', async () => {
    const { panel, ask } = makePanel();
    panel.open('one');
    await new Promise((r) => setTimeout(r, 0));
    panel.open('two');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll('.co-ober-side-chat')).toHaveLength(1);
  });
});
