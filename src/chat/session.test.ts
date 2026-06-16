import { describe, it, expect, vi } from 'vitest';
import { createSessionStore } from './session';
import type CoOberPlugin from '../main';
import type { SerializedSession, SerializedMessage } from '../types';
import { setLocale } from '../i18n/index';

function createMockPlugin(): CoOberPlugin {
  return {
    sessions: new Map<string, SerializedSession>(),
    activeSessionId: null,
    savePluginData: vi.fn().mockResolvedValue(undefined),
    loadPluginData: vi.fn().mockResolvedValue(undefined),
  } as unknown as CoOberPlugin;
}

describe('SessionStore', () => {
  it('should get an existing session', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    const session: SerializedSession = {
      sessionId: 's1',
      title: 'Test',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    plugin.sessions.set('s1', session);

    expect(store.get('s1')).toBe(session);
    expect(store.get('missing')).toBeUndefined();
  });

  it('should create a new session via getOrCreate', () => {
    setLocale('en');
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);

    const session = store.getOrCreate('new-id');

    expect(session.sessionId).toBe('new-id');
    expect(session.title).toContain('Chat ');
    expect(session.messages).toEqual([]);
    expect(plugin.sessions.has('new-id')).toBe(true);
    expect(store.activeId).toBe('new-id');
    expect(plugin.activeSessionId).toBe('new-id');
  });

  it('should localize new session titles', () => {
    setLocale('zh');
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);

    const session = store.getOrCreate('zh-id');

    expect(session.title).toContain('会话 ');
    setLocale('en');
  });

  it('should return existing session via getOrCreate', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    const existing = store.getOrCreate('same-id');
    const again = store.getOrCreate('same-id');

    expect(again).toBe(existing);
    expect(plugin.sessions.size).toBe(1);
  });

  it('should append messages', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    store.getOrCreate('s1');
    const msg: SerializedMessage = { role: 'user', content: 'hi', type: 'text', timestamp: 1 };

    store.append('s1', msg);

    const session = plugin.sessions.get('s1')!;
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('hi');
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  it('should not append to missing session', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    const msg: SerializedMessage = { role: 'user', content: 'hi', type: 'text', timestamp: 1 };

    expect(() => store.append('missing', msg)).not.toThrow();
  });

  it('should set active session', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);

    store.setActive('s1');

    expect(store.activeId).toBe('s1');
    expect(plugin.activeSessionId).toBe('s1');
  });

  it('should list sessions as metadata', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    store.getOrCreate('s1');
    store.getOrCreate('s2');

    const list = store.list();

    expect(list).toHaveLength(2);
    expect(list[0]).toHaveProperty('sessionId');
    expect(list[0]).toHaveProperty('title');
    expect(list[0]).toHaveProperty('updatedAt');
  });

  it('should save and load', async () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);

    await store.save();
    expect(plugin.savePluginData).toHaveBeenCalled();

    plugin.activeSessionId = 'loaded-id';
    await store.load();
    expect(store.activeId).toBe('loaded-id');
  });

  it('should remove session', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    store.getOrCreate('s1');
    store.setActive('s1');

    store.remove('s1');

    expect(plugin.sessions.has('s1')).toBe(false);
    expect(store.activeId).toBeNull();
  });

  it('should not reset activeId when removing non-active session', () => {
    const plugin = createMockPlugin();
    const store = createSessionStore(plugin);
    store.getOrCreate('s1');
    store.getOrCreate('s2');
    store.setActive('s1');

    store.remove('s2');

    expect(store.activeId).toBe('s1');
  });
});
