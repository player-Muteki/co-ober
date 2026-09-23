import { describe, it, expect } from 'vitest';
import {
  migratePluginDataSessions,
  PLUGIN_DATA_SCHEMA_VERSION,
  readSchemaVersion,
} from './pluginDataMigration';

function validMessage(overrides: Record<string, unknown> = {}) {
  return { role: 'user', content: 'hi', type: 'text', timestamp: 5, ...overrides };
}

function validSession(id: string, overrides: Record<string, unknown> = {}) {
  return { sessionId: id, title: `S ${id}`, createdAt: 1, updatedAt: 2, messages: [validMessage()], ...overrides };
}

describe('readSchemaVersion', () => {
  it('reads 0 for legacy blobs without a version and rejects junk values', () => {
    expect(readSchemaVersion({ settings: {} })).toBe(0);
    expect(readSchemaVersion(null)).toBe(0);
    expect(readSchemaVersion('nope')).toBe(0);
    expect(readSchemaVersion({ schemaVersion: -1 })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: 1.5 })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: '1' })).toBe(0);
  });

  it('reads a valid integer version', () => {
    expect(readSchemaVersion({ schemaVersion: PLUGIN_DATA_SCHEMA_VERSION })).toBe(1);
  });
});

describe('migratePluginDataSessions', () => {
  it('passes well-formed state through untouched', () => {
    const state = migratePluginDataSessions([validSession('s1')], 's1');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].messages[0]).toMatchObject({ role: 'user', content: 'hi', timestamp: 5 });
    expect(state.activeSessionId).toBe('s1');
  });

  it('preserves optional message fields it does not understand', () => {
    const state = migratePluginDataSessions(
      [validSession('s1', { messages: [validMessage({ usage: { cost: 1 }, turnStats: { outputTokens: 2, durationMs: 3 } })] })],
      null,
    );
    expect(state.sessions[0].messages[0]).toMatchObject({
      usage: { cost: 1 },
      turnStats: { outputTokens: 2, durationMs: 3 },
    });
  });

  it('drops malformed sessions and non-array session lists', () => {
    const state = migratePluginDataSessions(
      [validSession('good'), null, 42, { title: 'no id' }, { sessionId: '', messages: [] }],
      null,
    );
    expect(state.sessions.map((s) => s.sessionId)).toEqual(['good']);
    expect(migratePluginDataSessions('garbage', null).sessions).toEqual([]);
  });

  it('drops malformed messages but keeps the session', () => {
    const state = migratePluginDataSessions(
      [
        validSession('s1', {
          messages: [validMessage(), 'nope', { role: 'captain', content: 'x', type: 'text', timestamp: 1 }, { role: 'user', type: 'text', timestamp: 1 }],
        }),
      ],
      null,
    );
    expect(state.sessions[0].messages).toHaveLength(1);
  });

  it('coerces missing type and bad timestamps instead of dropping', () => {
    const state = migratePluginDataSessions(
      [validSession('s1', { messages: [{ role: 'assistant', content: 'a', timestamp: 'nope' }] })],
      null,
    );
    expect(state.sessions[0].messages[0]).toMatchObject({ type: 'text', timestamp: 0 });
  });

  it('treats a missing messages array as empty and keeps extra session fields', () => {
    const state = migratePluginDataSessions([validSession('s1', { messages: undefined, pinned: true })], null);
    expect(state.sessions[0].messages).toEqual([]);
    expect(state.sessions[0]).toMatchObject({ pinned: true });
  });

  it('clears an active session id that points at a dropped session', () => {
    expect(migratePluginDataSessions([validSession('s1')], 'gone').activeSessionId).toBeNull();
    expect(migratePluginDataSessions([validSession('s1')], 7 as unknown as string).activeSessionId).toBeNull();
  });
});
