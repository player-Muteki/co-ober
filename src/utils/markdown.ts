// Placeholder — utilities ready for future use

/** Extract headings from markdown text */
export function extractHeadings(text: string): Array<{ level: number; text: string }> {
  return [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => ({
    level: m[0].length,
    text: m[1].trim(),
  }));
}

/** Get a short unique ID (8 chars) */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Escape HTML special characters */
export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Check if text content contains a wikilink to a given path */
export function hasWikilink(text: string, path: string): boolean {
  return text.includes('[[' + path) || text.includes('[[' + escapeHtml(path));
}
