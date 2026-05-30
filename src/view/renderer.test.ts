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
      const msg = container.querySelector('.copsilot-msg.user');
      expect(msg).not.toBeNull();
      expect(msg?.querySelector('.copsilot-msg-body')?.textContent).toBe('Hello world');
    });

    it('adds timestamp', () => {
      renderer.addUserMessage('Hello', 1234567890000);
      const msg = container.querySelector('.copsilot-msg.user') as HTMLElement;
      expect(msg?.dataset.timestamp).toBeDefined();
    });
  });

  describe('assistant placeholder', () => {
    it('adds placeholder', () => {
      renderer.addAssistantPlaceholder();
      const placeholder = container.querySelector('.copsilot-loading');
      expect(placeholder).not.toBeNull();
    });

    it('removes placeholder', () => {
      renderer.addAssistantPlaceholder();
      renderer.removeAssistantPlaceholder();
      const placeholder = container.querySelector('.copsilot-loading');
      expect(placeholder).toBeNull();
    });

    it('does not create duplicate placeholders', () => {
      renderer.addAssistantPlaceholder();
      renderer.addAssistantPlaceholder();
      const placeholders = container.querySelectorAll('.copsilot-loading');
      expect(placeholders.length).toBe(1);
    });
  });

  describe('appendText', () => {
    it('creates assistant message element', () => {
      renderer.appendText('Hello');
      const msg = container.querySelector('.copsilot-msg.assistant');
      expect(msg).not.toBeNull();
    });

    it('appends text to existing message', () => {
      renderer.appendText('Hello', 'msg-1');
      renderer.appendText(' world', 'msg-1');
      // The text is accumulated and rendered asynchronously
      expect(container.querySelector('.copsilot-msg.assistant')).not.toBeNull();
    });

    it('creates new element for different message id', () => {
      renderer.appendText('Hello', 'msg-1');
      renderer.appendText('World', 'msg-2');
      const msgs = container.querySelectorAll('.copsilot-msg.assistant');
      expect(msgs.length).toBe(2);
    });
  });

  describe('appendThinking', () => {
    it('creates thinking block', () => {
      renderer.appendThinking('Thinking...');
      const thinking = container.querySelector('.copsilot-thinking');
      expect(thinking).not.toBeNull();
    });

    it('creates header', () => {
      renderer.appendThinking('Thinking...');
      const header = container.querySelector('.copsilot-thinking-header');
      expect(header).not.toBeNull();
    });

    it('collapses by default', () => {
      renderer.appendThinking('Thinking...');
      const body = container.querySelector('.copsilot-thinking-body') as HTMLElement;
      expect(body?.style.display).toBe('none');
    });

    it('toggles on header click', () => {
      renderer.appendThinking('Thinking...');
      const header = container.querySelector('.copsilot-thinking-header') as HTMLElement;
      const body = container.querySelector('.copsilot-thinking-body') as HTMLElement;

      header.click();
      expect(body.style.display).toBe('block');

      header.click();
      expect(body.style.display).toBe('none');
    });
  });

  describe('addToolCall', () => {
    it('creates tool call element', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const toolCall = container.querySelector('.copsilot-tool-call');
      expect(toolCall).not.toBeNull();
    });

    it('shows kind', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const kind = container.querySelector('.tc-kind');
      expect(kind?.textContent).toBe('search');
    });

    it('shows file name from input', () => {
      renderer.addToolCall('call-1', 'Edit', 'edit', { filePath: '/path/to/file.ts' });
      const file = container.querySelector('.tc-file');
      expect(file?.textContent).toBe('file.ts');
    });

    it('toggles body on header click', () => {
      renderer.addToolCall('call-1', 'Search', 'search', { q: 'test' });
      const header = container.querySelector('.copsilot-tool-call-header') as HTMLElement;
      const body = container.querySelector('.copsilot-tool-call-body') as HTMLElement;

      expect(body.style.display).toBe('none');
      header.click();
      expect(body.style.display).toBe('block');
      header.click();
      expect(body.style.display).toBe('none');
    });
  });

  describe('updateToolCall', () => {
    it('updates status to completed', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall('call-1', 'completed', {}, [{ type: 'content', content: { type: 'text', text: 'Result' } }]);
      const stat = container.querySelector('.tc-stat');
      expect(stat?.textContent).toBe('✓');
    });

    it('updates status to in_progress', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall('call-1', 'in_progress');
      const stat = container.querySelector('.tc-stat');
      expect(stat?.textContent).toBe('…');
    });

    it('updates status to failed', () => {
      renderer.addToolCall('call-1', 'Search', 'search', {});
      renderer.updateToolCall('call-1', 'failed');
      const stat = container.querySelector('.tc-stat');
      expect(stat?.textContent).toBe('✗');
    });

    it('does nothing for unknown tool id', () => {
      renderer.updateToolCall('unknown', 'completed');
      // Should not throw
    });

    it('renders diff content', () => {
      renderer.addToolCall('call-1', 'Edit', 'edit', {});
      renderer.updateToolCall('call-1', 'completed', {}, [{
        type: 'diff',
        path: '/file.ts',
        oldText: 'old',
        newText: 'new',
      }]);
      const diff = container.querySelector('.copsilot-diff');
      expect(diff).not.toBeNull();
    });
  });

  describe('setPlanEntries', () => {
    it('creates plan panel', () => {
      renderer.setPlanEntries([{ content: 'Task 1', status: 'pending' }]);
      const plan = container.querySelector('.copsilot-plan-panel');
      expect(plan).not.toBeNull();
    });

    it('shows entries', () => {
      renderer.setPlanEntries([
        { content: 'Task 1', status: 'completed' },
        { content: 'Task 2', status: 'in_progress' },
        { content: 'Task 3', status: 'pending' },
      ]);
      const items = container.querySelectorAll('.plan-item');
      expect(items.length).toBe(3);
    });

    it('updates existing entries', () => {
      renderer.setPlanEntries([{ content: 'Task 1', status: 'pending' }]);
      renderer.setPlanEntries([{ content: 'Task 1', status: 'completed' }]);
      const items = container.querySelectorAll('.plan-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('✓');
    });
  });

  describe('addError', () => {
    it('adds error message', () => {
      renderer.addError('Something went wrong');
      const error = container.querySelector('.copsilot-error');
      expect(error).not.toBeNull();
      expect(error?.textContent).toBe('Something went wrong');
    });

    it('removes placeholder', () => {
      renderer.addAssistantPlaceholder();
      renderer.addError('Error');
      const placeholder = container.querySelector('.copsilot-loading');
      expect(placeholder).toBeNull();
    });
  });

  describe('showUsage', () => {
    it('shows usage info', () => {
      renderer.appendText('Hello');
      renderer.showUsage({
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        modelId: 'claude-3-sonnet',
      });
      const usage = container.querySelector('.copsilot-usage');
      expect(usage).not.toBeNull();
      expect(usage?.textContent).toContain('claude-3-sonnet');
    });

    it('shows cost when available', () => {
      renderer.appendText('Hello');
      renderer.showUsage({
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        cost: { amount: 0.0012, currency: 'USD' },
      });
      const usage = container.querySelector('.copsilot-usage');
      expect(usage?.textContent).toContain('$0.0012');
    });

    it('shows elapsed time', () => {
      renderer.appendText('Hello');
      renderer.showUsage({
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 50,
        elapsedMs: 2500,
      });
      const usage = container.querySelector('.copsilot-usage');
      expect(usage?.textContent).toContain('2.5s');
    });
  });

  describe('forceScrollToBottom', () => {
    it('calls requestAnimationFrame', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
      renderer.forceScrollToBottom();
      expect(rafSpy).toHaveBeenCalled();
      rafSpy.mockRestore();
    });
  });
});
