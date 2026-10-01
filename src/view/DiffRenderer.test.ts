// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  countLineChanges,
  structuredPatchToDiffLines,
  extractDiffData,
  computeDiffStats,
  renderDiffStats,
  parseDiffLines,
  splitIntoHunks,
  renderDiffContent,
  type DiffLine,
} from './DiffRenderer';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';

installObsidianDomHelpers();

function childDivs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children) as HTMLElement[];
}

describe('DiffRenderer', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    setLocale('en');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('countLineChanges', () => {
    it('counts insert as added and delete as removed', () => {
      const lines: DiffLine[] = [
        { type: 'equal', text: 'a' },
        { type: 'insert', text: 'b' },
        { type: 'delete', text: 'c' },
        { type: 'insert', text: 'd' },
      ];
      expect(countLineChanges(lines)).toEqual({ added: 2, removed: 1 });
    });

    it('returns zeros for an empty array', () => {
      expect(countLineChanges([])).toEqual({ added: 0, removed: 0 });
    });
  });

  describe('structuredPatchToDiffLines', () => {
    it('maps +/- prefixes and treats everything else as equal', () => {
      const lines = structuredPatchToDiffLines([
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [' ctx', '-old', '+new'],
        },
      ]);
      expect(lines).toEqual([
        { type: 'equal', text: 'ctx' },
        { type: 'delete', text: 'old' },
        { type: 'insert', text: 'new' },
      ]);
    });

    it('concatenates lines from multiple hunks', () => {
      const lines = structuredPatchToDiffLines([
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a'] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-b'] },
      ]);
      expect(lines.map((l) => l.type)).toEqual(['insert', 'delete']);
    });
  });

  describe('extractDiffData', () => {
    it('prefers structuredPatch from toolUseResult', () => {
      const result = extractDiffData(
        {
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a', '+b'] },
          ],
          filePath: 'from-result.ts',
        },
        'Edit',
        { old_string: 'a', new_string: 'a\nb' },
        'fallback.ts',
      );
      expect(result?.filePath).toBe('from-result.ts');
      expect(result?.diffLines).toEqual([
        { type: 'equal', text: 'a' },
        { type: 'insert', text: 'b' },
      ]);
      expect(result?.stats).toEqual({ added: 1, removed: 0 });
    });

    it('falls back to the provided filePath when result.filePath is missing', () => {
      const result = extractDiffData(
        { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['x'] }] },
        'Edit',
        {},
        'given.ts',
      );
      expect(result?.filePath).toBe('given.ts');
    });

    it('computes delete-then-insert lines for Edit tool input', () => {
      const result = extractDiffData(null, 'Edit', { old_string: 'a', new_string: 'b' }, 'f.ts');
      expect(result?.diffLines).toEqual([
        { type: 'delete', text: 'a' },
        { type: 'insert', text: 'b' },
      ]);
      expect(result?.stats).toEqual({ added: 1, removed: 1 });
    });

    it('computes insert-only lines for Write tool input', () => {
      const result = extractDiffData(null, 'Write', { content: 'l1\nl2\nl3' }, 'new.md');
      expect(result?.filePath).toBe('new.md');
      expect(result?.stats).toEqual({ added: 3, removed: 0 });
      expect(result?.diffLines.every((l) => l.type === 'insert')).toBe(true);
    });

    it('returns undefined when no diff can be derived', () => {
      expect(extractDiffData(null, 'Bash', { command: 'ls' }, 'x')).toBeUndefined();
      expect(extractDiffData(null, 'Edit', {}, 'x')).toBeUndefined();
      expect(extractDiffData({ structuredPatch: [] }, 'Write', {}, 'x')).toBeUndefined();
    });
  });

  describe('computeDiffStats', () => {
    it('counts changed lines as both added and removed', () => {
      expect(computeDiffStats('a\nb', 'a\nc\nd')).toEqual({ added: 2, removed: 1 });
    });

    it('returns zeros for identical text', () => {
      expect(computeDiffStats('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
    });

    it('counts a creation (empty old text) as adds only', () => {
      expect(computeDiffStats('', 'a\nb')).toEqual({ added: 2, removed: 0 });
    });

    it('counts an emptying (empty new text) as removals only', () => {
      expect(computeDiffStats('a\nb', '')).toEqual({ added: 0, removed: 2 });
    });

    it('counts a created file that ends in a newline by its real lines', () => {
      // Every created file ends in a newline. The old split kept the empty
      // terminator as a third segment, so a two-line file was billed +3.
      expect(computeDiffStats('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    });
  });

  describe('renderDiffStats', () => {
    it('renders +N and -M spans with a separator', () => {
      renderDiffStats(container, { added: 3, removed: 1 });
      const spans = Array.from(container.querySelectorAll('span'));
      expect(spans.map((s) => s.textContent)).toEqual(['+3', ' ', '-1']);
      expect(spans[0].classList.contains('added')).toBe(true);
      expect(spans[2].classList.contains('removed')).toBe(true);
    });

    it('renders only added when there are no removals', () => {
      renderDiffStats(container, { added: 2, removed: 0 });
      expect(container.querySelector('.added')?.textContent).toBe('+2');
      expect(container.querySelector('.removed')).toBeNull();
    });

    it('renders nothing for zero stats', () => {
      renderDiffStats(container, { added: 0, removed: 0 });
      expect(container.children.length).toBe(0);
    });
  });

  describe('parseDiffLines', () => {
    it('emits delete+insert pairs for changed lines', () => {
      expect(parseDiffLines('a\nb\nc', 'a\nX\nc')).toEqual([
        { type: 'equal', text: 'a' },
        { type: 'delete', text: 'b' },
        { type: 'insert', text: 'X' },
        { type: 'equal', text: 'c' },
      ]);
    });

    it('emits inserts for appended lines', () => {
      expect(parseDiffLines('a', 'a\nb')).toEqual([
        { type: 'equal', text: 'a' },
        { type: 'insert', text: 'b' },
      ]);
    });

    it('emits deletes for removed lines', () => {
      expect(parseDiffLines('a\nb', 'a')).toEqual([
        { type: 'equal', text: 'a' },
        { type: 'delete', text: 'b' },
      ]);
    });

    it('treats an empty old text as a pure creation, with no phantom delete', () => {
      expect(parseDiffLines('', 'a')).toEqual([
        { type: 'insert', text: 'a' },
      ]);
    });

    it('replaces a genuinely empty changed line with a space placeholder', () => {
      // A blank line in the middle of the body is real content, so it still
      // needs the visible placeholder. That is different from a trailing
      // newline, which terminates the last line rather than adding a blank one.
      expect(parseDiffLines('a', 'a\n\nb')).toEqual([
        { type: 'equal', text: 'a' },
        { type: 'insert', text: ' ' },
        { type: 'insert', text: 'b' },
      ]);
    });

    it('does not draw a phantom added row for a trailing newline', () => {
      // 'x' → 'x\n' adds a terminator, not a new line. The old split left the
      // empty final segment, so the diff billed a line the file never gained.
      expect(parseDiffLines('x', 'x\n')).toEqual([
        { type: 'equal', text: 'x' },
      ]);
    });

    it('renders a created newline-terminated file with no blank insert row', () => {
      // File creation is the common case and created files end in a newline;
      // drawing a third blank insert row overstated what the tool added.
      expect(parseDiffLines('', 'a\nb\n')).toEqual([
        { type: 'insert', text: 'a' },
        { type: 'insert', text: 'b' },
      ]);
    });
  });

  describe('splitIntoHunks', () => {
    it('returns no hunks for empty input', () => {
      expect(splitIntoHunks([])).toEqual([]);
    });

    it('returns no hunks when everything is equal', () => {
      const lines: DiffLine[] = [
        { type: 'equal', text: 'a' },
        { type: 'equal', text: 'b' },
      ];
      expect(splitIntoHunks(lines)).toEqual([]);
    });

    it('groups changes with context and tracks line starts', () => {
      const lines: DiffLine[] = [];
      for (let i = 0; i < 22; i++) {
        if (i === 0) lines.push({ type: 'insert', text: 'first' });
        else if (i === 21) lines.push({ type: 'delete', text: 'last' });
        else lines.push({ type: 'equal', text: `l${i}` });
      }
      const hunks = splitIntoHunks(lines);
      expect(hunks.length).toBe(2);
      expect(hunks[0].lines.length).toBe(4);
      expect(hunks[0].oldStart).toBe(1);
      expect(hunks[0].newStart).toBe(1);
      // Before the second hunk: the leading insert adds no old line, the 17
      // equal lines (indices 1..17) each consume one line on both sides.
      expect(hunks[1].oldStart).toBe(18);
      expect(hunks[1].newStart).toBe(19);
    });

    it('merges changes whose context ranges touch', () => {
      const lines: DiffLine[] = [
        { type: 'insert', text: 'a' },
        { type: 'equal', text: 'b' },
        { type: 'delete', text: 'c' },
      ];
      const hunks = splitIntoHunks(lines);
      expect(hunks.length).toBe(1);
      expect(hunks[0].lines.length).toBe(3);
    });
  });

  describe('renderDiffContent', () => {
    it('renders "No changes" for an empty diff', () => {
      renderDiffContent(container, []);
      expect(childDivs(container).length).toBe(1);
      expect(container.children[0].classList.contains('diff-line')).toBe(true);
      expect(container.children[0].textContent).toBe('No changes');
      // The line is written from t() once and then frozen on the card; the
      // renderer's refreshLocale walks [data-i18n-text], so without the key a
      // reader who switched language still saw "No changes" under a Chinese
      // diff header.
      expect((container.children[0] as HTMLElement).dataset.i18nText).toBe('diff.noChanges');
    });

    it('renders "No changes" when all lines are equal', () => {
      renderDiffContent(container, [
        { type: 'equal', text: 'a' },
        { type: 'equal', text: 'b' },
      ]);
      expect(container.textContent).toBe('No changes');
    });

    it('renders added and removed lines with marker spans', () => {
      renderDiffContent(container, [
        { type: 'delete', text: 'old' },
        { type: 'insert', text: 'new' },
      ]);
      const removed = container.querySelector('.diff-line.removed') as HTMLElement;
      const added = container.querySelector('.diff-line.added') as HTMLElement;
      expect(removed).not.toBeNull();
      expect(added).not.toBeNull();
      expect(removed.querySelector('.diff-marker')?.textContent).toBe('-');
      expect(added.querySelector('.diff-marker')?.textContent).toBe('+');
      expect(removed.querySelectorAll('span')[1].textContent).toBe('old');
      expect(added.querySelectorAll('span')[1].textContent).toBe('new');
    });

    it('caps new-file creation at 20 added lines with a localized truncation line', () => {
      const lines: DiffLine[] = Array.from({ length: 25 }, (_, i) => ({
        type: 'insert' as const,
        text: `line ${i}`,
      }));
      renderDiffContent(container, lines);
      const divs = childDivs(container);
      expect(divs.length).toBe(21);
      expect(divs.filter((d) => d.classList.contains('added')).length).toBe(20);
      const truncated = divs[20];
      expect(truncated.classList.contains('truncated')).toBe(true);
      expect(truncated.textContent).toBe('... 5 more lines');
      // The truncation line is built once from t() into the diff body, so with no
      // i18n key a reader who switched language after seeing a capped new file kept
      // "... 5 more lines" under an otherwise-re-localized card. It now rides
      // data-i18n-count, which the renderer's refreshLocale re-speaks with the
      // stored count.
      expect((truncated as HTMLElement).dataset.i18nCount).toBe('diff.moreLines');
      expect((truncated as HTMLElement).dataset.count).toBe('5');
    });

    it('renders a full new file without truncation when within the cap', () => {
      const lines: DiffLine[] = Array.from({ length: 20 }, (_, i) => ({
        type: 'insert' as const,
        text: `line ${i}`,
      }));
      renderDiffContent(container, lines);
      expect(childDivs(container).length).toBe(20);
      expect(container.querySelector('.truncated')).toBeNull();
    });

    it('truncates very large diffs at 50 rendered lines', () => {
      const lines: DiffLine[] = [{ type: 'equal', text: 'ctx' }];
      for (let i = 0; i < 55; i++) {
        lines.push({ type: 'insert', text: `line ${i}` });
      }
      renderDiffContent(container, lines);
      const divs = childDivs(container);
      expect(divs.length).toBe(51);
      expect(divs[50].classList.contains('truncated')).toBe(true);
      expect(divs[50].textContent).toBe('... 6 more lines');
      // Same rule for the hunk-cap truncation line: it rides its count key so a
      // language change re-speaks it rather than freezing "... 6 more lines".
      expect((divs[50] as HTMLElement).dataset.i18nCount).toBe('diff.moreLines');
      expect((divs[50] as HTMLElement).dataset.count).toBe('6');
    });

    it('separates distant hunks with a muted "..." line', () => {
      const lines: DiffLine[] = [];
      for (let i = 0; i < 22; i++) {
        if (i === 0) lines.push({ type: 'insert', text: 'first' });
        else if (i === 21) lines.push({ type: 'delete', text: 'last' });
        else lines.push({ type: 'equal', text: `l${i}` });
      }
      renderDiffContent(container, lines);
      const separator = container.querySelector('.diff-line.context.muted');
      expect(separator?.textContent).toBe('...');
      expect(container.querySelector('.diff-line.added')).not.toBeNull();
      expect(container.querySelector('.diff-line.removed')).not.toBeNull();
      // 4 lines per hunk + 1 separator
      expect(childDivs(container).length).toBe(9);
    });
  });
});
