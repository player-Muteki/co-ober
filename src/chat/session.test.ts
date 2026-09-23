import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from './session';
import type { ContentBlock, SerializedMessage, SerializedSession } from '../types';
import { setLocale } from '../i18n/index';

function createSession(id: string, updatedAt = 1, messageCount = 0): SerializedSession {
  return {
    sessionId: id,
    title: `Session ${id}`,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: 'user',
      content: `message ${index}`,
      type: 'text',
      timestamp: index,
    })),
    createdAt: 1,
    updatedAt,
  };
}

function createRepository() {
  const save = vi.fn().mockResolvedValue(undefined);
  return { repository: new SessionRepository(save), save };
}

describe('SessionRepository', () => {
  it('hydrates persisted sessions and active state', () => {
    const { repository } = createRepository();
    const session = createSession('s1');

    repository.hydrate([session], 's1');

    expect(repository.get('s1')).toBe(session);
    expect(repository.activeId).toBe('s1');
  });

  it('creates localized sessions and makes them active', () => {
    setLocale('en');
    const { repository } = createRepository();

    const session = repository.getOrCreate('new-id');

    expect(session.sessionId).toBe('new-id');
    expect(session.title).toContain('Chat ');
    expect(session.messages).toEqual([]);
    expect(repository.activeId).toBe('new-id');
  });

  it('renames an existing session and reports the title in listings', () => {
    const { repository } = createRepository();
    repository.hydrate([createSession('s1')], 's1');

    expect(repository.rename('s1', 'Thesis brainstorming')).toBe(true);

    expect(repository.get('s1')!.title).toBe('Thesis brainstorming');
    expect(repository.list()[0].title).toBe('Thesis brainstorming');
  });

  it('returns false when renaming an unknown session', () => {
    const { repository } = createRepository();
    expect(repository.rename('missing', 'x')).toBe(false);
  });

  it('lists pinned sessions first, then most recently active', () => {
    const { repository } = createRepository();
    repository.hydrate([createSession('a', 100), createSession('b', 300), createSession('c', 200)], 'a');

    expect(repository.setPinned('b', true)).toBe(true);

    expect(repository.list().map((s) => s.sessionId)).toEqual(['b', 'c', 'a']);
    expect(repository.list()[0].pinned).toBe(true);
    expect(repository.list()[1].pinned).toBeUndefined();
  });

  it('unpinning drops the flag and restores recency order', () => {
    const { repository } = createRepository();
    const session = createSession('a', 100);
    repository.hydrate([session, createSession('b', 300)], 'a');
    repository.setPinned('a', true);

    expect(repository.setPinned('a', false)).toBe(true);

    expect(session.pinned).toBeUndefined();
    expect(repository.list().map((s) => s.sessionId)).toEqual(['b', 'a']);
    expect(repository.list().every((s) => s.pinned === undefined)).toBe(true);
  });

  it('returns false when pinning an unknown session', () => {
    const { repository } = createRepository();
    expect(repository.setPinned('missing', true)).toBe(false);
  });

  it('localizes new session titles', () => {
    setLocale('zh');
    const { repository } = createRepository();

    expect(repository.getOrCreate('zh-id').title).toContain('会话 ');
    setLocale('en');
  });

  it('returns an existing session without creating a duplicate', () => {
    const { repository } = createRepository();
    const existing = repository.getOrCreate('same-id');

    expect(repository.getOrCreate('same-id')).toBe(existing);
    expect(repository.list()).toHaveLength(1);
  });

  it('appends messages and ignores unknown sessions', () => {
    const { repository } = createRepository();
    repository.getOrCreate('s1');
    const message: SerializedMessage = { role: 'user', content: 'hi', type: 'text', timestamp: 1 };

    repository.append('s1', message);

    expect(repository.get('s1')?.messages).toEqual([message]);
    expect(() => repository.append('missing', message)).not.toThrow();
  });

  it('lists session metadata and updates active state', () => {
    const { repository } = createRepository();
    repository.getOrCreate('s1');
    repository.getOrCreate('s2');
    repository.setActive('s1');

    expect(repository.activeId).toBe('s1');
    expect(repository.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 's1' }),
      expect.objectContaining({ sessionId: 's2' }),
    ]));
  });

  it('removes the active session and clears active state', () => {
    const { repository } = createRepository();
    repository.getOrCreate('s1');
    repository.setActive('s1');

    repository.remove('s1');

    expect(repository.get('s1')).toBeUndefined();
    expect(repository.activeId).toBeNull();
  });

  it('does not reset active state when removing another session', () => {
    const { repository } = createRepository();
    repository.getOrCreate('s1');
    repository.getOrCreate('s2');
    repository.setActive('s1');

    repository.remove('s2');

    expect(repository.activeId).toBe('s1');
  });

  it('rekeys a session to a new id keeping messages and active state', () => {
    const { repository } = createRepository();
    const session = createSession('old', 5, 2);
    repository.hydrate([session], 'old');

    repository.rekey('old', 'new');

    expect(repository.get('old')).toBeUndefined();
    expect(repository.get('new')).toBe(session);
    expect(session.sessionId).toBe('new');
    expect(session.opencodeSessionId).toBe('new');
    expect(session.messages).toHaveLength(2);
    expect(repository.activeId).toBe('new');
  });

  it('rekey ignores unknown ids and no-op renames', () => {
    const { repository } = createRepository();
    const session = createSession('keep');
    repository.hydrate([session], 'keep');

    expect(() => repository.rekey('missing', 'other')).not.toThrow();
    repository.rekey('keep', 'keep');

    expect(repository.get('keep')).toBe(session);
    expect(repository.activeId).toBe('keep');
    expect(repository.list()).toHaveLength(1);
  });

  it('returns persisted state through snapshots', () => {
    const { repository } = createRepository();
    const session = createSession('s1');
    repository.hydrate([session], 's1');

    expect(repository.snapshot()).toEqual({
      sessions: [session],
      activeSessionId: 's1',
    });
  });

  it('delegates saves to its persistence callback', async () => {
    const { repository, save } = createRepository();

    await repository.save();

    expect(save).toHaveBeenCalledOnce();
  });

  it('prunes expired inactive sessions and truncates long histories', () => {
    const { repository } = createRepository();
    const now = 100 * 24 * 60 * 60 * 1000;
    repository.hydrate([
      createSession('active', now, 6),
      createSession('expired', now - 31 * 24 * 60 * 60 * 1000),
    ], 'active');

    repository.prune({ maxMessages: 4, retentionDays: 30, now });

    expect(repository.get('expired')).toBeUndefined();
    expect(repository.get('active')?.messages).toEqual([
      expect.objectContaining({ content: 'message 0' }),
      expect.objectContaining({ type: 'text', role: 'system', content: '[3 earlier messages truncated]' }),
      expect.objectContaining({ content: 'message 4' }),
      expect.objectContaining({ content: 'message 5' }),
    ]);
  });

  it('spares pinned sessions from retention while still truncating their history', () => {
    const { repository } = createRepository();
    const now = 100 * 24 * 60 * 60 * 1000;
    const pinned = createSession('pinned', now - 31 * 24 * 60 * 60 * 1000, 6);
    repository.hydrate([pinned, createSession('active', now)], 'active');
    repository.setPinned('pinned', true);

    repository.prune({ maxMessages: 4, retentionDays: 30, now });

    expect(repository.get('pinned')).toBe(pinned);
    expect(pinned.messages).toHaveLength(4);
  });
});

describe('sidecar text-block elision', () => {
  function sessionWith(messages: SerializedMessage[]): SerializedSession {
    return {
      sessionId: 's1',
      title: 'S1',
      messages,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function assistantText(blocks: ContentBlock[], content: string): SerializedMessage {
    return { role: 'assistant', content, type: 'text', timestamp: 10, contentBlocks: blocks };
  }

  it('drops redundant text blocks on snapshot and rebuilds them on hydrate', () => {
    const { repository } = createRepository();
    repository.hydrate(
      [sessionWith([assistantText([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }], 'hello world')])],
      's1',
    );

    const snapshot = repository.snapshot();
    const persisted = snapshot.sessions[0].messages[0];
    expect(persisted.contentBlocks).toBeUndefined();
    expect(persisted.blocksElided).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('contentBlocks');

    const revived = createRepository();
    revived.repository.hydrate(snapshot.sessions, snapshot.activeSessionId);
    const restored = revived.repository.get('s1')!.messages[0];
    expect(restored.contentBlocks).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(restored.blocksElided).toBeUndefined();
    expect(restored.content).toBe('hello world');
  });

  it('preserves mixed block sets and in-memory state is never elided', () => {
    const { repository } = createRepository();
    const mixed: SerializedMessage = {
      role: 'assistant',
      content: 'answer',
      type: 'text',
      timestamp: 10,
      contentBlocks: [{ type: 'text', text: 'answer' }, { type: 'tool_use', toolCallId: 'tc1' }],
    };
    repository.hydrate([sessionWith([mixed])], 's1');

    const persisted = repository.snapshot().sessions[0].messages[0];
    expect(persisted.contentBlocks).toEqual(mixed.contentBlocks);
    expect(persisted.blocksElided).toBeUndefined();
    expect(repository.get('s1')!.messages[0].contentBlocks).toBeDefined();
  });

  it('keeps text blocks whose join does not equal content', () => {
    const { repository } = createRepository();
    const mismatch = assistantText([{ type: 'text', text: 'partial' }], 'full answer');
    repository.hydrate([sessionWith([mismatch])], 's1');

    const persisted = repository.snapshot().sessions[0].messages[0];
    expect(persisted.contentBlocks).toEqual([{ type: 'text', text: 'partial' }]);
    expect(persisted.blocksElided).toBeUndefined();
  });

  it('leaves user and blockless messages untouched', () => {
    const { repository } = createRepository();
    const user: SerializedMessage = { role: 'user', content: 'q', type: 'text', timestamp: 5 };
    const bare: SerializedMessage = { role: 'assistant', content: 'a', type: 'text', timestamp: 6 };
    repository.hydrate([sessionWith([user, bare])], 's1');

    const snapshot = repository.snapshot();
    expect(snapshot.sessions[0].messages[0]).toBe(user);
    expect(snapshot.sessions[0].messages[1]).toBe(bare);
  });

  it('hydrate keeps identity when nothing was elided', () => {
    const { repository } = createRepository();
    const session = sessionWith([{ role: 'user', content: 'q', type: 'text', timestamp: 5 }]);

    repository.hydrate([session], 's1');

    expect(repository.get('s1')).toBe(session);
  });
});
