import { describe, expect, it } from 'vitest';
import { parseWikilinks, expandWikilinkRefs } from './wikilinks';
import type { ContextRef } from '../types';

function note(name: string, path = `${name}.md`): ContextRef {
  return { id: path, type: 'note', name, path };
}

describe('parseWikilinks', () => {
  it('extracts plain links', () => {
    expect(parseWikilinks('compare [[Project Alpha]] with [[Project Beta]]')).toEqual([
      'Project Alpha',
      'Project Beta',
    ]);
  });

  it('handles aliases and headings', () => {
    expect(parseWikilinks('see [[Daily Note#2026-01|today]] and [[Meeting Notes|]]')).toEqual([
      'Daily Note',
      'Meeting Notes',
    ]);
  });

  it('dedupes case-insensitively, keeping first spelling', () => {
    expect(parseWikilinks('[[Alpha]] [[alpha]] [[ALPHA]]')).toEqual(['Alpha']);
  });

  it('ignores empty and whitespace-only targets', () => {
    expect(parseWikilinks('[][[]] [[ ]] [[x ]]')).toEqual(['x']);
  });

  it('returns empty for text without links', () => {
    expect(parseWikilinks('no links here, just [text](url)')).toEqual([]);
  });
});

describe('expandWikilinkRefs', () => {
  const notes = [note('Project Alpha'), note('Project Beta', 'areas/beta.md'), note('Alpha')];

  it('adds refs for resolved links', () => {
    const refs = expandWikilinkRefs('summarize [[Project Alpha]] and [[Project Beta|beta]]', [], notes);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ id: 'wikilink:Project Alpha.md', type: 'note', name: 'Project Alpha', path: 'Project Alpha.md' });
    expect(refs[1].path).toBe('areas/beta.md');
  });

  it('keeps existing refs untouched and never duplicates their paths', () => {
    const existing = [note('Project Alpha', 'Project Alpha.md')];
    const refs = expandWikilinkRefs('[[Project Alpha]] again', existing, notes);
    expect(refs).toBe(existing);
  });

  it('skips unresolved links, first basename match wins', () => {
    const refs = expandWikilinkRefs('[[Nonexistent]] [[alpha]]', [], notes);
    expect(refs.map((r) => r.path)).toEqual(['Alpha.md']);
  });

  it('returns the same array reference when the text has no links', () => {
    const existing = [note('x')];
    expect(expandWikilinkRefs('plain question', existing, notes)).toBe(existing);
  });
});
