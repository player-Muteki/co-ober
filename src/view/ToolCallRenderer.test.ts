// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { setIcon } from 'obsidian';
import {
  createToolCallElement,
  updateToolCallElement,
  getToolDisplayName,
  getToolSummary,
  renderLinesExpanded,
  renderTruncatedText,
  type ToolCallState,
} from './ToolCallRenderer';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';
import type { ToolCallContent } from '../types';

installObsidianDomHelpers();

// Mock Obsidian's MarkdownRenderer
vi.mock('obsidian', () => ({
  MarkdownRenderer: {
    renderMarkdown: vi.fn().mockResolvedValue(undefined),
    render: vi.fn().mockResolvedValue(undefined),
  },
  setIcon: vi.fn(),
}));

const setIconMock = vi.mocked(setIcon);

function textItem(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } };
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');
}

describe('ToolCallRenderer', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    setIconMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('getToolDisplayName', () => {
    it('maps known kinds', () => {
      expect(getToolDisplayName('read')).toBe('Read');
      expect(getToolDisplayName('switch_mode')).toBe('Switch Mode');
      expect(getToolDisplayName('ls')).toBe('List');
    });

    it('capitalizes unknown kinds', () => {
      expect(getToolDisplayName('custom_tool')).toBe('Custom_tool');
    });
  });

  describe('getToolSummary', () => {
    it('shows the command for bash/execute and truncates at 80 chars', () => {
      expect(getToolSummary('bash', { command: 'ls -la' })).toBe('ls -la');
      const long = getToolSummary('execute', { command: 'x'.repeat(100) });
      expect(long.length).toBe(83);
      expect(long.endsWith('...')).toBe(true);
    });

    it('shows the file basename for read/edit/write', () => {
      expect(getToolSummary('read', { file_path: '/a/b/c.md' })).toBe('c.md');
      expect(getToolSummary('edit', {}, [{ path: '/x/y/z.ts' }])).toBe('z.ts');
    });

    it('shows the pattern for grep/search', () => {
      expect(getToolSummary('grep', { pattern: 'foo.*bar' })).toBe('foo.*bar');
    });

    it('shows query or url for web_search/fetch', () => {
      expect(getToolSummary('web_search', { query: 'obsidian plugins' })).toBe('obsidian plugins');
      expect(getToolSummary('fetch', { url: 'https://example.com' })).toBe('https://example.com');
    });

    it('shows the path for ls', () => {
      expect(getToolSummary('ls', { path: 'src/view' })).toBe('src/view');
    });

    it('falls back to first location, then first string input, then empty', () => {
      expect(getToolSummary('other', {}, [{ path: '/p/q.txt' }])).toBe('q.txt');
      expect(getToolSummary('other', { note: 'hello' })).toBe('hello');
      expect(getToolSummary('other', {})).toBe('');
    });
  });

  describe('createToolCallElement', () => {
    it('creates the standard card layout with icon, kind, summary and status', () => {
      const state = createToolCallElement(container, 'tc-1', 'execute', 'Run command', { command: 'ls -la' });
      expect(state.wrapper.classList.contains('co-ober-tool-call')).toBe(true);
      expect(state.wrapper.classList.contains('co-ober-tool-call-bash')).toBe(true);
      expect(state.wrapper.dataset.toolId).toBe('tc-1');
      expect(state.iconEl.classList.contains('tc-icon')).toBe(true);
      expect(state.kindEl.textContent).toBe('Execute');
      expect(state.summaryEl.textContent).toBe('ls -la');
      expect(state.statusEl.textContent).toBe('…');
      expect(setIconMock).toHaveBeenCalledWith(state.iconEl, 'terminal');
    });

    it('falls back to the generic tool icon for kinds without a mapping', () => {
      const state = createToolCallElement(container, 'tc-1b', 'bash', 'Run', { command: 'echo hi' });
      expect(state.kindEl.textContent).toBe('Bash');
      expect(setIconMock).toHaveBeenCalledWith(state.iconEl, 'tool');
    });

    it('starts collapsed with an aria label derived from title and summary', () => {
      const state = createToolCallElement(container, 'tc-2', 'read', 'Read note', { file_path: '/v/n.md' });
      expect(state.wrapper.classList.contains('is-collapsed')).toBe(true);
      expect(state.header.getAttribute('aria-label')).toBe('Read note: n.md - click to expand');
      expect(state.body.children.length).toBe(0);
    });

    it('delegates write/edit kinds to the dedicated renderer', () => {
      const state = createToolCallElement(container, 'tc-3', 'write', 'Write file', { file_path: '/v/a.md' });
      expect(state.writeEditState).toBeDefined();
      expect(state.wrapper.classList.contains('co-ober-write-edit')).toBe(true);
      expect(state.wrapper.dataset.toolId).toBe('tc-3');
      expect(state.kindEl.textContent).toBe('Write');
      expect(state.summaryEl.textContent).toBe('a.md');
    });
  });

  describe('updateToolCallElement — status', () => {
    it('marks in_progress with the running class and spinner icon', () => {
      const state = createToolCallElement(container, 'tc', 'execute', 'Run', { command: 'make' });
      updateToolCallElement(state, 'in_progress', 'execute');
      expect(state.wrapper.classList.contains('status-running')).toBe(true);
      expect(state.statusEl.classList.contains('spin')).toBe(true);
      expect(setIconMock).toHaveBeenCalledWith(state.statusEl, 'loader');
    });

    it('marks completed with the done class and check icon', () => {
      const state = createToolCallElement(container, 'tc', 'think', 'Think');
      updateToolCallElement(state, 'completed', 'think', undefined, [textItem('pondering')]);
      expect(state.wrapper.classList.contains('status-completed')).toBe(true);
      expect(state.statusEl.classList.contains('tc-stat-done')).toBe(true);
      expect(setIconMock).toHaveBeenCalledWith(state.statusEl, 'check');
      expect(state.body.textContent).toContain('pondering');
    });

    it('marks failed with the error class and serialized rawOutput', () => {
      const state = createToolCallElement(container, 'tc', 'execute', 'Run', { command: 'false' });
      updateToolCallElement(state, 'failed', 'execute', { error: 'boom' });
      expect(state.wrapper.classList.contains('status-error')).toBe(true);
      expect(state.statusEl.classList.contains('tc-stat-fail')).toBe(true);
      expect(setIconMock).toHaveBeenCalledWith(state.statusEl, 'x');
      expect(state.body.textContent).toContain('"error": "boom"');
    });

    it('renders pending with the circle icon', () => {
      const state = createToolCallElement(container, 'tc', 'other', 'Something');
      updateToolCallElement(state, 'pending', 'other');
      expect(setIconMock).toHaveBeenCalledWith(state.statusEl, 'circle');
      expect(state.wrapper.classList.contains('status-running')).toBe(false);
    });

    it('refreshes kind display and summary from new input', () => {
      const state = createToolCallElement(container, 'tc', 'read', 'Read');
      updateToolCallElement(state, 'in_progress', 'read', undefined, undefined, { file_path: '/v/deep/b.md' });
      expect(state.kindEl.textContent).toBe('Read');
      expect(state.summaryEl.textContent).toBe('b.md');
    });
  });

  describe('updateToolCallElement — empty-state strings', () => {
    it('shows "No content" for a completed read with no text', () => {
      const state = createToolCallElement(container, 'tc', 'read', 'Read', { file_path: '/x.md' });
      updateToolCallElement(state, 'completed', 'read', undefined, [{ type: 'terminal', terminalId: 't1' }]);
      expect(state.body.querySelector('.co-ober-tool-empty')?.textContent).toBe('No content');
    });

    it('shows "No matches" for an empty search result', () => {
      const state = createToolCallElement(container, 'tc', 'search', 'Search', { pattern: 'zzz' });
      updateToolCallElement(state, 'completed', 'search', undefined, [{ type: 'terminal', terminalId: 't1' }]);
      expect(state.body.querySelector('.co-ober-tool-empty')?.textContent).toBe('No matches');
    });

    it('shows "No result" for an empty fetch', () => {
      const state = createToolCallElement(container, 'tc', 'fetch', 'Fetch', { url: 'https://e.com' });
      updateToolCallElement(state, 'completed', 'fetch', undefined, [{ type: 'terminal', terminalId: 't1' }]);
      expect(state.body.querySelector('.co-ober-tool-empty')?.textContent).toBe('No result');
    });

    it('shows "No matches found" when the search text has no non-empty lines', () => {
      const state = createToolCallElement(container, 'tc', 'grep', 'Grep');
      updateToolCallElement(state, 'completed', 'grep', undefined, [textItem('\n\n')]);
      expect(state.body.querySelector('.co-ober-tool-empty')?.textContent).toBe('No matches found');
    });
  });

  describe('updateToolCallElement — tool-specific bodies', () => {
    it('renders exit code for execute output', () => {
      const state = createToolCallElement(container, 'tc', 'execute', 'Run', { command: 'exit 1' });
      updateToolCallElement(state, 'completed', 'execute', { exit_code: 1 }, [textItem('failed run')]);
      const exitEl = state.body.querySelector('.co-ober-tool-exit-status') as HTMLElement;
      expect(exitEl.textContent).toBe('Exit code: 1');
      expect(exitEl.classList.contains('error')).toBe(true);
    });

    it('omits the error class for a zero exit code', () => {
      const state = createToolCallElement(container, 'tc', 'bash', 'Run');
      updateToolCallElement(state, 'completed', 'bash', { exitCode: 0 }, [textItem('ok')]);
      const exitEl = state.body.querySelector('.co-ober-tool-exit-status') as HTMLElement;
      expect(exitEl.textContent).toBe('Exit code: 0');
      expect(exitEl.classList.contains('error')).toBe(false);
    });

    it('truncates search results with "... N more matches"', () => {
      const state = createToolCallElement(container, 'tc', 'grep', 'Grep');
      updateToolCallElement(state, 'completed', 'grep', undefined, [textItem(makeLines(25))]);
      const lineEls = state.body.querySelectorAll('.co-ober-tool-line');
      expect(lineEls.length).toBe(20);
      expect(lineEls[0].classList.contains('hoverable')).toBe(true);
      expect(state.body.querySelector('.co-ober-tool-truncated')?.textContent).toBe('... 5 more matches');
    });

    it('truncates long file reads with "... N more lines"', () => {
      const state = createToolCallElement(container, 'tc', 'read', 'Read');
      updateToolCallElement(state, 'completed', 'read', undefined, [textItem(makeLines(20))]);
      expect(state.body.querySelectorAll('.co-ober-tool-line').length).toBe(15);
      expect(state.body.querySelector('.co-ober-tool-truncated')?.textContent).toBe('... 5 more lines');
    });

    it('renders the source URL for fetch results', () => {
      const state = createToolCallElement(container, 'tc', 'fetch', 'Fetch');
      updateToolCallElement(state, 'completed', 'fetch', { url: 'https://example.com/page' }, [textItem('body')]);
      expect(state.body.querySelector('.co-ober-tool-url')?.textContent).toBe('Source: https://example.com/page');
    });

    it('renders "File deleted" for an apply_patch delete section', () => {
      const state = createToolCallElement(container, 'tc', 'apply_patch', 'Patch');
      updateToolCallElement(state, 'completed', 'apply_patch', undefined, [
        textItem('*** Delete File: obsolete.ts'),
      ]);
      const section = state.body.querySelector('.co-ober-patch-section') as HTMLElement;
      expect(section).not.toBeNull();
      expect(section.querySelector('.co-ober-patch-file-name')?.textContent).toBe('obsolete.ts');
      expect(section.querySelector('.co-ober-patch-op')?.textContent).toBe('DELETE');
      expect(section.querySelector('.co-ober-tool-empty')?.textContent).toBe('File deleted');
    });

    it('renders a multi-file patch with update diff lines', () => {
      const state = createToolCallElement(container, 'tc', 'apply_patch', 'Patch');
      updateToolCallElement(state, 'completed', 'apply_patch', undefined, [
        textItem(['*** Update File: a.ts', ' ctx', '-old', '+new'].join('\n')),
      ]);
      const section = state.body.querySelector('.co-ober-patch-section') as HTMLElement;
      expect(section).not.toBeNull();
      expect(section.querySelector('.diff-line.added')?.textContent).toBe('+new');
      expect(section.querySelector('.diff-line.removed')?.textContent).toBe('-old');
      expect(section.querySelector('.co-ober-patch-file-name')?.textContent).toBe('a.ts');
      expect(section.querySelector('.co-ober-patch-op')?.textContent).toBe('UPDATE');
    });
  });

  describe('updateToolCallElement — write/edit diffs', () => {
    it('renders diff stats and added/removed lines through the write/edit renderer', () => {
      const state = createToolCallElement(container, 'tc', 'write', 'Write', { file_path: '/v/a.md' });
      updateToolCallElement(state, 'completed', 'write', undefined, [
        { type: 'diff', path: 'a.md', newText: 'line1\nline2' },
      ]);
      expect(state.writeEditState?.statsEl.textContent).toBe('+2 -1');
      expect(state.body.querySelector('.diff-line.added')).not.toBeNull();
      expect(state.body.querySelector('.diff-line.removed')).not.toBeNull();
      expect(state.wrapper.classList.contains('status-completed')).toBe(true);
      expect(state.wrapper.classList.contains('is-collapsed')).toBe(true);
    });

    it('falls back to inline diff rendering when no write/edit state exists', () => {
      const wrapper = container.createDiv();
      const header = wrapper.createDiv();
      const body = wrapper.createDiv();
      const state: ToolCallState = {
        wrapper,
        header,
        body,
        iconEl: header.createSpan({ cls: 'tc-icon' }),
        kindEl: header.createSpan({ cls: 'tc-kind' }),
        summaryEl: header.createSpan({ cls: 'tc-file' }),
        statusEl: header.createSpan({ cls: 'tc-stat' }),
        collapsibleState: { isExpanded: false },
      };
      updateToolCallElement(state, 'completed', 'edit', undefined, [
        { type: 'diff', path: 'b.md', oldText: 'x', newText: 'y' },
      ]);
      expect(body.querySelector('.diff-line.added span:last-child')?.textContent).toBe('y');
      expect(body.querySelector('.diff-line.removed span:last-child')?.textContent).toBe('x');
    });
  });

  describe('renderLinesExpanded', () => {
    it('renders each line and blanks empty ones', () => {
      renderLinesExpanded(container, 'a\n\nb', 10);
      const lines = Array.from(container.querySelectorAll('.co-ober-tool-line'));
      expect(lines.map((l) => l.textContent)).toEqual(['a', ' ', 'b']);
      expect(container.querySelector('.co-ober-tool-truncated')).toBeNull();
    });

    it('adds the hoverable class when requested', () => {
      renderLinesExpanded(container, 'x', 10, true);
      expect(container.querySelector('.co-ober-tool-line')?.classList.contains('hoverable')).toBe(true);
    });

    it('appends a localized truncation line beyond maxLines', () => {
      renderLinesExpanded(container, makeLines(12), 5);
      expect(container.querySelectorAll('.co-ober-tool-line').length).toBe(5);
      expect(container.querySelector('.co-ober-tool-truncated')?.textContent).toBe('... 7 more lines');
    });
  });

  describe('renderTruncatedText', () => {
    it('returns short text unchanged', () => {
      expect(renderTruncatedText('one\ntwo', 5)).toBe('one\ntwo');
    });

    it('appends a "more lines" suffix when over the limit', () => {
      expect(renderTruncatedText(makeLines(22), 20)).toBe(`${makeLines(20)}\n... 2 more lines`);
    });
  });
});
