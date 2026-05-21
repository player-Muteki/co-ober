import { describe, it, expect, vi } from 'vitest';
import { ContextMention } from './mention';
import type { Vault } from 'obsidian';

vi.mock('obsidian', () => ({
  Vault: class {},
  TFile: class {},
}));

function createMockVault(files: Array<{ basename: string; path: string }>): Vault {
  return {
    getMarkdownFiles: vi.fn(() => files),
  } as unknown as Vault;
}

describe('ContextMention', () => {
  it('should add and retrieve refs', () => {
    const vault = createMockVault([]);
    const mention = new ContextMention(vault);

    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });
    mention.addRef({ id: '2', type: 'note', name: 'B', path: 'b.md' });

    expect(mention.getAllRefs()).toHaveLength(2);
    expect(mention.hasRef('1')).toBe(true);
    expect(mention.hasRef('3')).toBe(false);
  });

  it('should not add duplicate refs', () => {
    const vault = createMockVault([]);
    const mention = new ContextMention(vault);

    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });
    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });

    expect(mention.getAllRefs()).toHaveLength(1);
  });

  it('should remove refs', () => {
    const vault = createMockVault([]);
    const mention = new ContextMention(vault);

    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });
    mention.removeRef('1');

    expect(mention.getAllRefs()).toHaveLength(0);
    expect(mention.hasRef('1')).toBe(false);
  });

  it('should clear all refs', () => {
    const vault = createMockVault([]);
    const mention = new ContextMention(vault);

    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });
    mention.clear();

    expect(mention.getAllRefs()).toHaveLength(0);
  });

  it('should list all vault notes', () => {
    const vault = createMockVault([
      { basename: 'Note1', path: 'n1.md' },
      { basename: 'Note2', path: 'n2.md' },
    ]);
    const mention = new ContextMention(vault);

    const notes = mention.listAllNotes();

    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ id: 'n1.md', type: 'note', name: 'Note1', path: 'n1.md' });
  });

  it('should return a copy of refs', () => {
    const vault = createMockVault([]);
    const mention = new ContextMention(vault);

    mention.addRef({ id: '1', type: 'note', name: 'A', path: 'a.md' });
    const refs = mention.getAllRefs();
    refs.push({ id: '2', type: 'note', name: 'B', path: 'b.md' });

    expect(mention.getAllRefs()).toHaveLength(1);
  });
});
