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

  it('names a file with no complete frontmatter block instead of dropping it silently', async () => {
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/notes.md', contents: '# Just prose\n' }]),
    );

    await storage.load();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('.opencode/commands/notes.md');
    expect(Notice.messages[0]).toContain('no complete frontmatter');
  });

  it('does not tell a reader a half-written frontmatter block is absent', async () => {
    // The same parser returns null for an opening `---` with no closing one as
    // for a file with no frontmatter at all, but only one of them was ever
    // "missing" the block — the malformed file visibly has one. Saying it has
    // none sent the reader to write a header the file already half-carries.
    const storage = new FileCommandStorage(
      vaultWith([{ path: '.opencode/commands/half.md', contents: '---\ndescription: broken\n' }]),
    );

    await storage.load();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('.opencode/commands/half.md');
    expect(Notice.messages[0]).toContain('no complete frontmatter');
    expect(Notice.messages[0]).not.toMatch(/has no frontmatter/i);
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

describe('FileCommandStorage — two command files sharing a name', () => {
  beforeEach(() => {
    setLocale('en');
    Notice.messages.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps the shallower file and names the one that lost', async () => {
    const storage = new FileCommandStorage(
      vaultWith([
        { path: '.opencode/commands/team/daily/review.md', contents: GOOD },
        { path: '.opencode/commands/review.md', contents: GOOD },
      ]),
    );

    const defs = await storage.load();
    expect(defs.map((def) => def.id)).toEqual(['file:review']);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('.opencode/commands/team/daily/review.md');
    expect(Notice.messages[0]).not.toContain('no complete frontmatter');
    expect(Notice.messages[0]).toContain('shares a command name');
  });

  it('does not let vault ordering choose which template reaches the agent', async () => {
    const shallow = { path: '.opencode/commands/review.md', contents: '---\ndescription: shallow\n---\nShallow $ARGUMENTS\n' };
    const deep = { path: '.opencode/commands/team/review.md', contents: '---\ndescription: deep\n---\nDeep $ARGUMENTS\n' };

    const first = await new FileCommandStorage(vaultWith([deep, shallow])).load();
    Notice.messages.length = 0;
    const second = await new FileCommandStorage(vaultWith([shallow, deep])).load();

    expect(first.map((def) => def.template)).toEqual(['Shallow $ARGUMENTS']);
    expect(second.map((def) => def.template)).toEqual(['Shallow $ARGUMENTS']);
  });

  it('treats two spellings of one name as the same command', async () => {
    const storage = new FileCommandStorage(
      vaultWith([
        { path: '.opencode/commands/Review.md', contents: GOOD },
        { path: '.opencode/commands/review.md', contents: GOOD },
      ]),
    );

    const defs = await storage.load();
    expect(defs).toHaveLength(1);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('shares a command name');
  });

  it('stays quiet when the rescans find the same collision', async () => {
    const vault = vaultWith([
      { path: '.opencode/commands/review.md', contents: GOOD },
      { path: '.opencode/commands/team/review.md', contents: GOOD },
    ]);
    const storage = new FileCommandStorage(vault);

    await storage.load();
    await storage.load();
    expect(Notice.messages).toHaveLength(1);
  });

  it('says nothing when the names differ', async () => {
    const storage = new FileCommandStorage(
      vaultWith([
        { path: '.opencode/commands/review.md', contents: GOOD },
        { path: '.opencode/commands/team/diff.md', contents: GOOD },
        { path: '.opencode/commands/team/approve.md', contents: GOOD },
      ]),
    );

    await expect(storage.load()).resolves.toHaveLength(3);
    expect(Notice.messages).toEqual([]);
  });
});
