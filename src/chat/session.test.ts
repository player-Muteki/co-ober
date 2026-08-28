import { describe, it, expect, vi } from 'vitest';
import { SessionRepository } from './session';
import type { SerializedMessage, SerializedSession } from '../types';
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
});
