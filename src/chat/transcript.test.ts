import { describe, expect, it, beforeEach } from 'vitest';
import { setLocale } from '../i18n/index';
import { buildTranscriptMarkdown, sanitizeNoteName } from './transcript';
import type { SerializedSession } from '../types';

function session(overrides: Partial<SerializedSession> = {}): SerializedSession {
  return {
    sessionId: 'ses-1',
    title: 'Planning note',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildTranscriptMarkdown', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('renders title and role-headed text turns', () => {
    const md = buildTranscriptMarkdown(session({
      messages: [
        { role: 'user', content: 'hello', type: 'text', timestamp: 1755000000000 },
        { role: 'assistant', content: 'hi there', type: 'text', timestamp: 1755000001000 },
      ],
    }));
    expect(md).toContain('# Planning note');
    expect(md).toContain('## User · ');
    expect(md).toContain('hello');
    expect(md).toContain('## Assistant · ');
    expect(md).toContain('hi there');
  });

  it('skips non-text and empty messages', () => {
    const md = buildTranscriptMarkdown(session({
      messages: [
        { role: 'assistant', content: '', type: 'tool-call', toolCallId: 'c1', timestamp: 1 },
        { role: 'assistant', content: 'searched', type: 'tool-result', timestamp: 2 },
        { role: 'user', content: '', type: 'text', timestamp: 3 },
        { role: 'assistant', content: 'real answer', type: 'text', timestamp: 4 },
      ],
    }));
    expect(md).not.toContain('tool-result');
    expect(md).toContain('real answer');
    // Only one Assistant header (from the real answer) plus the user turn is skipped
    expect((md.match(/## /g) ?? []).length).toBe(1);
  });

  it('annotates image attachments with placeholders', () => {
    const md = buildTranscriptMarkdown(session({
      messages: [
        {
          role: 'user',
          content: 'look',
          type: 'text',
          timestamp: 1,
          images: [
            { mimeType: 'image/png', data: 'AAA=' },
            { mimeType: 'image/jpeg', data: 'BBB=' },
          ],
        },
      ],
    }));
    expect(md).toContain('look');
    expect(md).toContain('[image] [image]');
  });

  it('keeps a picture the agent showed, which is a block and not an attachment', () => {
    const md = buildTranscriptMarkdown(session({
      messages: [
        {
          role: 'assistant',
          content: '',
          type: 'text',
          timestamp: 1,
          contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'AAA=' }],
        },
      ],
    }));
    // The agent's own images arrive with the message content left empty, so this
    // turn was on screen and nothing at all in the exported note.
    expect(md).toContain('## Assistant · ');
    expect(md).toContain('[image]');
  });

  it('carries the steps of a turn that answered in tool calls alone', () => {
    const md = buildTranscriptMarkdown(session({
      messages: [
        {
          role: 'assistant',
          content: '',
          type: 'tool-call',
          timestamp: 1,
          contentBlocks: [
            { type: 'tool_use', toolCallId: 'c1', toolTitle: 'Read notes/a.md', toolKind: 'read', toolStatus: 'completed' },
            { type: 'tool_use', toolCallId: 'c2', toolKind: 'search', toolStatus: 'completed' },
          ],
        },
      ],
    }));
    expect(md).toContain('## Assistant · ');
    expect(md).toContain('[tool] Read notes/a.md');
    // A card with no title of its own contributes no empty bullet.
    expect((md.match(/\[tool\]/g) ?? []).length).toBe(1);
  });

  it('names the exported steps and pictures in the note language', () => {
    setLocale('zh');
    const md = buildTranscriptMarkdown(session({
      messages: [
        {
          role: 'assistant',
          content: '',
          type: 'tool-call',
          timestamp: 1,
          contentBlocks: [
            { type: 'tool_use', toolCallId: 'c1', toolTitle: '读取', toolKind: 'read', toolStatus: 'completed' },
            { type: 'image', mimeType: 'image/png', data: 'AAA=' },
          ],
        },
      ],
    }));
    expect(md).toContain('[工具] 读取');
    expect(md).toContain('[图片]');
    setLocale('en');
  });

  it('uses localized role labels', () => {
    setLocale('zh');
    const md = buildTranscriptMarkdown(session({
      messages: [{ role: 'user', content: '你好', type: 'text', timestamp: 1 }],
    }));
    expect(md).toContain('## 用户 · ');
    setLocale('en');
  });
});

describe('sanitizeNoteName', () => {
  it('strips vault-hostile characters and collapses whitespace', () => {
    expect(sanitizeNoteName('a/b:c *d?*')).toBe('a b c d');
  });

  it('falls back for empty titles', () => {
    expect(sanitizeNoteName('   ')).toBe('chat');
  });

  it('caps length', () => {
    expect(sanitizeNoteName('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('never leaves half of a pair at the cap', () => {
    const name = sanitizeNoteName(`${'x'.repeat(79)}😀tail`);
    // A lone high surrogate is a filename no note can be read back from.
    expect(name).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(name).toBe('x'.repeat(79));
  });

  it('keeps a pair that ends exactly at the cap', () => {
    expect(sanitizeNoteName(`${'x'.repeat(78)}😀tail`)).toBe(`${'x'.repeat(78)}😀`);
  });
});
