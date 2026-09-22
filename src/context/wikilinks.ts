import type { ContextRef } from '../types';

const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Extract distinct note names from [[wikilinks]] in user text, in order of appearance. */
export function parseWikilinks(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    const name = match[1].trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Turn [[wikilinks]] found in the submitted text into note context refs.
 * Links are matched case-insensitively against vault note basenames; the first
 * match wins, unresolved links stay verbatim in the text for the agent to see.
 * Refs already attached by the user are never duplicated.
 */
export function expandWikilinkRefs(text: string, refs: ContextRef[], allNotes: ContextRef[]): ContextRef[] {
  const names = parseWikilinks(text);
  if (names.length === 0) return refs;
  const byName = new Map<string, ContextRef>();
  for (const note of allNotes) {
    const key = note.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, note);
  }
  const takenPaths = new Set(refs.map((r) => r.path));
  const extra: ContextRef[] = [];
  for (const name of names) {
    const note = byName.get(name.toLowerCase());
    if (!note || takenPaths.has(note.path)) continue;
    takenPaths.add(note.path);
    extra.push({ id: `wikilink:${note.path}`, type: 'note', name: note.name, path: note.path });
  }
  return extra.length ? [...refs, ...extra] : refs;
}
