// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChatRenderer, formatMessageUsage, currencySymbol, contextPercentage } from './renderer';
import { closeImagePreview } from './imagePreview';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale, t } from '../i18n/index';

installObsidianDomHelpers();

// Mock Obsidian's MarkdownRenderer
vi.mock('obsidian', () => ({
  MarkdownRenderer: {
    renderMarkdown: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockResolvedValue(undefined),
  },
  setIcon: vi.fn(),
}));

describe('ChatRenderer', () => {
  let container: HTMLDivElement;
  let app: any;
  let renderer: ChatRenderer;
  let shouldAutoScroll: () => boolean;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    app = { vault: { getFiles: vi.fn().mockReturnValue([]), getRoot: () => ({ path: '' }) } };
    shouldAutoScroll = () => true;
    renderer = new ChatRenderer(container, app, shouldAutoScroll);
  });

  describe('clear', () => {
    it('clears container and resets state', () => {
      renderer.addUserMessage('Hello');
      renderer.clear();
      expect(container.children.length).toBe(0);
    });
  });

  describe('setSystemNote', () => {
    const noteBody = () => container.querySelector('.co-ober-msg.system .co-ober-msg-body');

    it('writes a notice line carrying the count', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 1);
      expect(container.querySelectorAll('.co-ober-msg.system').length).toBe(1);
      expect(noteBody()?.textContent).toContain('could not draw 1 update frame');
    });

    it('rewrites the line it already drew instead of stacking repeats', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 1);
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 2);
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 3);
      expect(container.querySelectorAll('.co-ober-msg.system').length).toBe(1);
      expect(noteBody()?.textContent).toContain('could not draw 3 update frame');
    });

    it('draws a fresh line once the transcript it belonged to was cleared', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 4);
      renderer.clear();
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 1);
      expect(container.querySelectorAll('.co-ober-msg.system').length).toBe(1);
      expect(noteBody()?.textContent).toContain('could not draw 1 update frame');
    });

    it('relabels itself when the locale changes underneath it', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 7);
      setLocale('zh');
      expect(noteBody()?.textContent).toContain('7');
      expect(noteBody()?.textContent).toContain('未能绘制');
      setLocale('en');
    });

    it('names the protocol version an agent negotiated', () => {
      renderer.setSystemNote('protocolMismatch', 'stream.protocolMismatch', 2);
      expect(noteBody()?.textContent).toContain('ACP protocol version 2');
    });

    it('carries the detail a note was given, and keeps it across a locale switch', () => {
      renderer.setSystemNote('grants', 'permission.granted', 2, 'git push origin');
      expect(noteBody()?.textContent).toContain('git push origin');

      setLocale('zh');
      expect(noteBody()?.textContent).toContain('git push origin');
      expect(noteBody()?.textContent).toContain('2');
      setLocale('en');
    });

    it('keeps a note that has no detail free of an empty placeholder', () => {
      renderer.setSystemNote('grants', 'permission.granted', 1, 'rm -rf build');
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 3);
      const bodies = container.querySelectorAll('.co-ober-msg.system .co-ober-msg-body');
      expect(bodies[1].textContent).not.toContain('{detail}');
    });

    it('takes its own line out and leaves the other notes standing', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 2);
      renderer.setSystemNote('protocolMismatch', 'stream.protocolMismatch', 2);
      expect(container.querySelectorAll('.co-ober-msg.system').length).toBe(2);

      renderer.clearSystemNote('protocolMismatch');

      const bodies = container.querySelectorAll('.co-ober-msg.system .co-ober-msg-body');
      expect(bodies).toHaveLength(1);
      expect(bodies[0].textContent).toContain('could not draw 2 update frame');
    });

    it('says nothing when the note it was asked to remove was never drawn', () => {
      renderer.setSystemNote('droppedFrames', 'stream.droppedFrames', 1);

      renderer.clearSystemNote('protocolMismatch');
      renderer.clearSystemNote('protocolMismatch');

      expect(container.querySelectorAll('.co-ober-msg.system').length).toBe(1);
    });
  });

  describe('addUserMessage', () => {
    it('adds user message to container', () => {
      renderer.addUserMessage('Hello world');
      const msg = container.querySelector('.co-ober-msg.user');
      expect(msg).not.toBeNull();
      expect(msg?.querySelector('.co-ober-msg-body')?.textContent).toBe('Hello world');
    });

    it('adds timestamp', () => {
      renderer.addUserMessage('Hello', 1234567890000);
      const msg = container.querySelector('.co-ober-msg.user') as HTMLElement;
      expect(msg?.dataset.timestamp).toBeDefined();
    });

    it('leaves an undatable replayed turn with no hover time rather than a 1970 minute', () => {
      // A session the database never timed comes back as the `timestamp: 0`
      // sentinel (sessionReplay writes it; transcript.ts honours it). The old
      // `?? Date.now()` only caught undefined, so 0 fell through and
      // `new Date(0).toLocaleTimeString()` hung an invented minute — e.g.
      // "08:00" — on a turn that had no time at all.
      renderer.addUserMessage('replayed', 0);
      const msg = container.querySelector('.co-ober-msg.user') as HTMLElement;
      expect(msg.dataset.timestamp).toBeUndefined();
      expect(container.querySelector('[data-timestamp]')).toBeNull();
    });

    it('still stamps a live message that names no time with the current clock', () => {
      // The sentinel is a stored 0, not an omitted argument: a message the
      // reader just sent passes no timestamp and must take now.
      renderer.addUserMessage('just now');
      const msg = container.querySelector('.co-ober-msg.user') as HTMLElement;
      expect(msg.dataset.timestamp).toBeDefined();
    });

    it('treats a past-epoch timestamp as no time at all', () => {
      // MAX_TIMESTAMP_MS is the same ceiling session.ts's list() gate and
      // NativeSessionReader already apply; anything beyond it is unreadable,
      // and toISOString/formatting would either throw or print a wrong date.
      renderer.addUserMessage('corrupt', 8.64e15 + 1);
      const msg = container.querySelector('.co-ober-msg.user') as HTMLElement;
      expect(msg.dataset.timestamp).toBeUndefined();
    });

    it('renders an image gallery with data URIs', () => {
      renderer.addUserMessage('Look', undefined, [
        { mimeType: 'image/png', data: 'AAA=' },
        { mimeType: 'image/jpeg', data: 'BBB=' },
      ]);
      const gallery = container.querySelector('.co-ober-user-images');
      expect(gallery).not.toBeNull();
      const imgs = container.querySelectorAll('.co-ober-user-image');
      expect(imgs.length).toBe(2);
      expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAA=');
      expect(imgs[1].getAttribute('src')).toBe('data:image/jpeg;base64,BBB=');
    });

    it('renders no gallery when there are no images', () => {
      renderer.addUserMessage('plain');
      expect(container.querySelector('.co-ober-user-images')).toBeNull();
    });

    it('adds a per-message copy button that writes the message text', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderer.addUserMessage('copy me');
      const btn = container.querySelector('.co-ober-msg.user .co-ober-text-copy-btn') as HTMLButtonElement;
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe('Copy');
      expect(container.querySelector('.co-ober-msg-body')?.textContent).toBe('copy me');
      btn.click();
      expect(writeText).toHaveBeenCalledWith('copy me');
    });

    it('omits the copy button for empty user messages', () => {
      renderer.addUserMessage('');
      expect(container.querySelector('.co-ober-text-copy-btn')).toBeNull();
    });
  });

  describe('appendInterruptIndicator', () => {
    it('renders the localized badge and hint', () => {
      renderer.appendInterruptIndicator();
      expect(container.querySelector('.co-ober-interrupted-badge')?.textContent).toBe('Interrupted');
      expect(container.querySelector('[data-i18n-text="interrupted.hint"]')?.textContent).toContain('What should I do instead?');
    });

    it('follows the active locale', () => {
      setLocale('zh');
      renderer.appendInterruptIndicator();
      expect(container.querySelector('[data-i18n-text="interrupted.hint"]')?.textContent).toContain('接下来做什么？');
      setLocale('en');
    });

    it('tags the badge and hint with their keys and keeps the separator out of both', () => {
      // The " · " is locale-neutral punctuation; folding it into a keyed span
      // would make a repaint either swallow the separator or double it onto
      // words that already changed language.
      renderer.appendInterruptIndicator();
      const badge = container.querySelector('.co-ober-interrupted-badge') as HTMLElement;
      expect(badge.dataset.i18nText).toBe('interrupted.badge');
      const hint = container.querySelector('[data-i18n-text="interrupted.hint"]') as HTMLElement;
      expect(hint.textContent).toBe('What should I do instead?');
      expect(hint.textContent).not.toContain('\u00B7');
    });

    it('re-speaks a live interrupted row when the language changes', () => {
      renderer.appendInterruptIndicator();
      setLocale('zh');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-interrupted-badge')?.textContent).toBe('已中断');
      expect(container.querySelector('[data-i18n-text="interrupted.hint"]')?.textContent).toBe('接下来做什么？');
      setLocale('en');
    });
  });

  describe('renderStructuredMessage', () => {
    it('renders nothing without content blocks (legacy content is not re-rendered)', () => {
      const wrap = renderer.renderStructuredMessage({
        role: 'assistant',
        content: 'legacy text',
        type: 'text',
        timestamp: 1,
      });
      expect(wrap.childElementCount).toBe(0);
    });

    it('statically re-renders a persisted tool_use block with title and status', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            {
              type: 'tool_use',
              toolCallId: 'call-9',
              toolTitle: 'Search notes',
              toolKind: 'search',
              toolStatus: 'completed',
            },
          ],
        },
        wrap,
      );
      const tool = wrap.querySelector('.co-ober-tool-call') as HTMLElement | null;
      expect(tool).not.toBeNull();
      expect(tool?.dataset.toolId).toBe('call-9');
      expect(wrap.querySelector('.tc-kind')?.textContent).toBe('Search');
      expect(wrap.querySelector('.co-ober-tool-call-header')?.getAttribute('aria-label')).toContain('Search notes');
      expect(wrap.querySelector('.tc-stat')?.classList.contains('tc-stat-done')).toBe(true);
    });

    it('settles a persisted call that never reached a terminal state', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            {
              type: 'tool_use',
              toolCallId: 'call-open',
              toolTitle: 'Bash',
              toolKind: 'bash',
              toolStatus: 'in_progress',
            },
          ],
        },
        wrap,
      );
      // The transcript holds whatever status the last frame wrote. A turn that
      // was stopped, or a process that died mid-tool, leaves it open, and no
      // later frame will ever arrive to close it — so a spinner would run
      // forever on a conversation that cannot update again.
      expect(wrap.querySelector('.co-ober-tool-call')?.classList.contains('status-running')).toBe(false);
      expect(wrap.querySelector('.tc-stat')?.classList.contains('tc-stat-fail')).toBe(true);
      expect(wrap.querySelector('.co-ober-tool-call-body')?.textContent).toContain(t().interrupted.badge);
    });

    it('keeps a persisted failure failed and its own message intact', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            {
              type: 'tool_use',
              toolCallId: 'call-fail',
              toolTitle: 'Bash',
              toolKind: 'bash',
              toolStatus: 'failed',
              toolError: 'exit code 3',
            },
          ],
        },
        wrap,
      );
      // The clamp is for open states only. Replacing a stored error with
      // "interrupted" would rewrite what the tool actually reported.
      expect(wrap.querySelector('.co-ober-tool-call')?.classList.contains('status-error')).toBe(true);
      expect(wrap.querySelector('.co-ober-tool-call-body')?.textContent).toContain('exit code 3');
      expect(wrap.querySelector('.co-ober-tool-call-body')?.textContent).not.toContain(t().interrupted.badge);
    });

    it('renders text blocks in order', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: 'answer',
          type: 'text',
          timestamp: 1,
          contentBlocks: [{ type: 'text', text: 'answer' }],
        },
        wrap,
      );
      expect(wrap.querySelector('.co-ober-text-block')).not.toBeNull();
    });

    it('renders a persisted image block inline like the live paint', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            { type: 'image', mimeType: 'image/png', data: 'AAA=' },
            { type: 'image', mimeType: '', data: 'BBB=' },
          ],
        },
        wrap,
      );
      const imgs = wrap.querySelectorAll('.co-ober-assistant-image');
      expect(imgs.length).toBe(1);
      expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAA=');
    });

    it('renders a native usage footer alongside duration', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: 'answer',
          type: 'text',
          timestamp: 1,
          durationSeconds: 3,
          usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cost: 0.0123 },
          contentBlocks: [{ type: 'text', text: 'answer' }],
        },
        wrap,
      );
      const footer = wrap.querySelector('.co-ober-response-footer');
      expect(footer?.querySelector('.co-ober-baked-duration')?.textContent).toContain('3');
      expect(footer?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑1200 · ↓80 · 0.0123');
    });

    it('re-renders a persisted tool_use block with its native error', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            {
              type: 'tool_use',
              toolCallId: 'call-err',
              toolTitle: 'Edit note',
              toolKind: 'read',
              toolStatus: 'failed',
              toolError: 'Could not find oldString',
            },
          ],
        },
        wrap,
      );
      const tool = wrap.querySelector('.co-ober-tool-call') as HTMLElement | null;
      expect(tool).not.toBeNull();
      expect(tool?.classList.contains('status-error')).toBe(true);
      expect(tool?.querySelector('.co-ober-tool-call-body')?.textContent).toContain('Could not find oldString');
    });

    it('treats a block with only an error as failed', () => {
      const wrap = document.createElement('div');
      renderer.renderStructuredMessage(
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [
            { type: 'tool_use', toolCallId: 'call-x', toolKind: 'search', toolError: 'boom' },
          ],
        },
        wrap,
      );
      const tool = wrap.querySelector('.co-ober-tool-call') as HTMLElement | null;
      expect(tool?.classList.contains('status-error')).toBe(true);
    });
  });

  describe('formatMessageUsage', () => {
    it('formats token deltas and cost', () => {
      expect(formatMessageUsage({ inputTokens: 100, outputTokens: 20, cost: 0.001 })).toBe('↑100 · ↓20 · 0.0010');
      expect(formatMessageUsage({ inputTokens: 100, outputTokens: 20, cost: 0 })).toBe('↑100 · ↓20');
      expect(formatMessageUsage({ totalTokens: 500 })).toBe('500 tokens');
      expect(formatMessageUsage({})).toBe('');
    });

    it('renders cost with the currency symbol for known codes', () => {
      expect(formatMessageUsage({ cost: 1.5, costCurrency: 'EUR' })).toBe('€1.5000');
      expect(formatMessageUsage({ cost: 2, costCurrency: 'CNY' })).toBe('¥2.0000');
      expect(formatMessageUsage({ cost: 2, costCurrency: 'JPY' })).toBe('¥2.0000');
      expect(formatMessageUsage({ cost: 2, costCurrency: 'GBP' })).toBe('£2.0000');
      expect(formatMessageUsage({ cost: 2, costCurrency: 'USD' })).toBe('$2.0000');
    });

    it('falls back to the raw currency code for unknown currencies', () => {
      expect(formatMessageUsage({ cost: 0.5, costCurrency: 'BTC' })).toBe('BTC 0.5000');
    });

    it('renders a cost with no currency as a bare number, not dollars', () => {
      // The agent named an amount but no currency; prepending "$" would
      // invent one it never reported.
      expect(formatMessageUsage({ cost: 1.25 })).toBe('1.2500');
    });

    it('maps currency symbols via currencySymbol', () => {
      // A bare number names no currency: "$" would assert one the agent
      // never reported, so the no-code case stays empty.
      expect(currencySymbol()).toBe('');
      expect(currencySymbol('USD')).toBe('$');
      expect(currencySymbol('EUR')).toBe('€');
      expect(currencySymbol('ZZZ')).toBe('ZZZ ');
    });
  });

  describe('user-turn rewind actions', () => {
    it('renders no actions when no rewind handlers are installed', () => {
      renderer.addUserMessage('Hello');
      expect(container.querySelector('.co-ober-user-actions')).toBeNull();
    });

    it('renders regenerate and edit buttons per user message with 1-based ordinals', () => {
      const onRegenerate = vi.fn();
      renderer.setRewindHandlers({ onRegenerate, onEditResend: vi.fn() });
      renderer.addUserMessage('first');
      renderer.addUserMessage('second');

      const actionBars = container.querySelectorAll('.co-ober-user-actions');
      expect(actionBars).toHaveLength(2);
      const firstBtns = actionBars[0].querySelectorAll('button');
      expect(firstBtns).toHaveLength(2);
      expect(firstBtns[0].title).toBe('Regenerate from here');
      expect(firstBtns[1].title).toBe('Edit & resend');

      (firstBtns[0] as HTMLElement).click();
      expect(onRegenerate).toHaveBeenCalledWith(1);
      (container.querySelectorAll('.co-ober-user-actions')[1].querySelector('button') as HTMLElement).click();
      expect(onRegenerate).toHaveBeenCalledWith(2);
    });

    it('resets turn ordinals on clear', () => {
      const onRegenerate = vi.fn();
      renderer.setRewindHandlers({ onRegenerate, onEditResend: vi.fn() });
      renderer.addUserMessage('one');
      renderer.clear();
      renderer.addUserMessage('two');

      (container.querySelector('.co-ober-user-actions button') as HTMLElement).click();
      expect(onRegenerate).toHaveBeenCalledTimes(1);
      expect(onRegenerate).toHaveBeenCalledWith(1);
    });

    it('edit flow resends the edited content without rewriting the stored bubble', () => {
      const onEditResend = vi.fn();
      renderer.setRewindHandlers({ onRegenerate: vi.fn(), onEditResend });
      renderer.addUserMessage('original');

      const wrap = container.querySelector('.co-ober-msg.user')!;
      (wrap.querySelector('.co-ober-user-actions button:nth-child(2)') as HTMLElement).click();
      const textarea = wrap.querySelector('.co-ober-user-edit textarea') as HTMLTextAreaElement;
      expect(textarea).not.toBeNull();
      expect(textarea.value).toBe('original');

      textarea.value = '  edited text  ';
      const editBtns = wrap.querySelectorAll('.co-ober-user-edit-actions button');
      expect(editBtns).toHaveLength(2);
      (editBtns[0] as HTMLElement).click();

      expect(onEditResend).toHaveBeenCalledWith(1, 'edited text');
      // The bubble is left as the store holds it until the rewind actually
      // succeeds and repaints from the store; a rewind that refuses (busy, no
      // session, renew failed) returns without touching this DOM, so painting
      // the edit here would leave a changed question shown as though it had been
      // asked when the message on record is still the original.
      expect(wrap.querySelector('.co-ober-msg-body')!.textContent).toBe('original');
      expect(wrap.querySelector('.co-ober-user-edit')).toBeNull();
    });

    it('leaves the stored question intact when the rewind does not repaint it', () => {
      // Mirrors the refusal paths in rewindUserTurn: the handler is notified but
      // nothing rebuilds the transcript, so an optimistic write to the bubble
      // would be the only sign of an edit that was never actually sent.
      const onEditResend = vi.fn();
      renderer.setRewindHandlers({ onRegenerate: vi.fn(), onEditResend });
      renderer.addUserMessage('what was really asked');

      const wrap = container.querySelector('.co-ober-msg.user')!;
      (wrap.querySelector('.co-ober-user-actions button:nth-child(2)') as HTMLElement).click();
      (wrap.querySelector('.co-ober-user-edit textarea') as HTMLTextAreaElement).value = 'rewritten';
      (wrap.querySelectorAll('.co-ober-user-edit-actions button')[0] as HTMLElement).click();

      expect(onEditResend).toHaveBeenCalledWith(1, 'rewritten');
      expect(wrap.querySelector('.co-ober-msg-body')!.textContent).toBe('what was really asked');
    });

    it('cancel discards the edit without notifying', () => {
      const onEditResend = vi.fn();
      renderer.setRewindHandlers({ onRegenerate: vi.fn(), onEditResend });
      renderer.addUserMessage('keep me');

      const wrap = container.querySelector('.co-ober-msg.user')!;
      (wrap.querySelector('.co-ober-user-actions button:nth-child(2)') as HTMLElement).click();
      const textarea = wrap.querySelector('.co-ober-user-edit textarea') as HTMLTextAreaElement;
      textarea.value = 'discarded';
      (wrap.querySelectorAll('.co-ober-user-edit-actions button')[1] as HTMLElement).click();

      expect(onEditResend).not.toHaveBeenCalled();
      expect(wrap.querySelector('.co-ober-user-edit')).toBeNull();
      expect(wrap.querySelector('.co-ober-msg-body')!.textContent).toBe('keep me');
    });

    it('blank edited text resends nothing', () => {
      const onEditResend = vi.fn();
      renderer.setRewindHandlers({ onRegenerate: vi.fn(), onEditResend });
      renderer.addUserMessage('text');

      const wrap = container.querySelector('.co-ober-msg.user')!;
      (wrap.querySelector('.co-ober-user-actions button:nth-child(2)') as HTMLElement).click();
      (wrap.querySelector('.co-ober-user-edit textarea') as HTMLTextAreaElement).value = '   ';
      (wrap.querySelectorAll('.co-ober-user-edit-actions button')[0] as HTMLElement).click();

      expect(onEditResend).not.toHaveBeenCalled();
      expect(wrap.querySelector('.co-ober-msg-body')!.textContent).toBe('text');
    });
  });

  describe('assistant placeholder', () => {
    it('adds placeholder', () => {
      renderer.addAssistantPlaceholder();
      const placeholder = container.querySelector('.co-ober-loading');
      expect(placeholder).not.toBeNull();
    });

    it('removes placeholder', () => {
      renderer.addAssistantPlaceholder();
      renderer.removeAssistantPlaceholder();
      const placeholder = container.querySelector('.co-ober-loading');
      expect(placeholder).toBeNull();
    });

    it('does not create duplicate placeholders', () => {
      renderer.addAssistantPlaceholder();
      renderer.addAssistantPlaceholder();
      const placeholders = container.querySelectorAll('.co-ober-loading');
      expect(placeholders.length).toBe(1);
    });
  });

  describe('appendText', () => {
    it('creates assistant message element', () => {
      renderer.appendText('Hello');
      const msg = container.querySelector('.co-ober-msg.assistant');
      expect(msg).not.toBeNull();
    });

    it('appends text to existing message', () => {
      renderer.appendText('Hello', 'msg-1');
      renderer.appendText(' world', 'msg-1');
      // The text is accumulated and rendered asynchronously
      expect(container.querySelector('.co-ober-msg.assistant')).not.toBeNull();
    });

    it('creates new element for different message id', () => {
      renderer.appendText('Hello', 'msg-1');
      renderer.appendText('World', 'msg-2');
      const msgs = container.querySelectorAll('.co-ober-msg.assistant');
      expect(msgs.length).toBe(2);
    });

    it('attaches a native usage footer when restoring with stats', () => {
      renderer.appendText('Hello', 'msg-1', 1, { inputTokens: 100, outputTokens: 20, cost: 0.001 });
      const msg = container.querySelector('.co-ober-msg.assistant');
      expect(msg?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑100 · ↓20 · 0.0010');
      // The footer never replaces the message body.
      expect(msg?.querySelector('.co-ober-msg-body')).not.toBeNull();
    });

    it('renders reload-safe throughput from turn stats after usage', () => {
      renderer.appendText(
        'Hello',
        'msg-1',
        1,
        { inputTokens: 100, outputTokens: 20, cost: 0.001 },
        { outputTokens: 40, durationMs: 4000 },
      );
      const msg = container.querySelector('.co-ober-msg.assistant');
      expect(msg?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑100 · ↓20 · 0.0010 · 10.0 tok/s');
    });

    it('renders throughput alone when no native usage exists', () => {
      renderer.appendText('Hello', 'msg-1', 1, undefined, { outputTokens: 40, durationMs: 4000 });
      const msg = container.querySelector('.co-ober-msg.assistant');
      expect(msg?.querySelector('.co-ober-msg-usage')?.textContent).toBe('10.0 tok/s');
    });

    it('omits the footer when the turn was too short to measure', () => {
      renderer.appendText('Hello', 'msg-1', 1, undefined, { outputTokens: 40, durationMs: 500 });
      const msg = container.querySelector('.co-ober-msg.assistant');
      expect(msg?.querySelector('.co-ober-msg-usage')).toBeNull();
    });
  });

  describe('markdown render pipeline', () => {
    async function renderSpy(): Promise<ReturnType<typeof vi.fn>> {
      const { MarkdownRenderer } = await import('obsidian');
      const spy = MarkdownRenderer.render as unknown as ReturnType<typeof vi.fn>;
      spy.mockReset();
      spy.mockResolvedValue(undefined);
      return spy;
    }

    async function runTextRender(): Promise<void> {
      renderer.cancelTextRender();
      await Reflect.get(renderer, 'executeTextRender').call(renderer);
    }

    it('renders assistant markdown into a .markdown-rendered placeholder so list markers survive', async () => {
      const spy = await renderSpy();
      renderer.appendText('1. one');
      await runTextRender();
      const placeholder = container.querySelector('.md-render-subsystem');
      expect(placeholder).not.toBeNull();
      expect(placeholder?.classList.contains('markdown-rendered')).toBe(true);
      expect(spy).toHaveBeenCalled();
    });

    it('adds copy buttons to code blocks but leaves mermaid fences untouched', async () => {
      const spy = await renderSpy();
      spy.mockImplementation((_app: unknown, _md: unknown, el: HTMLElement) => {
        el.innerHTML =
          '<pre><code class="language-js">let a = 1;</code></pre>' +
          '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
        return Promise.resolve();
      });
      renderer.appendText('code');
      await runTextRender();
      const pres = container.querySelectorAll('pre');
      expect(pres.length).toBe(2);
      expect(pres[0].querySelector('.co-ober-copy-btn')).not.toBeNull();
      expect(pres[0].classList.contains('co-ober-code-block')).toBe(true);
      expect(pres[1].querySelector('.co-ober-copy-btn')).toBeNull();
      expect(pres[1].classList.contains('co-ober-code-block')).toBe(false);
      spy.mockResolvedValue(undefined);
    });

    it('defers streaming re-renders while the user is selecting text in the chat', async () => {
      const spy = await renderSpy();
      const anchor = document.createElement('span');
      container.appendChild(anchor);
      const selectionSpy = vi
        .spyOn(document, 'getSelection')
        .mockReturnValue({ isCollapsed: false, rangeCount: 1, anchorNode: anchor } as unknown as Selection);
      const frames: Array<FrameRequestCallback> = [];
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });

      renderer.appendText('stream');
      // scheduleTextRender arms its frame before scrollToBottom's, so frames[0]
      // is the markdown pass; with a live selection it must defer and re-arm.
      frames[0](0);
      expect(spy).not.toHaveBeenCalled();
      expect(frames.length).toBeGreaterThan(1);

      selectionSpy.mockReturnValue(null);
      await renderer.flushTextRender();
      expect(spy).toHaveBeenCalled();
      rafSpy.mockRestore();
      selectionSpy.mockRestore();
    });

    it('re-runs the pass when text arrives while markdown rendering awaits', async () => {
      const spy = await renderSpy();
      const texts: string[] = [];
      spy.mockImplementation(async (_app: unknown, text: string) => {
        texts.push(text);
        if (texts.length === 1) renderer.appendText(' tail');
        return undefined;
      });

      renderer.appendText('head');
      await runTextRender();
      expect(texts[texts.length - 1]).toBe('head');
      await renderer.flushTextRender();

      // The mid-render chunk must not be stranded: a second pass carries it.
      expect(texts.length).toBe(2);
      expect(texts[1]).toBe('head tail');
      spy.mockReset();
    });
  });

  describe('showUsage throughput', () => {
    it('appends tok/s derived from native output+thinking evidence', () => {
      renderer.showUsage({
        totalTokens: 500,
        inputTokens: 100,
        outputTokens: 300,
        thoughtTokens: 100,
        elapsedMs: 2000,
        modelId: 'provider/claude',
      });
      const el = container.querySelector('.co-ober-usage') as HTMLElement;
      expect(el.textContent).toContain('200.0 tok/s');
      expect(el.title).toContain('Rate: 200.0 tok/s');
    });

    it('omits tok/s without generated tokens or a measurable wall clock', () => {
      renderer.showUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 2000 });
      expect(container.querySelector('.co-ober-usage')?.textContent).not.toContain('tok/s');
      renderer.showUsage({ totalTokens: 40, inputTokens: 10, outputTokens: 30, elapsedMs: 800 });
      expect(container.querySelector('.co-ober-usage')?.textContent).not.toContain('tok/s');
    });

    it('shows the clamped context percentage in the usage line and title', () => {
      renderer.showUsage({
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 4500,
        contextWindow: 10000,
      });
      const el = container.querySelector('.co-ober-usage') as HTMLElement;
      expect(el.textContent).toContain('45%');
      expect(el.title).toContain('Context: 45%');
    });

    it('names no input/output figure the footer also refuses to assert', () => {
      // A context-only reading leaves inputTokens/outputTokens at 0. The
      // visible footer skips a zero, but the hover used to print
      // "Input: 0, Output: 0" for a figure nobody ever reported.
      renderer.showUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0, contextTokens: 4500, contextWindow: 10000 });
      const title = (container.querySelector('.co-ober-usage') as HTMLElement).title;
      expect(title).not.toContain('Input');
      expect(title).not.toContain('Output');
      // A turn that did report its tokens still says so in the tooltip.
      renderer.showUsage({ totalTokens: 30, inputTokens: 20, outputTokens: 10 });
      const titled = (container.querySelector('.co-ober-usage') as HTMLElement).title;
      expect(titled).toContain('Input: 20');
      expect(titled).toContain('Output: 10');
    });
  });

  describe('contextPercentage', () => {
    it('clamps rounded context occupancy to 0..100', () => {
      expect(contextPercentage({ contextTokens: 4500, contextWindow: 10000 })).toBe(45);
      expect(contextPercentage({ contextTokens: 12000, contextWindow: 10000 })).toBe(100);
      expect(contextPercentage({ contextTokens: -5, contextWindow: 10000 })).toBe(0);
    });

    it('returns null without a known context window', () => {
      expect(contextPercentage({ contextTokens: 100, contextWindow: 0 })).toBeNull();
      expect(contextPercentage({})).toBeNull();
    });

    it('keeps an unreported figure out of the reading rather than calling it 0%', () => {
      // 0% is a claim about the conversation: the window is empty. A session
      // that never reported its context usage says nothing of the kind, and the
      // meter had been answering the question it was asked with a made-up zero.
      expect(contextPercentage({ contextWindow: 100000 })).toBeNull();
      expect(contextPercentage({ contextTokens: undefined, contextWindow: 100000 })).toBeNull();
      expect(contextPercentage({ contextTokens: 0, contextWindow: 100000 })).toBe(0);
    });
  });

  describe('appendThinking', () => {
    it('creates thinking block', () => {
      renderer.appendThinking('Thinking...');
      const thinking = container.querySelector('.co-ober-thinking-block');
      expect(thinking).not.toBeNull();
    });

    it('creates header', () => {
      renderer.appendThinking('Thinking...');
      const header = container.querySelector('.co-ober-thinking-header');
      expect(header).not.toBeNull();
    });

    it('collapses by default', () => {
      renderer.appendThinking('Thinking...');
      const box = container.querySelector('.co-ober-thinking-block') as HTMLElement;
      expect(box?.classList.contains('is-collapsed')).toBe(true);
    });

    it('toggles on header click', () => {
      renderer.appendThinking('Thinking...');
      const header = container.querySelector('.co-ober-thinking-header') as HTMLElement;
      const box = container.querySelector('.co-ober-thinking-block') as HTMLElement;

      header.click();
      expect(box.classList.contains('is-collapsed')).toBe(false);

      header.click();
      expect(box.classList.contains('is-collapsed')).toBe(true);
    });

    it('finalizes thinking block', () => {
      renderer.appendThinking('Thinking about something...');
      const elapsed = renderer.finalizeCurrentThinking();
      expect(elapsed).toBeGreaterThanOrEqual(0);
      // After finalize, the block should be collapsed
      const box = container.querySelector('.co-ober-thinking-block') as HTMLElement;
      expect(box?.classList.contains('is-thinking')).toBe(false);
    });

    it('says the settled thinking over in the language just chosen', () => {
      renderer.appendThinking('deep thought');
      renderer.finalizeCurrentThinking();

      const label = container.querySelector('.co-ober-thinking-label') as HTMLElement;
      const timer = container.querySelector('.co-ober-thinking-timer') as HTMLElement;
      expect(label.textContent).toBe('Thought');
      expect(timer.textContent).toBe('for 0s');

      setLocale('zh');
      try {
        renderer.refreshLocale();
        // The duration is the half with a number in it: the repaint has to rebuild
        // the phrase around the seconds this block actually took rather than print
        // the template it looked up, and a settled block never ticks to fix itself.
        expect(label.textContent).toBe('已思考');
        expect(timer.textContent).toBe('持续 0秒');
      } finally {
        setLocale('en');
      }
    });
  });

  describe('addStoredThinking', () => {
    it('draws a restored thought past-tense, never ticking', () => {
      // A saved transcript reaches paintTranscript as one finished block. The
      // old code fed it to appendThinking, so it opened as a live "Thinking…"
      // bubble — is-thinking plus a running timer — advertising work that had
      // already been written down.
      renderer.addStoredThinking('a thought from history');
      const box = container.querySelector('.co-ober-thinking-block') as HTMLElement;
      expect(box).not.toBeNull();
      expect(box.classList.contains('is-thinking')).toBe(false);
      const label = container.querySelector('.co-ober-thinking-label') as HTMLElement;
      expect(label.textContent).toBe('Thought');
    });

    it('invents no duration for a thought that never reported one', () => {
      renderer.addStoredThinking('a thought from history');
      // Nothing persists a stored block's duration, so renderStoredThinkingBlock
      // omits the timer entirely rather than stamping a fabricated "for Ns".
      expect(container.querySelector('.co-ober-thinking-timer')).toBeNull();
    });

    it('leaves no live thinking state for the transcript to finalize', () => {
      renderer.addStoredThinking('a thought from history');
      expect(renderer.finalizeCurrentThinking()).toBe(0);
    });
  });

  describe('a render the reader is in the middle of', () => {
    let frames: FrameRequestCallback[];

    beforeEach(() => {
      frames = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    });

    afterEach(async () => {
      renderer.cancelThinkingRender();
      vi.restoreAllMocks();
      const { MarkdownRenderer } = await import('obsidian');
      const render = MarkdownRenderer.render as unknown as ReturnType<typeof vi.fn>;
      render.mockReset();
      render.mockResolvedValue(undefined);
    });

    async function thinkingRenderSpy(): Promise<ReturnType<typeof vi.fn>> {
      const { MarkdownRenderer } = await import('obsidian');
      const spy = MarkdownRenderer.render as unknown as ReturnType<typeof vi.fn>;
      spy.mockReset();
      spy.mockImplementation((_app: unknown, text: string, el: HTMLElement) => {
        el.textContent = String(text);
        return Promise.resolve();
      });
      return spy;
    }

    function expandedThinkingBody(): HTMLElement {
      const box = container.querySelector('.co-ober-thinking-block') as HTMLElement;
      (box.querySelector('.co-ober-thinking-header') as HTMLElement).click();
      return box.querySelector('.co-ober-thinking-body') as HTMLElement;
    }

    function runArmed(start: number): void {
      for (const cb of frames.slice(start)) cb(0);
    }

    it('does not rebuild an expanded thinking block under a live selection', async () => {
      const spy = await thinkingRenderSpy();
      renderer.appendThinking('first part');
      const body = expandedThinkingBody();
      // The expand itself renders; start from a clean record.
      spy.mockClear();
      frames.length = 0;

      renderer.scheduleThinkingRender();
      runArmed(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(body.textContent).toBe('first part');

      // The reader is now dragging across that sentence. The next pass would
      // empty() the body out from under the mouse, which collapses the
      // selection and leaves them copying the wrong words.
      vi
        .spyOn(document, 'getSelection')
        .mockReturnValue({ isCollapsed: false, rangeCount: 1, anchorNode: body } as unknown as Selection);
      spy.mockClear();
      frames.length = 0;
      renderer.appendThinking(' second part');
      runArmed(0);
      expect(spy).not.toHaveBeenCalled();
      expect(body.textContent).toBe('first part');

      // Deferring costs formatting for a frame, never content: finalize still
      // writes the whole thought back into the body it left standing.
      vi.spyOn(document, 'getSelection').mockReturnValue(null);
      renderer.finalizeCurrentThinking();
      expect(body.textContent).toBe('first part second part');
    });

    it('still formats a thinking block nobody is holding', async () => {
      const spy = await thinkingRenderSpy();
      renderer.appendThinking('plain thought');
      const body = expandedThinkingBody();
      spy.mockClear();
      frames.length = 0;

      renderer.scheduleThinkingRender();
      runArmed(0);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(body.textContent).toBe('plain thought');
    });

    it('reports the transcript busy while the caret or a selection lives in it', () => {
      const inside = container.createEl('button');
      const outside = document.body.createEl('input');
      expect(renderer.holdsReaderAttention()).toBe(false);

      inside.focus();
      expect(renderer.holdsReaderAttention()).toBe(true);

      outside.focus();
      expect(renderer.holdsReaderAttention()).toBe(false);

      vi
        .spyOn(document, 'getSelection')
        .mockReturnValue({ isCollapsed: false, rangeCount: 1, anchorNode: container } as unknown as Selection);
      expect(renderer.holdsReaderAttention()).toBe(true);
      vi.spyOn(document, 'getSelection').mockReturnValue(null);

      // A control that has since left the DOM cannot keep holding the reader.
      inside.focus();
      inside.remove();
      outside.remove();
      expect(renderer.holdsReaderAttention()).toBe(false);
    });
  });

  describe('setPlanEntries status marks (0.2.14 stage 2)', () => {
    const items = () => Array.from(container.querySelectorAll('.plan-item')).map((el) => el.textContent ?? '');

    it('shows the open circle only for a pending entry, not an unknown one', () => {
      renderer.setPlanEntries([
        { content: 'known', status: 'pending' },
        { content: 'unknown', status: 'archived' },
      ]);
      const marks = items();
      expect(marks[0]).toBe('○ known');
      // The open circle claims "not started yet", which only `pending` earns; a
      // status this client does not know gets a neutral mark instead of lying.
      expect(marks[1]).toBe('· unknown');
    });

    it('keeps the three marks it can name', () => {
      renderer.setPlanEntries([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
      ]);
      expect(items()).toEqual(['✓ a', '⟳ b', '○ c']);
    });
  });

  describe('setPlanStale', () => {
    const noteBody = () => container.querySelector('.co-ober-msg.system .co-ober-msg-body');
    it('says the plan could not be read instead of redrawing the old list', () => {
      renderer.setPlanEntries([{ content: 'step one', status: 'completed' }]);
      renderer.setPlanStale(true);
      expect(noteBody()?.textContent).toContain('The plan could not be read');
    });

    it('retires the note once a reading arrives', () => {
      renderer.setPlanEntries([{ content: 'step one', status: 'completed' }]);
      renderer.setPlanStale(true);
      renderer.setPlanStale(false);
      expect(container.querySelector('.co-ober-msg.system')).toBeNull();
    });

    it('stays quiet when there is no plan on screen to go stale', () => {
      // A transcript that never showed a plan has nothing to qualify; nagging
      // about an unreadable list would invent a panel the reader never saw.
      renderer.setPlanStale(true);
      expect(container.querySelector('.co-ober-msg.system')).toBeNull();
    });

    it('withdraws the stale note when a live plan frame repaints the list', () => {
      // The wire-frame path stamps lastPlanUpdateAt to now, which gates out the
      // post-turn DB resync, so a just-streamed plan used to sit under the
      // "could not be read" caveat that the previous failed resync left up. The
      // rows on screen now contradict that note, so painting them retires it.
      renderer.setPlanEntries([{ content: 'step one', status: 'completed' }]);
      renderer.setPlanStale(true);
      expect(noteBody()).not.toBeNull();
      renderer.setPlanEntries([{ content: 'step two', status: 'in_progress' }]);
      expect(container.querySelector('.co-ober-msg.system')).toBeNull();
      const items = container.querySelectorAll('.co-ober-plan-panel .plan-item');
      expect(items.length).toBe(1);
      expect(items[0]?.textContent).toContain('step two');
    });
  });

  describe('addToolCall', () => {
    it('creates tool call element', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const toolCall = container.querySelector('.co-ober-tool-call');
      expect(toolCall).not.toBeNull();
    });

    it('shows kind', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const kind = container.querySelector('.tc-kind');
      expect(kind?.textContent).toBe('Search');
    });

    it('shows file name from input', () => {
      renderer.addToolCall('call-1', 'Edit', 'edit', { filePath: '/path/to/file.ts' });
      const file = container.querySelector('.tc-file');
      expect(file?.textContent).toBe('file.ts');
    });

    it('toggles body on header click', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const header = container.querySelector('.co-ober-tool-call-header') as HTMLElement;
      const box = container.querySelector('.co-ober-tool-call') as HTMLElement;

      expect(box.classList.contains('is-collapsed')).toBe(true);
      header.click();
      expect(box.classList.contains('is-collapsed')).toBe(false);
      header.click();
      expect(box.classList.contains('is-collapsed')).toBe(true);
    });

    it('closes the answer bubble so the text after a card starts its own', () => {
      renderer.appendText('before the call', 'msg-1');
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.appendText('after the call', 'msg-1');

      const order = Array.from(container.children).map((el) => (el.querySelector('.co-ober-tool-call') ? 'card' : 'bubble'));
      // The text streamed after a tool call used to be appended to the bubble
      // above the card, so the order on screen stopped matching the block order
      // a reload paints.
      expect(order).toEqual(['bubble', 'card', 'bubble']);
    });

    it('paints the status a card was surfaced with, so a running call says so at once', () => {
      renderer.addToolCall('call-1', 'Bash', 'bash', {}, undefined, 'in_progress');

      expect(container.querySelector('.co-ober-tool-call')?.classList.contains('status-running')).toBe(true);
      expect(container.querySelector('.tc-stat')?.classList.contains('spin')).toBe(true);
    });
  });

  describe('updateToolCall', () => {
    function flushToolRenders(): void {
      renderer.flushAllToolRenders();
    }

    it('updates status to completed', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall(
        'call-1',
        'completed',
        {},
        [{ type: 'content', content: { type: 'text', text: 'Result' } }],
        undefined,
        undefined,
        'search',
      );
      flushToolRenders();
      const stat = container.querySelector('.tc-stat');
      expect(stat?.classList.contains('tc-stat-done')).toBe(true);
      // Status icon is now SVG (check icon), so textContent should be empty
      expect(stat?.textContent?.trim() || '').toBe('');
    });

    it('updates status to in_progress', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall('call-1', 'in_progress', undefined, undefined, undefined, undefined, 'search');
      flushToolRenders();
      const stat = container.querySelector('.tc-stat');
      expect(stat?.classList.contains('spin')).toBe(true);
    });

    it('updates status to failed', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall('call-1', 'failed', undefined, undefined, undefined, undefined, 'search');
      flushToolRenders();
      const stat = container.querySelector('.tc-stat');
      expect(stat?.classList.contains('tc-stat-fail')).toBe(true);
    });

    it('does nothing for unknown tool id', () => {
      renderer.updateToolCall('unknown', 'completed', undefined, undefined, undefined, undefined, 'other');
      // Should not throw
    });

    it('keeps the kind the card was created with when a frame does not name one', () => {
      setLocale('zh');
      try {
        renderer.addToolCall('call-zh', 'Search notes', 'search', {});
        renderer.updateToolCall('call-zh', 'in_progress', undefined, undefined, undefined, undefined, undefined);
        flushToolRenders();

        const kindEl = container.querySelector('.tc-kind') as HTMLElement;
        expect(kindEl.textContent).toBe('搜索');
        // The label on screen, lowercased, used to be the fallback. So the
        // attribute the locale repaint reads — and every branch that compares a
        // kind to "search" or "read" — was handed a Chinese word that matches no
        // locale key and no icon, and the card came back from a language switch
        // named with that word rather than with the kind.
        expect(kindEl.dataset.i18nKind).toBe('search');
        setLocale('en');
        renderer.refreshLocale();
        expect(kindEl.textContent).toBe('Search');
      } finally {
        setLocale('en');
      }
    });

    it('renames the status glyph in the language the reader switched to', () => {
      renderer.addToolCall('call-stat', 'Read a note', 'read', {});
      renderer.updateToolCall('call-stat', 'completed', undefined, undefined, undefined, undefined, 'read');
      flushToolRenders();

      const stat = container.querySelector('.tc-stat') as HTMLElement;
      // The name of the state lives only on the icon: aria-label and title. Left
      // untagged, a card finished before the switch went on telling a screen
      // reader "Completed" in a transcript that now says 已完成 everywhere else.
      expect(stat.dataset.i18nLabel).toBe('tool.status.done');
      expect(stat.getAttribute('aria-label')).toBe('Completed');

      setLocale('zh');
      try {
        renderer.refreshLocale();
        expect(stat.getAttribute('aria-label')).toBe('已完成');
        expect(stat.getAttribute('title')).toBe('已完成');
      } finally {
        setLocale('en');
      }
    });

    it('renders diff content', () => {
      renderer.addToolCall('call-1', 'Edit', 'edit', {});
      renderer.updateToolCall(
        'call-1',
        'completed',
        {},
        [
          {
            type: 'diff',
            path: '/file.ts',
            oldText: 'old',
            newText: 'new',
          },
        ],
        undefined,
        undefined,
        'edit',
      );
      flushToolRenders();
      const writeEdit = container.querySelector('.co-ober-write-edit');
      expect(writeEdit).not.toBeNull();
      const diffLines = container.querySelectorAll('.diff-line');
      expect(diffLines.length).toBeGreaterThan(0);
    });

    it('renders a partial diff that only carries newText (insertion) or oldText (deletion)', () => {
      renderer.addToolCall('call-ins', 'Edit', 'edit', {});
      renderer.updateToolCall(
        'call-ins',
        'completed',
        {},
        [
          {
            type: 'diff',
            path: '/file.ts',
            newText: 'added line only',
          },
        ],
        undefined,
        undefined,
        'edit',
      );
      renderer.addToolCall('call-del', 'Edit', 'edit', {});
      renderer.updateToolCall(
        'call-del',
        'completed',
        {},
        [
          {
            type: 'diff',
            path: '/other.ts',
            oldText: 'removed line only',
          },
        ],
        undefined,
        undefined,
        'edit',
      );
      flushToolRenders();

      const edits = container.querySelectorAll('.co-ober-write-edit');
      expect(edits.length).toBe(2);
      expect(container.querySelectorAll('.diff-line').length).toBeGreaterThanOrEqual(2);
      expect(container.textContent).toContain('added line only');
      expect(container.textContent).toContain('removed line only');
    });
  });

  describe('image click preview', () => {
    it('opens a lightbox overlay when a chat image is clicked', () => {
      renderer.addUserMessage('look', 1, [{ mimeType: 'image/png', data: 'AAA=' }]);
      const img = container.querySelector('.co-ober-user-image') as HTMLImageElement;
      img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const preview = document.querySelector('.co-ober-img-overlay img') as HTMLImageElement | null;
      expect(preview).not.toBeNull();
      expect(preview?.getAttribute('src')).toBe('data:image/png;base64,AAA=');
      closeImagePreview();
    });

    it('ignores clicks that do not land on an image', () => {
      renderer.addUserMessage('plain text');
      (container.querySelector('.co-ober-msg-body') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      expect(document.querySelector('.co-ober-img-overlay')).toBeNull();
    });
  });

  describe('collapseTurns', () => {
    async function buildStepTurn() {
      renderer.addUserMessage('question');
      renderer.appendThinking('deep thought', 'm1');
      renderer.addToolCall('call-1', 'Search notes', 'search', {});
      renderer.appendText('the answer', 'm2');
      renderer.finalizeCurrentThinking();
      await renderer.flushTextRender();
    }

    it('folds thinking and tool wraps of a finished turn behind a summary header', async () => {
      await buildStepTurn();
      renderer.collapseTurns();

      const group = container.querySelector('.co-ober-turn-collapsed');
      expect(group).not.toBeNull();
      expect(group?.querySelector('.co-ober-turn-summary')?.textContent).toBe('2 steps');
      const body = group?.querySelector('.co-ober-turn-collapsed-body');
      expect(body?.querySelectorAll('.co-ober-msg.assistant')).toHaveLength(2);
      // user message and the final answer stay outside the group
      const directMsgs = Array.from(container.children).filter((c) => c.classList.contains('co-ober-msg'));
      expect(directMsgs).toHaveLength(2);
      expect(directMsgs[0].classList.contains('user')).toBe(true);
      expect(directMsgs[1].classList.contains('assistant')).toBe(true);
      // the answer wrap is the text wrap (direct .co-ober-msg-body child), not a step wrap
      expect(Array.from(directMsgs[1].children).some((c) => c.classList.contains('co-ober-msg-body'))).toBe(true);
    });

    it('toggles expansion when the header is clicked', async () => {
      await buildStepTurn();
      renderer.collapseTurns();
      const group = container.querySelector('.co-ober-turn-collapsed') as HTMLElement;
      const header = group.querySelector('.co-ober-turn-collapsed-header') as HTMLElement;
      header.click();
      expect(group.classList.contains('is-open')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      header.click();
      expect(group.classList.contains('is-open')).toBe(false);
    });

    it('is idempotent and only folds completed runs', async () => {
      await buildStepTurn();
      renderer.collapseTurns();
      const structure = container.innerHTML;
      renderer.collapseTurns();
      expect(container.innerHTML).toBe(structure);

      // a new turn after the collapsed one folds independently
      renderer.addUserMessage('follow-up');
      renderer.appendThinking('again', 'm3');
      renderer.appendText('second answer', 'm4');
      renderer.finalizeCurrentThinking();
      renderer.collapseTurns();
      expect(container.querySelectorAll('.co-ober-turn-collapsed')).toHaveLength(2);
    });

    it('leaves runs without thinking or tool steps expanded', () => {
      renderer.addUserMessage('q');
      renderer.appendText('first', 'x1');
      renderer.appendText('second', 'x2');
      renderer.collapseTurns();
      expect(container.querySelector('.co-ober-turn-collapsed')).toBeNull();
    });

    it('uses the localized summary text', async () => {
      setLocale('zh');
      await buildStepTurn();
      renderer.collapseTurns();
      expect(container.querySelector('.co-ober-turn-summary')?.textContent).toContain('个步骤');
      setLocale('en');
    });

    it('keeps the step count when refreshLocale relabels a collapsed turn', async () => {
      await buildStepTurn();
      renderer.collapseTurns();
      setLocale('zh');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-turn-summary')?.textContent).toBe('2 个步骤');
      setLocale('en');
    });
  });

  describe('addError locale re-speak', () => {
    it('re-speaks a token-free notice across a locale switch', () => {
      // A notice built straight from t() carries the key that drew it, so the
      // refreshLocale walker relabels it in place instead of leaving it frozen in
      // the language the error first surfaced in.
      renderer.addError(t().error.reconnected, undefined, undefined, 'error.reconnected');
      const textEl = container.querySelector('.co-ober-error-text') as HTMLElement;
      expect(textEl.dataset.i18nText).toBe('error.reconnected');
      expect(textEl.textContent).toBe(t().error.reconnected);

      setLocale('zh');
      const zh = t().error.reconnected;
      renderer.refreshLocale();
      expect(textEl.textContent).toBe(zh);
      setLocale('en');
    });

    it('leaves a token-bearing notice frozen — untagged, so a repaint cannot reprint its detail', () => {
      // The same text a humanizeError caller hands over is a one-time diagnosis
      // of a specific failure; without a key the walker skips it, and it keeps
      // the words it was drawn with rather than a template's leftover token.
      renderer.addError('Could not load: socket closed');
      const textEl = container.querySelector('.co-ober-error-text') as HTMLElement;
      expect(textEl.dataset.i18nText).toBeUndefined();

      setLocale('zh');
      renderer.refreshLocale();
      expect(textEl.textContent).toBe('Could not load: socket closed');
      setLocale('en');
    });

    it('re-speaks the action button and restores the live label once its action settles', async () => {
      let resolveDone = () => {};
      const done = new Promise<void>((r) => { resolveDone = r; });
      renderer.addError('boom', t().error.retry, () => done, undefined, 'error.retry');
      const btn = container.querySelector('.co-ober-error-action') as HTMLButtonElement;
      expect(btn.dataset.i18nText).toBe('error.retry');
      expect(btn.textContent).toBe(t().error.retry);

      // Switch language while the settled button is on screen: the fixed UI verb
      // re-speaks like the rest of the transcript.
      setLocale('zh');
      const zhRetry = t().error.retry;
      renderer.refreshLocale();
      expect(btn.textContent).toBe(zhRetry);

      // Press it. It disables to '...' for the in-flight action, then must come
      // back as the label in force NOW — re-assigning the English captured at
      // draw time would stamp the stale wording straight over the fresh one.
      btn.click();
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe('...');
      resolveDone();
      await done;
      await new Promise((r) => setTimeout(r, 0));
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe(zhRetry);
      setLocale('en');
    });
  });

  describe('refreshLocale', () => {
    it('relabels the loading placeholder and plan title in the live DOM', () => {
      renderer.addAssistantPlaceholder();
      renderer.setPlanEntries([{ content: 'step', status: 'in_progress' }]);

      setLocale('zh');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-loading span')?.textContent).toBe('思考中…');
      expect(container.querySelector('.plan-title')?.textContent).toBe('📋 计划');

      setLocale('en');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-loading span')?.textContent).toBe('Thinking…');
      expect(container.querySelector('.plan-title')?.textContent).toBe('📋 Plan');
    });

    it('relabels tool kind badges via their data tag', () => {
      renderer.addToolCall('call-1', 'Read note', 'read', {});
      expect(container.querySelector('.tc-kind')?.textContent).toBe('Read');
      setLocale('zh');
      renderer.refreshLocale();
      expect(container.querySelector('.tc-kind')?.textContent).toBe('读取');
      setLocale('en');
    });

    it('keeps a restored interrupt footer lowercase and in the new language', () => {
      // The footer badge is rendered lowercased to de-emphasize it; a repaint
      // that re-spoke the raw title-case word would flip its style, so the
      // lower-case intent rides a key the walker honours.
      renderer.renderStructuredMessage(
        { role: 'assistant', content: 'x', type: 'text', timestamp: 1, isInterrupt: true, contentBlocks: [{ type: 'text', text: 'x' }] },
        container,
      );
      expect(container.querySelector('.co-ober-interrupt-badge')?.textContent).toBe('interrupted');
      setLocale('zh');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-interrupt-badge')?.textContent).toBe('已中断');
      setLocale('en');
      renderer.refreshLocale();
      expect(container.querySelector('.co-ober-interrupt-badge')?.textContent).toBe('interrupted');
    });

    it('rebuilds collapsible aria-labels with the localized action word', () => {
      renderer.addToolCall('call-1', 'Read note', 'read', {});
      const header = container.querySelector('.co-ober-tool-call-header') as HTMLElement;
      expect(header.getAttribute('aria-label')).toContain('- click to expand');

      setLocale('zh');
      renderer.refreshLocale();
      expect(header.getAttribute('aria-label')).toContain('- 点击展开');

      // Expanded headers must relabel with the collapse word instead.
      header.click();
      renderer.refreshLocale();
      expect(header.getAttribute('aria-label')).toContain('- 点击收起');
      setLocale('en');
    });
  });

  describe('copy button reset timer', () => {
    it('leaves a detached button untouched when the reset timer fires', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
        configurable: true,
      });
      vi.useFakeTimers();
      try {
        const host = document.createElement('div');
        container.appendChild(host);
        renderer.addTextCopyButton(host, 'markdown body');
        const btn = host.querySelector('.co-ober-text-copy-btn') as HTMLButtonElement;

        btn.click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(btn.textContent).toBe('Copied');

        // Transcript torn down (session switch / rerender) before the revert fires.
        host.remove();
        vi.runAllTimers();
        expect(btn.textContent).toBe('Copied');
        expect(btn.isConnected).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('withholds "Copied" until the clipboard write resolves', async () => {
      let settle: () => void = () => {};
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: vi.fn(() => new Promise<void>((resolve) => { settle = resolve; })) } },
        configurable: true,
      });
      const host = document.createElement('div');
      container.appendChild(host);
      renderer.addTextCopyButton(host, 'markdown body');
      const btn = host.querySelector('.co-ober-text-copy-btn') as HTMLButtonElement;

      btn.click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(btn.textContent).toBe('Copy');

      settle();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(btn.textContent).toBe('Copied');
    });

    it('says the copy failed instead of claiming it succeeded', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) } },
        configurable: true,
      });
      const host = document.createElement('div');
      container.appendChild(host);
      renderer.addTextCopyButton(host, 'markdown body');
      const btn = host.querySelector('.co-ober-text-copy-btn') as HTMLButtonElement;

      btn.click();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(btn.textContent).toBe(t().copy.failed);
    });
  });

  describe('setActive (0.2.0 render gating)', () => {
    async function renderSpy(): Promise<ReturnType<typeof vi.fn>> {
      const { MarkdownRenderer } = await import('obsidian');
      const spy = MarkdownRenderer.render as unknown as ReturnType<typeof vi.fn>;
      spy.mockReset();
      spy.mockResolvedValue(undefined);
      return spy;
    }

    it('defers text renders while inactive and flushes exactly once on activation', async () => {
      const spy = await renderSpy();
      renderer.setActive(false);
      renderer.appendText('hidden', 'm1');
      await renderer.scheduleTextRender();
      expect(spy).not.toHaveBeenCalled();
      // DOM append still happened — the cheap lane is never gated.
      expect(container.querySelector('.co-ober-msg.assistant')).not.toBeNull();

      renderer.setActive(true);
      // Give the async executeTextRender pass time to reach the renderer.
      await new Promise((r) => setTimeout(r, 0));
      expect(spy).toHaveBeenCalled();

      // Activation is the flush point; a second activate must not re-render.
      spy.mockClear();
      renderer.setActive(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(spy).not.toHaveBeenCalled();
    });

    it('flushes the newest deferred callback per tool on activation', () => {
      renderer.setActive(false);
      const calls: string[] = [];
      renderer.scheduleToolRender('t1', () => calls.push('old'));
      renderer.scheduleToolRender('t1', () => calls.push('new'));
      renderer.scheduleToolRender('t2', () => calls.push('t2'));
      expect(calls).toEqual([]);

      const scroll = vi.spyOn(renderer, 'forceScrollToBottom');
      renderer.setActive(true);
      expect(calls).toEqual(['new', 't2']);
      expect(scroll).toHaveBeenCalledTimes(1);
      scroll.mockRestore();
    });

    it('marks thinking dirty while inactive and reschedules on activation', () => {
      renderer.setActive(false);
      const schedule = vi.spyOn(renderer as unknown as { scheduleThinkingRender: () => void }, 'scheduleThinkingRender');
      renderer.scheduleThinkingRender();
      expect(schedule).toHaveBeenCalledTimes(1);

      renderer.setActive(true);
      // setActive re-enters the gated method once the tab becomes visible.
      expect(schedule).toHaveBeenCalledTimes(2);
      schedule.mockRestore();
      renderer.cancelThinkingRender();
    });

    it('is idempotent for the current state', () => {
      const scroll = vi.spyOn(renderer, 'forceScrollToBottom');
      renderer.setActive(true);
      expect(scroll).not.toHaveBeenCalled();
      renderer.setActive(false);
      renderer.setActive(false);
      renderer.setActive(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      scroll.mockRestore();
    });

    it('keeps the reading position of a tab the reader had scrolled up in', () => {
      const scrolledUp = new ChatRenderer(container, app, () => false);
      scrolledUp.setActive(false);
      const scroll = vi.spyOn(scrolledUp, 'forceScrollToBottom');

      scrolledUp.setActive(true);

      expect(scroll).not.toHaveBeenCalled();
      scroll.mockRestore();
      scrolledUp.dispose();
    });
  });
});
