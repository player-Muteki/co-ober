import { describe, it, expect, vi } from 'vitest';
import { ContextResolver } from './resolver';
import type { Vault, TFile } from 'obsidian';

vi.mock('obsidian', () => ({
  Vault: class {},
  TFile: class TFileMock {
    vault: unknown;
    extension = 'md';
    basename: string;
    path: string;
    constructor(data: { basename: string; path: string }) {
      this.basename = data.basename;
      this.path = data.path;
      this.vault = {};
    }
  },
}));

// Import the mocked TFile class for instantiation
import { TFile as MockTFile } from 'obsidian';

function createMockVault(files: Map<string, { basename: string; content: string }>): Vault {
  return {
    getAbstractFileByPath: vi.fn((path: string) => {
      const data = files.get(path);
      if (!data) return null;
      return new (MockTFile as unknown as new (data: { basename: string; path: string }) => TFile)({ basename: data.basename, path });
    }),
    read: vi.fn(async (file: TFile) => {
      const data = files.get(file.path);
      return data?.content ?? '';
    }),
  } as unknown as Vault;
}

describe('ContextResolver', () => {
  it('should resolve a note', async () => {
    const files = new Map([['notes/hello.md', { basename: 'hello', content: 'world' }]]);
    const vault = createMockVault(files);
    const resolver = new ContextResolver(vault);

    const result = await resolver.resolveNote('notes/hello.md');

    expect(result).not.toBeNull();
    expect(result!.name).toBe('hello');
    expect(result!.content).toBe('world');
  });

  it('should return null for non-existent note', async () => {
    const vault = createMockVault(new Map());
    const resolver = new ContextResolver(vault);

    const result = await resolver.resolveNote('missing.md');

    expect(result).toBeNull();
  });

  it('should truncate content exceeding maxBytes', async () => {
    const longContent = 'a'.repeat(10000);
    const files = new Map([['long.md', { basename: 'long', content: longContent }]]);
    const vault = createMockVault(files);
    const resolver = new ContextResolver(vault, 8000);

    const result = await resolver.resolveNote('long.md');

    expect(result!.content.length).toBe(8015); // 8000 + '... [truncated]'
    expect(result!.content.endsWith('... [truncated]')).toBe(true);
  });

  it('should resolve multiple notes', async () => {
    const files = new Map([
      ['a.md', { basename: 'a', content: 'alpha' }],
      ['b.md', { basename: 'b', content: 'beta' }],
    ]);
    const vault = createMockVault(files);
    const resolver = new ContextResolver(vault);

    const results = await resolver.resolveAll(['a.md', 'b.md', 'missing.md']);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('a');
    expect(results[1].name).toBe('b');
  });

  it('should search notes by basename', () => {
    const vault = {
      getMarkdownFiles: vi.fn(() => [
        { basename: 'Apple', path: 'fruit/apple.md' },
        { basename: 'Banana', path: 'fruit/banana.md' },
        { basename: 'Pineapple', path: 'fruit/pineapple.md' },
      ]),
    } as unknown as Vault;
    const resolver = new ContextResolver(vault);

    const results = resolver.search('app');

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain('Apple');
    expect(results.map((r) => r.name)).toContain('Pineapple');
  });

  it('should handle read errors gracefully', async () => {
    const vault = {
      getAbstractFileByPath: vi.fn(() => new (MockTFile as unknown as new (data: { basename: string; path: string }) => TFile)({ basename: 'bad', path: 'bad.md' })),
      read: vi.fn().mockRejectedValue(new Error('read error')),
    } as unknown as Vault;
    const resolver = new ContextResolver(vault);

    const result = await resolver.resolveNote('bad.md');

    expect(result).toBeNull();
  });
});
