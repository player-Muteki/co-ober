// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatRenderer } from './renderer';
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
  });
});
