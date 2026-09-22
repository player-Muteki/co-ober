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
});
