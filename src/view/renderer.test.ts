// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatRenderer, formatMessageUsage } from './renderer';
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
      expect(formatMessageUsage({ totalTokens: 500 })).toBe('500 tok');
      expect(formatMessageUsage({})).toBe('');
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
});
