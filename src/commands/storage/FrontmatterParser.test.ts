import { describe, expect, it } from 'vitest';
import { parseCommandFile } from './FrontmatterParser';

describe('parseCommandFile frontmatter', () => {
  it('reads the nested mapping with an inline array that its own header documents', () => {
    const parsed = parseCommandFile(
      ['---', 'description: Review', 'hooks:', '  pre: ["echo starting"]', '---', 'body text'].join('\n'),
    );

    // The nested line was consumed without moving the cursor, so the block loop
    // re-read it forever: a command file in the documented shape froze the vault
    // scan (Obsidian's main thread) and the / popover never filled.
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.description).toBe('Review');
    expect(parsed!.frontmatter.hooks).toEqual({ pre: ['echo starting'] });
    expect(parsed!.body).toBe('body text');
  });

  it('reads a nested mapping whose value is a bare scalar', () => {
    const parsed = parseCommandFile(['---', 'hooks:', '  pre: echo starting', '  post: echo done', '---', 'b'].join('\n'));

    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.hooks).toEqual({ pre: ['echo starting'], post: ['echo done'] });
  });

  it('still reads a top-level key that follows a nested mapping', () => {
    const parsed = parseCommandFile(
      ['---', 'hooks:', '  pre: ["a"]', 'model: claude-sonnet-4-20250514', '---', 'b'].join('\n'),
    );

    // The cursor has to land on the next line rather than the one just folded
    // into the nested object, or every field written after `hooks:` is lost.
    expect(parsed!.frontmatter.model).toBe('claude-sonnet-4-20250514');
  });

  it('reads a nested block array', () => {
    const parsed = parseCommandFile(['---', 'hooks:', '  pre:', '    - echo a', '    - echo b', '---', 'b'].join('\n'));

    expect(parsed!.frontmatter.hooks).toEqual({ pre: ['echo a', 'echo b'] });
  });

  it('keeps the hyphenated spelling of a field written after a nested mapping', () => {
    const parsed = parseCommandFile(
      ['---', 'hooks:', '  pre: ["a"]', 'allowed-tools: [read, search]', '---', 'b'].join('\n'),
    );

    // The loader reads either spelling (`argumentHint ?? 'argument-hint'`), so
    // what matters is that the line the user wrote is still in the record after
    // a nested mapping has been folded — not consumed twice or dropped.
    expect(parsed!.frontmatter['allowed-tools']).toEqual(['read', 'search']);
  });
});
