import { describe, it, expect } from 'vitest';
import {
  migratePluginDataSessions,
  migratePluginDataTabs,
  PLUGIN_DATA_SCHEMA_VERSION,
  readSchemaVersion,
} from './pluginDataMigration';
import type { TabShellState } from './pluginDataMigration';
import { MAX_OPEN_TABS } from '../constants';

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
    expect(readSchemaVersion({ schemaVersion: PLUGIN_DATA_SCHEMA_VERSION })).toBe(PLUGIN_DATA_SCHEMA_VERSION);
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

describe('migratePluginDataTabs', () => {
  const surviving = new Set(['s1', 's2']);

  function tabs(...entries: unknown[]): TabShellState {
    const first = entries[0];
    const activeTabId = typeof first === 'object' && first !== null && 'tabId' in first
      ? String((first as { tabId: unknown }).tabId)
      : null;
    return migratePluginDataTabs(entries, activeTabId, surviving, 's1');
  }

  it('synthesizes a single shell from the active session for pre-tab data', () => {
    const state = migratePluginDataTabs(undefined, undefined, new Set(['s1']), 's1');
    expect(state).toEqual({ openTabs: [{ tabId: 'tab-1', sessionId: 's1' }], activeTabId: null });
  });

  it('yields nothing when there is no session to put in a tab', () => {
    expect(migratePluginDataTabs(undefined, undefined, new Set(), null).openTabs).toEqual([]);
  });

  it('keeps well-formed shells in order', () => {
    const state = migratePluginDataTabs(
      [{ tabId: 'tab-3', sessionId: 's2' }, { tabId: 'tab-1', sessionId: 's1' }],
      'tab-3',
      surviving,
      null,
    );
    expect(state.openTabs).toEqual([
      { tabId: 'tab-3', sessionId: 's2' },
      { tabId: 'tab-1', sessionId: 's1' },
    ]);
    expect(state.activeTabId).toBe('tab-3');
  });

  it('keeps an empty tab but drops junk entries', () => {
    const state = tabs(
      null,
      7,
      { tabId: '', sessionId: 's1' },
      { sessionId: 's1' },
      { tabId: 'tab-a', sessionId: 5 },
      { tabId: 'tab-b', sessionId: 'gone' },
      { tabId: 'tab-c', sessionId: null },
      { tabId: 'tab-d', sessionId: 's1' },
    );
    expect(state.openTabs).toEqual([
      { tabId: 'tab-c', sessionId: null },
      { tabId: 'tab-d', sessionId: 's1' },
    ]);
  });

  it('drops a repeated tabId rather than opening the same tab twice', () => {
    const state = tabs({ tabId: 'tab-1', sessionId: 's1' }, { tabId: 'tab-1', sessionId: 's2' });
    expect(state.openTabs).toEqual([{ tabId: 'tab-1', sessionId: 's1' }]);
  });

  it('caps the restored strip at the maximum tab count', () => {
    const many = Array.from({ length: MAX_OPEN_TABS + 4 }, (_, i) => ({
      tabId: `tab-${i}`,
      sessionId: i % 2 === 0 ? null : 's1',
    }));
    const state = migratePluginDataTabs(many, null, surviving, null);
    expect(state.openTabs).toHaveLength(MAX_OPEN_TABS);
  });

  it('clears an active tab id that did not survive', () => {
    const state = migratePluginDataTabs([{ tabId: 'tab-1', sessionId: 's1' }], 'tab-gone', surviving, null);
    expect(state.activeTabId).toBeNull();
    expect(migratePluginDataTabs([], 'tab-1', surviving, null).activeTabId).toBeNull();
  });
});
