import { describe, expect, it } from 'vitest';
import { SessionReplayCollector } from './sessionReplay';
import { setLocale } from '../i18n/index';
import type { NormalizedUpdate } from '../types';

function chunk(role: 'user' | 'agent' | 'thought', messageId: string, text: string): NormalizedUpdate {
  return { kind: 'message_chunk', role, messageId, chunkText: text, accumulatedText: text };
}

describe('SessionReplayCollector', () => {
  it('merges chunks per message and preserves arrival order', () => {
    const collector = new SessionReplayCollector();
    collector.handle(chunk('user', 'u1', 'hello '));
    collector.handle(chunk('user', 'u1', 'world'));
    collector.handle(chunk('agent', 'a1', 'answer'));

    const messages = collector.finish();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', type: 'text', content: 'hello world' });
    expect(messages[1]).toMatchObject({ role: 'assistant', type: 'text', content: 'answer' });
  });

  it('maps thought chunks to assistant thinking messages', () => {
    const collector = new SessionReplayCollector();
    collector.handle(chunk('thought', 't1', 'pondering'));
    collector.handle(chunk('agent', 'a1', 'spoken'));

    const messages = collector.finish();
    expect(messages[0]).toMatchObject({ role: 'assistant', type: 'thinking', content: 'pondering' });
    expect(messages[1]).toMatchObject({ role: 'assistant', type: 'text', content: 'spoken' });
  });

  it('keeps text and thought under the same messageId separate', () => {
    const collector = new SessionReplayCollector();
    collector.handle(chunk('thought', 'm1', 'internal'));
    collector.handle(chunk('agent', 'm1', 'external'));

    const messages = collector.finish();
    expect(messages.map((m) => `${m.type}:${m.content}`)).toEqual(['thinking:internal', 'text:external']);
  });

  it('ignores non-message updates and blank text', () => {
    const collector = new SessionReplayCollector();
    collector.handle({ kind: 'plan', entries: [] });
    collector.handle(chunk('agent', 'a1', '   '));
    expect(collector.finish()).toEqual([]);
  });

  it('carries the native message id for cost/token matching', () => {
    const collector = new SessionReplayCollector();
    collector.handle(chunk('agent', 'msg_0ad397', 'answer'));
    collector.handle(chunk('thought', 'msg_0ad397', 'pondering'));

    const messages = collector.finish();
    expect(messages[0]?.nativeMessageId).toBe('msg_0ad397');
    expect(messages[1]?.nativeMessageId).toBe('msg_0ad397');
  });
});

describe('SessionReplayCollector compaction boundary', () => {
  it('inserts the localized compaction marker at its arrival position', () => {
    setLocale('en');
    const collector = new SessionReplayCollector();
    collector.handle(chunk('user', 'u1', 'question'));
    collector.handle({ kind: 'compaction' });
    collector.handle(chunk('agent', 'a1', 'after compaction'));

    const messages = collector.finish();
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:question',
      'assistant:— Context compacted by the agent —',
      'assistant:after compaction',
    ]);
  });
});
