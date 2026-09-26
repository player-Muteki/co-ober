import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileCommandStorage } from './FileCommandStorage';
import { Notice, TFile } from '../../test/obsidianMock';
import { setLocale } from '../../i18n/index';
import type { Vault } from 'obsidian';

interface CommandFileEntry {
  path: string;
  contents?: string;
  unreadable?: boolean;
}

function vaultWith(entries: CommandFileEntry[]): Vault {
  const files = entries.map((entry) =>
    Object.assign(new TFile(), {
      path: entry.path,
      name: entry.path.split('/').pop(),
      basename: (entry.path.split('/').pop() ?? '').replace(/\.md$/, ''),
      extension: 'md',
    }),
  );
  return {
    getMarkdownFiles: () => files,
    read: (file: TFile) => {
      const entry = entries.find((candidate) => candidate.path === file.path);
      if (entry?.unreadable) return Promise.reject(new Error('EACCES: permission denied'));
      return Promise.resolve(entry?.contents ?? '');
    },
  } as unknown as Vault;
}

const GOOD = `---
description: Review staged changes
---
Review $ARGUMENTS
`;

describe('FileCommandStorage — a command that disappears from the / popover', () => {
  beforeEach(() => {
    setLocale('en');
    Notice.messages.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('names the command file it could not read', async () => {
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/broken.md', unreadable: true }]),
    );

    await expect(storage.load()).resolves.toHaveLength(0);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('.opencode/commands/broken.md');
    expect(Notice.messages[0]).toContain('slash commands are missing');
  });

  it('names a file with no frontmatter instead of dropping it silently', async () => {
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/notes.md', contents: '# Just prose\n' }]),
    );

    await storage.load();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('.opencode/commands/notes.md');
    expect(Notice.messages[0]).toContain('no frontmatter');
  });

  it('keeps the readable commands while reporting the broken ones', async () => {
    const storage = new FileCommandStorage(
      vaultWith([
        { path: '.opencode/commands/review.md', contents: GOOD },
        { path: '.opencode/commands/broken.md', unreadable: true },
      ]),
    );

    const defs = await storage.load();
    expect(defs.map((def) => def.trigger)).toEqual(['review']);
    expect(Notice.messages).toHaveLength(1);
  });

  it('stays quiet when the watcher rescans the same broken file', async () => {
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/broken.md', unreadable: true }]),
    );

    await storage.load();
    await storage.load();
    expect(Notice.messages).toHaveLength(1);
  });

  it('speaks again when the broken set changes', async () => {
    const one = vaultWith([{ path: '.opencode/commands/broken.md', unreadable: true }]);
    await new FileCommandStorage(one).load();

    const storage = new FileCommandStorage(
      vaultWith([
        { path: '.opencode/commands/broken.md', unreadable: true },
        { path: '.opencode/commands/also-broken.md', unreadable: true },
      ]),
    );
    await storage.load();

    expect(Notice.messages).toHaveLength(2);
    expect(Notice.messages[1]).toContain('.opencode/commands/also-broken.md');
  });

  it('collapses a long list of broken files into a count', async () => {
    const storage = new FileCommandStorage(
      vaultWith(
        ['a', 'b', 'c', 'd', 'e'].map((name) => ({
          path: `.opencode/commands/${name}.md`,
          unreadable: true,
        })),
      ),
    );

    await storage.load();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('(+2)');
  });

  it('says nothing when every command file parses', async () => {
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/review.md', contents: GOOD }]),
    );

    await expect(storage.load()).resolves.toHaveLength(1);
    expect(Notice.messages).toEqual([]);
  });
});
