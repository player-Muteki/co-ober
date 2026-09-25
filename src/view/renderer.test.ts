// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatRenderer, formatMessageUsage, currencySymbol, contextPercentage } from './renderer';
import { closeImagePreview } from './imagePreview';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

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
      expect(container.querySelector('.co-ober-interrupted-badge')).not.toBeNull();
      expect(container.querySelector('.co-ober-interrupted-hint')?.textContent).toContain('What should I do instead?');
    });

    it('follows the active locale', () => {
      setLocale('zh');
      renderer.appendInterruptIndicator();
      expect(container.querySelector('.co-ober-interrupted-hint')?.textContent).toContain('接下来做什么？');
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
      expect(footer?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑1200 · ↓80 · $0.0123');
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
      expect(formatMessageUsage({ inputTokens: 100, outputTokens: 20, cost: 0.001 })).toBe('↑100 · ↓20 · $0.0010');
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

    it('maps currency symbols via currencySymbol', () => {
      expect(currencySymbol()).toBe('$');
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

    it('edit flow swaps the bubble text and resends with the edited content', () => {
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
      expect(wrap.querySelector('.co-ober-msg-body')!.textContent).toBe('edited text');
      expect(wrap.querySelector('.co-ober-user-edit')).toBeNull();
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
      expect(msg?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑100 · ↓20 · $0.0010');
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
      expect(msg?.querySelector('.co-ober-msg-usage')?.textContent).toBe('↑100 · ↓20 · $0.0010 · 10.0 tok/s');
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
    it('leaves a detached button untouched when the reset timer fires', () => {
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
