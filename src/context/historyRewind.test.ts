import { describe, expect, it } from 'vitest';
import { buildHistoryBlock } from './historyRewind';
import { setLocale, t } from '../i18n/index';
import type { SerializedMessage } from '../types';

setLocale('en');

function msg(role: SerializedMessage['role'], type: SerializedMessage['type'], content: string): SerializedMessage {
  return { role, type, content, timestamp: 0 };
}

describe('buildHistoryBlock', () => {
  it('returns undefined when no text turns are present', () => {
    expect(buildHistoryBlock([])).toBeUndefined();
    expect(buildHistoryBlock([msg('user', 'thinking', 'hmm'), msg('assistant', 'text', '   ')])).toBeUndefined();
  });

  it('renders user and assistant text turns in order between the context markers', () => {
    const block = buildHistoryBlock([
      msg('user', 'text', 'first question'),
      msg('assistant', 'thinking', 'internal only'),
      msg('assistant', 'text', 'first answer'),
      msg('system', 'text', 'not part of the transcript'),
    ]);

    expect(block).toBeDefined();
    expect(block).toContain(t().rewind.contextHeader);
    expect(block).toContain(t().rewind.contextFooter);
    expect(block).toContain('User: first question');
    expect(block).toContain('Assistant: first answer');
    expect(block).not.toContain('internal only');
    expect(block).not.toContain('not part of the transcript');
    expect(block!.indexOf('User: first question')).toBeLessThan(block!.indexOf('Assistant: first answer'));
    expect(block!.indexOf(t().rewind.contextHeader)).toBeLessThan(block!.indexOf('User: first question'));
    expect(block!.indexOf(t().rewind.contextFooter)).toBeGreaterThan(block!.indexOf('Assistant: first answer'));
  });

  it('keeps every occurrence of repeated turns', () => {
    const block = buildHistoryBlock([
      msg('user', 'text', 'again'),
      msg('assistant', 'text', 'same'),
      msg('user', 'text', 'again'),
      msg('assistant', 'text', 'same'),
    ]);

    expect(block).toContain('Assistant: same');
    expect((block!.match(/User: again/g) ?? [])).toHaveLength(2);
  });

  it('annotates turns that carried images', () => {
    const withImage: SerializedMessage = {
      role: 'user', type: 'text', content: 'look at this', timestamp: 0,
      images: [{ mimeType: 'image/png', data: 'AAA=' }],
    };
    const withTwoImages: SerializedMessage = {
      role: 'user', type: 'text', content: '', timestamp: 0,
      images: [
        { mimeType: 'image/png', data: 'AAA=' },
        { mimeType: 'image/jpeg', data: 'BBB=' },
      ],
    };

    const block = buildHistoryBlock([withImage, withTwoImages]);

    expect(block).toContain('User: look at this [+1 image not included]');
    expect(block).toContain('[+2 images not included]');
  });
});
