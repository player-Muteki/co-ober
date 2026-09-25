import type { SerializedMessage, SerializedSession, TabShell } from '../types';
import type { SerializedSessionState } from './session';
import { MAX_OPEN_TABS } from '../constants';

/**
 * Schema version stamped on data.json. Older releases persisted no version
 * (read as 0) and flow through the v0→v1 migration on load. v2 adds the open
 * tab shells; a v1 file synthesizes the single tab its active session held.
 */
export const PLUGIN_DATA_SCHEMA_VERSION = 2;

/**
 * Raised when data.json carries a schemaVersion newer than this build
 * understands. Loading it anyway and re-saving would stamp the old version
 * and silently destroy fields only the newer plugin wrote — the caller must
 * set the file aside instead.
 */
export class PluginDataTooNewError extends Error {
  constructor(public readonly foundVersion: number) {
    super(`data.json schema version ${foundVersion} is newer than this build supports (${PLUGIN_DATA_SCHEMA_VERSION})`);
    this.name = 'PluginDataTooNewError';
  }
}

const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Permissive on optional/unknown fields, strict on the ones rendering depends on. */
function sanitizeMessage(value: unknown): SerializedMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role)) return null;
  if (typeof value.content !== 'string') return null;
  const type = typeof value.type === 'string' ? value.type : 'text';
  const timestamp = typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? value.timestamp : 0;
  return { ...value, type, timestamp } as unknown as SerializedMessage;
}

function sanitizeSession(value: unknown): SerializedSession | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(sanitizeMessage).filter((m): m is SerializedMessage => m !== null)
    : [];
  return {
    ...value,
    sessionId: value.sessionId,
    title: typeof value.title === 'string' ? value.title : '',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    messages,
  } as unknown as SerializedSession;
}

/** Version of a persisted blob; anything pre-0.1.34 (or malformed) reads as 0. */
export function readSchemaVersion(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  const version = raw.schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 0;
}

/** v0→v1: sanitize sessions and messages so a truncated or hand-edited data.json cannot crash hydrate. */
export function migratePluginDataSessions(sessions: unknown, activeSessionId: unknown): SerializedSessionState {
  const list = Array.isArray(sessions)
    ? sessions.map(sanitizeSession).filter((s): s is SerializedSession => s !== null)
    : [];
  const surviving = new Set(list.map((s) => s.sessionId));
  const active = typeof activeSessionId === 'string' && surviving.has(activeSessionId) ? activeSessionId : null;
  return { sessions: list, activeSessionId: active };
}

export interface TabShellState {
  openTabs: TabShell[];
  activeTabId: string | null;
}

/**
 * v1→v2: the persisted tabs are the tab strip's shape, so a damaged entry is
 * dropped rather than hydrated — a tab pointing at a session that no longer
 * exists would open as an empty panel the user cannot explain. With no stored
 * tabs (or a pre-v2 file) the active session becomes the single tab.
 */
export function migratePluginDataTabs(
  openTabs: unknown,
  activeTabId: unknown,
  survivingSessionIds: Set<string>,
  fallbackActiveSessionId: string | null,
): TabShellState {
  const list: TabShell[] = [];
  const seen = new Set<string>();
  if (Array.isArray(openTabs)) {
    for (const value of openTabs) {
      if (list.length >= MAX_OPEN_TABS) break;
      if (!isRecord(value) || typeof value.tabId !== 'string' || value.tabId.length === 0) continue;
      if (seen.has(value.tabId)) continue;
      const sessionId = value.sessionId;
      if (sessionId !== null && typeof sessionId !== 'string') continue;
      if (typeof sessionId === 'string' && !survivingSessionIds.has(sessionId)) continue;
      seen.add(value.tabId);
      list.push({ tabId: value.tabId, sessionId: sessionId ?? null });
    }
  } else if (fallbackActiveSessionId) {
    list.push({ tabId: 'tab-1', sessionId: fallbackActiveSessionId });
  }

  const active =
    typeof activeTabId === 'string' && list.some((tab) => tab.tabId === activeTabId) ? activeTabId : null;
  return { openTabs: list, activeTabId: active };
}
