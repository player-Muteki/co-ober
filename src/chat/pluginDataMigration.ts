import type { CoOberSettings, ContextRef, SerializedMessage, SerializedSession, StoredDraft, TabShell } from '../types';
import type { SerializedSessionState } from './session';
import { MAX_OPEN_TABS, MAX_TIMESTAMP_MS } from '../constants';

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

/**
 * Whether an entry of a persisted session list would actually load. The save
 * path counts the conversations in a file to decide whether the rolling backup
 * is about to be overwritten by an emptying write, and that count has to mean
 * what the loader keeps: an id list — `["ses-1","ses-2"]`, what a partial merge
 * or a foreign writer leaves behind — parses, is an array, and loads as zero
 * conversations. Counted as two, it outvotes the backup that still holds the
 * real sessions and the loss becomes permanent.
 */
export function isLoadableSessionEntry(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0;
}

/**
 * A stored timestamp past `MAX_TIMESTAMP_MS` — or the `Infinity` that
 * `JSON.parse('1e999')` hands back, which is `typeof 'number'` — is a damaged
 * value: every render of the session list throws on `toISOString()`, and
 * retention can never prune the conversation (`Infinity < cutoff` is false), so
 * it survives to be re-stamped on every save. It collapses to 0, which renders
 * as no time at all (transcript.ts, NativeSessionReader.ts) and which retention
 * spares.
 */
function toTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS ? value : 0;
}

/** Permissive on optional/unknown fields, strict on the ones rendering depends on. */
function sanitizeMessage(value: unknown): SerializedMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role)) return null;
  if (typeof value.content !== 'string') return null;
  const type = typeof value.type === 'string' ? value.type : 'text';
  const timestamp = toTimestamp(value.timestamp);
  const copy: Record<string, unknown> = { ...value, type, timestamp };
  // Rendering and the persisted image budget both walk these two arrays, so a
  // single malformed element is enough to make every later save throw inside
  // the snapshot (a truncated transcript then never reaches disk) — and a
  // non-string image payload turns the byte total into NaN, which purges every
  // image, pinned ones included. Drop anything the loops cannot safely read.
  if ('contentBlocks' in copy) {
    const blocks = Array.isArray(copy.contentBlocks) ? copy.contentBlocks.filter(isRecord) : [];
    if (blocks.length > 0) copy.contentBlocks = blocks;
    else delete copy.contentBlocks;
  }
  if ('images' in copy) {
    const images = Array.isArray(copy.images)
      ? copy.images.filter((img) => isRecord(img) && typeof img.data === 'string')
      : [];
    if (images.length > 0) copy.images = images;
    else delete copy.images;
  }
  return copy as unknown as SerializedMessage;
}

/**
 * The composer's unsent paragraph. It exists nowhere but data.json — not in a
 * session, not in a note — so a migration that rebuilds a tab shell without it
 * loses the text twice: once on this load, and once for good when the next
 * save writes the shell it was given.
 */
function sanitizeDraft(value: unknown): StoredDraft | undefined {
  if (!isRecord(value) || typeof value.text !== 'string') return undefined;
  const draft: StoredDraft = { text: value.text };
  if (Array.isArray(value.refs)) {
    const refs = value.refs.flatMap((ref) => {
      if (!isRecord(ref)) return [];
      const { id, type, name, path } = ref;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof path !== 'string') return [];
      // Positive disjunction so `type` narrows to the literal union and the
      // object literal structurally matches Pick<ContextRef, ...>.
      if (type !== 'note' && type !== 'file') return [];
      const refType: ContextRef['type'] = type;
      return [{ id, type: refType, name, path }];
    });
    if (refs.length > 0) draft.refs = refs;
  }
  if (Array.isArray(value.manual)) {
    const manual = value.manual.filter((id): id is string => typeof id === 'string');
    if (manual.length > 0) draft.manual = manual;
  }
  if (typeof value.images === 'number' && Number.isFinite(value.images) && value.images > 0) {
    draft.images = Math.floor(value.images);
  }
  return draft;
}

function sanitizeSession(value: unknown): SerializedSession | null {
  if (!isLoadableSessionEntry(value)) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(sanitizeMessage).filter((m): m is SerializedMessage => m !== null)
    : [];
  return {
    ...value,
    sessionId: value.sessionId,
    title: typeof value.title === 'string' ? value.title : '',
    createdAt: toTimestamp(value.createdAt),
    updatedAt: toTimestamp(value.updatedAt),
    messages,
  } as unknown as SerializedSession;
}

/**
 * Version of a persisted blob; anything pre-0.1.34 (or malformed) reads as 0.
 * A number that is merely unusual — 3.5, 1e300 — still says "written by
 * something newer than me", so it is returned as-is for the caller's
 * too-new check rather than collapsed to 0 and migrated-and-restamped.
 */
export function readSchemaVersion(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  const version = raw.schemaVersion;
  return typeof version === 'number' && version > 0 ? version : 0;
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

/**
 * Whether a migrated list carries one sessionId twice. This build's own writer
 * cannot produce that — the snapshot comes out of a Map keyed by sessionId — so
 * a duplicate is a partial merge, a foreign writer, or a hand edit: exactly the
 * artifacts the versioned-file gates above exist for. hydrate() writes both
 * records into the same key and the later one silently wins, so the load
 * "succeeds", restore-from-backup never runs, and one conversation is gone from
 * the screen and from the next autosave. A list this loader cannot honour
 * without dropping a conversation is a damaged store, not a smaller one.
 */
export function hasDuplicateSessionIds(sessions: readonly { sessionId: string }[]): boolean {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.sessionId)) return true;
    seen.add(session.sessionId);
  }
  return false;
}

export interface TabShellState {
  openTabs: TabShell[];
  activeTabId: string | null;
}

const SETTINGS_ARRAY_FIELDS = ['syncRules', 'mcpServers', 'customSkills', 'customAgents', 'commonModels'] as const;
const SETTINGS_NUMBER_FIELDS = [
  'maxNoteSize',
  'maxSessionMessages',
  'sessionRetentionDays',
  'maxOpenTabs',
  'terminalTimeoutMs',
  'terminalMaxOutputBytes',
  'idleTimeoutMs',
] as const;
const SETTINGS_STRING_FIELDS = [
  'opencodePath',
  'defaultAgent',
  'defaultModel',
  'defaultEffort',
  'defaultNoteFolder',
  'systemPrompt',
  'language',
  'activeCustomAgentId',
] as const;
const SETTINGS_ENUM_FIELDS: Record<string, readonly string[]> = {
  permissionMode: ['yolo', 'plan', 'safe', 'readonly'],
  fsCapability: ['enabled', 'readonly', 'disabled'],
  terminalCapability: ['enabled', 'disabled'],
};

/**
 * Servers stored before this plugin had http/sse carry no `type` at all — the
 * settings model only had stdio then. The settings block reads such an entry as
 * stdio (`server.type ?? 'stdio'`) and shows its command, while the send path
 * takes the missing type as the url branch, finds no url, and drops the server
 * without a word: a toggle reading "enabled" for a server no session ever got.
 * Stamping the transport the settings page already names keeps that promise on
 * every reader at once; anything else is left exactly as stored.
 */
function withLegacyMcpType(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.type === 'stdio' || value.type === 'http' || value.type === 'sse') return value;
  if (typeof value.command === 'string' && value.command.trim()) return { ...value, type: 'stdio' };
  return value;
}

/**
 * Loading settings is a shallow merge over DEFAULT_SETTINGS, so a field the
 * disk got wrong reaches the settings tab, the sync engine and the permission
 * tier as the wrong type — `"syncRules": "edit"` is a string where a `.filter`
 * runs, and one half-written data.json then takes the whole configuration down
 * with it. Each typed field is checked at this boundary instead; anything else
 * stored there is left alone.
 */
export function sanitizeLoadedSettings(raw: unknown, defaults: CoOberSettings): CoOberSettings {
  const merged = { ...defaults, ...(isRecord(raw) ? raw : {}) };
  const fields = merged as unknown as Record<string, unknown>;
  const fallbacks = defaults as unknown as Record<string, unknown>;
  for (const key of SETTINGS_ARRAY_FIELDS) {
    if (!Array.isArray(fields[key])) fields[key] = fallbacks[key];
  }
  for (const key of SETTINGS_NUMBER_FIELDS) {
    const value = fields[key];
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) fields[key] = fallbacks[key];
  }
  for (const key of SETTINGS_STRING_FIELDS) {
    const value = fields[key];
    if (value !== undefined && typeof value !== 'string') fields[key] = fallbacks[key];
  }
  for (const [key, allowed] of Object.entries(SETTINGS_ENUM_FIELDS)) {
    const value = fields[key];
    if (value !== undefined && !allowed.includes(value as string)) fields[key] = fallbacks[key];
  }
  if (Array.isArray(fields.mcpServers)) {
    fields.mcpServers = fields.mcpServers.map(withLegacyMcpType);
  }
  return merged;
}

/**
 * v1→v2: the persisted tabs are the tab strip's shape, so a damaged entry is
 * dropped rather than hydrated — a tab pointing at a session that no longer
 * exists would open as an empty panel the user cannot explain. With no stored
 * tabs (or a pre-v2 file) the active session becomes the single tab. A shell's
 * draft travels with it: rebuilding the entry without the field the save path
 * wrote is how a typed-but-unsent paragraph disappears on restart.
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
      const draft = sanitizeDraft(value.draft);
      list.push(draft ? { tabId: value.tabId, sessionId: sessionId ?? null, draft } : { tabId: value.tabId, sessionId: sessionId ?? null });
    }
  } else if (fallbackActiveSessionId) {
    list.push({ tabId: 'tab-1', sessionId: fallbackActiveSessionId });
  }

  const active =
    typeof activeTabId === 'string' && list.some((tab) => tab.tabId === activeTabId) ? activeTabId : null;
  return { openTabs: list, activeTabId: active };
}
