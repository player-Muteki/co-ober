/**
 * Diff renderer — renders line-by-line diffs with smart hunk grouping,
 * new-file creation truncation, and structuredPatch extraction.
 *
 * @since Phase 1 (refactored)
 * @see claudian/src/utils/diff.ts for the reference implementation
 */

export interface DiffLine {
  text: string;
  type: 'equal' | 'insert' | 'delete';
}

/** Shape of the SDK's structuredPatch format. */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Pre-computed diff data for a tool call (Write/Edit). */
export interface ToolDiffData {
  filePath: string;
  diffLines: DiffLine[];
  stats: DiffStats;
}

interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  newStart: number;
}

interface DiffStats {
  added: number;
  removed: number;
}

const NEW_FILE_DISPLAY_CAP = 20;
const MAX_DIFF_LINES = 50;

// ── Counting / Stats ──

/**
 * Count the number of added and removed lines in a DiffLine array.
 */
export function countLineChanges(diffLines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffLines) {
    if (line.type === 'insert') added++;
    else if (line.type === 'delete') removed++;
  }
  return { added, removed };
}

/**
 * Convert SDK structuredPatch hunks into DiffLine array.
 */
export function structuredPatchToDiffLines(hunks: StructuredPatchHunk[]): DiffLine[] {
  const result: DiffLine[] = [];
  for (const hunk of hunks) {
    for (const rawLine of hunk.lines) {
      const prefix = rawLine[0];
      const text = rawLine.slice(1);
      if (prefix === '+') {
        result.push({ type: 'insert', text });
      } else if (prefix === '-') {
        result.push({ type: 'delete', text });
      } else {
        result.push({ type: 'equal', text });
      }
    }
  }
  return result;
}

/**
 * Extract diff data from a tool result or tool input.
 *
 * Priority:
 * 1. StructuredPatch from toolUseResult (SDK format)
 * 2. Compute from tool input: Edit(old_string/new_string), Write(content)
 */
export function extractDiffData(
  toolUseResult: unknown,
  toolName: string,
  toolInput: Record<string, unknown>,
  filePath: string,
): ToolDiffData | undefined {
  // Try structuredPatch first (SDK format)
  if (toolUseResult && typeof toolUseResult === 'object') {
    const result = toolUseResult as Record<string, unknown>;
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
      const resultFilePath = (typeof result.filePath === 'string' ? result.filePath : null) || filePath;
      const hunks = result.structuredPatch as StructuredPatchHunk[];
      const diffLines = structuredPatchToDiffLines(hunks);
      const stats = countLineChanges(diffLines);
      return { filePath: resultFilePath, diffLines, stats };
    }
  }

  // Fall back to computing from tool input
  if (toolName === 'Edit') {
    const oldStr = toolInput.old_string;
    const newStr = toolInput.new_string;
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      const diffLines: DiffLine[] = [];
      for (const line of oldStr.split('\n')) {
        diffLines.push({ type: 'delete', text: line });
      }
      for (const line of newStr.split('\n')) {
        diffLines.push({ type: 'insert', text: line });
      }
      return { filePath, diffLines, stats: countLineChanges(diffLines) };
    }
  }

  if (toolName === 'Write') {
    const content = toolInput.content;
    if (typeof content === 'string') {
      const newLines = content.split('\n');
      const diffLines: DiffLine[] = newLines.map(text => ({ type: 'insert', text }));
      return { filePath, diffLines, stats: { added: newLines.length, removed: 0 } };
    }
  }

  return undefined;
}

// ── Existing utility functions ──

/**
 * Compute simple diff stats from old/new text.
 */
export function computeDiffStats(oldText: string, newText: string): DiffStats {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let added = 0;
  let removed = 0;

  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    if (oldLines[i] === undefined) {
      added++;
    } else if (newLines[i] === undefined) {
      removed++;
    } else if (oldLines[i] !== newLines[i]) {
      added++;
      removed++;
    }
  }

  return { added, removed };
}

/**
 * Render diff stats element (+N -M).
 */
export function renderDiffStats(
  container: HTMLElement,
  stats: DiffStats,
): void {
  if (stats.added > 0) {
    const el = container.createSpan({ cls: 'added', text: `+${stats.added}` });
    container.appendChild(el);
  }
  if (stats.removed > 0) {
    if (stats.added > 0) {
      container.createSpan({ text: ' ' });
    }
    const el = container.createSpan({ cls: 'removed', text: `-${stats.removed}` });
    container.appendChild(el);
  }
}

/**
 * Parse old/new text into DiffLine array.
 */
export function parseDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);
  const lines: DiffLine[] = [];

  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] === undefined) {
      lines.push({ text: newLines[i] || ' ', type: 'insert' });
    } else if (newLines[i] === undefined) {
      lines.push({ text: oldLines[i] || ' ', type: 'delete' });
    } else if (oldLines[i] !== newLines[i]) {
      lines.push({ text: oldLines[i] || ' ', type: 'delete' });
      lines.push({ text: newLines[i] || ' ', type: 'insert' });
    } else {
      lines.push({ text: oldLines[i] || ' ', type: 'equal' });
    }
  }

  return lines;
}

/**
 * Split diff lines into hunks with context around changes.
 */
export function splitIntoHunks(diffLines: DiffLine[], contextLines = 3): DiffHunk[] {
  if (diffLines.length === 0) return [];

  // Find indices of all changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (diffLines[i].type !== 'equal') {
      changedIndices.push(i);
    }
  }

  if (changedIndices.length === 0) return [];

  // Group changed lines into ranges with context
  const ranges: Array<{ start: number; end: number }> = [];

  for (const idx of changedIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diffLines.length - 1, idx + contextLines);

    // Merge with previous range if overlapping or adjacent
    if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
      ranges[ranges.length - 1].end = end;
    } else {
      ranges.push({ start, end });
    }
  }

  // Convert ranges to hunks with line numbers
  return ranges.map((range) => {
    const lines = diffLines.slice(range.start, range.end + 1);

    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < range.start; i++) {
      const line = diffLines[i];
      if (line.type === 'equal' || line.type === 'delete') oldStart++;
      if (line.type === 'equal' || line.type === 'insert') newStart++;
    }

    return { lines, oldStart, newStart };
  });
}

/**
 * Render full diff content with hunk grouping and truncation.
 */
export function renderDiffContent(
  containerEl: HTMLElement,
  diffLines: DiffLine[],
  contextLines = 3,
): void {
  containerEl.empty();

  // New file creation: all lines are inserts — cap display
  const allInserts = diffLines.length > 0 && diffLines.every((l) => l.type === 'insert');
  if (allInserts && diffLines.length > NEW_FILE_DISPLAY_CAP) {
    for (const line of diffLines.slice(0, NEW_FILE_DISPLAY_CAP)) {
      const lineEl = containerEl.createDiv({ cls: 'diff-line added' });
      lineEl.createSpan({ cls: 'diff-marker', text: '+' });
      lineEl.createSpan({ text: line.text });
    }
    const remaining = diffLines.length - NEW_FILE_DISPLAY_CAP;
    containerEl.createDiv({
      cls: 'diff-line truncated',
      text: `... ${remaining} more lines`,
    });
    return;
  }

  const hunks = splitIntoHunks(diffLines, contextLines);

  if (hunks.length === 0) {
    containerEl.createDiv({ cls: 'diff-line', text: 'No changes' });
    return;
  }

  let totalRendered = 0;
  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx];

    // Add separator between hunks
    if (hunkIdx > 0) {
      containerEl.createDiv({ cls: 'diff-line context muted', text: '...' });
    }

    for (const line of hunk.lines) {
      if (totalRendered >= MAX_DIFF_LINES) {
        containerEl.createDiv({
          cls: 'diff-line truncated',
          text: `... ${diffLines.length - totalRendered} more lines`,
        });
        return;
      }

      const cls = line.type === 'insert'
        ? 'diff-line added'
        : line.type === 'delete'
          ? 'diff-line removed'
          : 'diff-line context';
      const marker = line.type === 'insert' ? '+' : line.type === 'delete' ? '-' : ' ';
      const lineEl = containerEl.createDiv({ cls });
      lineEl.createSpan({ cls: 'diff-marker', text: marker });
      lineEl.createSpan({ text: line.text });
      totalRendered++;
    }
  }
}
