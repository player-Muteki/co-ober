/**
 * Diff rendering infrastructure.
 * Renders unified-diff-style line changes with stats summaries.
 *
 * @since Phase 1
 */

import type { DiffStats, DiffLine, FileDiff } from '../types';

/**
 * Render diff stats as a compact "+12 -3" string.
 */
export function renderDiffStats(stats: DiffStats): string {
  const parts: string[] = [];
  if (stats.added > 0) parts.push(`+${stats.added}`);
  if (stats.removed > 0) parts.push(`-${stats.removed}`);
  return parts.join(' ') || '0 changes';
}

/**
 * Render a single diff content element from an array of DiffLine objects.
 */
export function renderDiffContent(
  lines: DiffLine[],
  maxLines: number = 50,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'co-ober-diff-body';

  let rendered = 0;
  for (const line of lines) {
    if (rendered >= maxLines) {
      body.createDiv({
        cls: 'diff-line truncated',
        text: `... ${lines.length - rendered} more lines`,
      });
      break;
    }

    const clsMap: Record<string, string> = {
      add: 'diff-line added',
      del: 'diff-line removed',
      ctx: 'diff-line context',
    };
    const markerMap: Record<string, string> = {
      add: '+',
      del: '-',
      ctx: ' ',
    };

    const lineEl = body.createDiv({ cls: clsMap[line.type] ?? 'diff-line context' });
    lineEl.createSpan({ cls: 'diff-marker', text: markerMap[line.type] ?? ' ' });
    lineEl.createSpan({ text: line.content });
    rendered++;
  }

  return body;
}

/**
 * Render a complete file diff section: header + stats + content.
 */
export function renderFileDiffSection(
  fileDiff: FileDiff,
  maxLines: number = 50,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'co-ober-diff';

  // Header with path and stats
  const header = container.createDiv({ cls: 'co-ober-diff-header' });
  header.createSpan({ cls: 'diff-path', text: fileDiff.path });
  header.createSpan({ cls: 'diff-stats', text: renderDiffStats(fileDiff.stats) });

  // Content body
  const body = renderDiffContent(fileDiff.lines, maxLines);
  container.appendChild(body);

  // Collapse toggle
  container.classList.add('is-collapsed');
  header.addEventListener('click', () => {
    container.classList.toggle('is-collapsed');
  });

  return container;
}

/**
 * Truncate long content to N lines with a "… N more lines" indicator.
 */
export function renderTruncatedContent(
  text: string,
  maxLines: number,
): { content: string; truncated: boolean; extraLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { content: text, truncated: false, extraLines: 0 };
  }
  return {
    content: lines.slice(0, maxLines).join('\n') + `\n... ${lines.length - maxLines} more lines`,
    truncated: true,
    extraLines: lines.length - maxLines,
  };
}
