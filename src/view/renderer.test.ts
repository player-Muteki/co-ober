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
    app = { vault: { getFiles: vi.fn().mockReturnValue([]) } };
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
      renderer.updateToolCall('call-1', 'completed', {}, [{ type: 'content', content: { type: 'text', text: 'Result' } }], undefined, undefined, 'search');
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
      renderer.updateToolCall('call-1', 'completed', {}, [{
        type: 'diff',
        path: '/file.ts',
        oldText: 'old',
        newText: 'new',
      }], undefined, undefined, 'edit');
      flushToolRenders();
      const writeEdit = container.querySelector('.co-ober-write-edit');
      expect(writeEdit).not.toBeNull();
      const diffLines = container.querySelectorAll('.diff-line');
      expect(diffLines.length).toBeGreaterThan(0);
    });
  });
});
