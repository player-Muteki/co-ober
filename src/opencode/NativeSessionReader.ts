import type { SessionMeta } from '../types';
import { resolveOpencodeDatabasePath, type PathFs } from './OpencodePaths';
import { querySqliteJson, type SqliteReaderDeps, type SqliteRow } from './SqliteReader';

export const NATIVE_SESSION_LIMIT = 50;
export const NATIVE_SESSION_SEARCH_LIMIT = 20;

export interface NativeSessionReaderDeps {
	env?: NodeJS.ProcessEnv;
	fs?: PathFs;
	sqlite?: SqliteReaderDeps;
}

function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

export type NativeSchemaKind = 'v1' | 'forked' | 'incompatible' | 'unknown';

// The v1 layout co-ober reads: a `session` table carrying these exact columns.
// A newer (v2+) database renames or drops them; instead of firing doomed v1
// queries at every read (and crashing on nothing — queries are all caught —
// but spamming generic failures), probe once per path, then degrade with an
// explicit message.
// v1.18 also keeps the legacy v1 tables while new writes land in v2
// (`session_message` events, `data_migration` completion markers), so a v1
// shape alone no longer proves the rows are current — a fork must be
// detected too. `session_message` foreign-keys to `session`, so the session
// registry stays shared across the fork and only the message/part tables go
// stale; forked databases read content through the v2 tables instead.
const SCHEMA_PROBE_SQL = [
	'select',
	"(select count(*) from sqlite_master where type = 'table' and name = 'session') as session_table,",
	"(select count(*) from pragma_table_info('session') where name in ('id','title','directory','time_updated','time_archived','parent_id')) as session_columns,",
	"(select count(*) from sqlite_master where type = 'table' and name in ('session_v2','session_message','data_migration')) as v2_tables",
].join(' ');

const SCHEMA_FORK_SQL = [
	'select',
	'(select count(*) from data_migration) as migrated,',
	'(select count(*) from session_message) as v2_rows',
].join(' ');

const schemaProbeCache = new Map<string, NativeSchemaKind>();
const warnedDegraded = new Set<string>();
const SCHEMA_CACHE_LIMIT = 16;

/** True when native reads must be degraded for this schema classification. */
export function isDegradedNativeSchema(kind: NativeSchemaKind): boolean {
	return kind === 'incompatible';
}

/** Which message tables carry current data for a readable database. */
export type NativeReadFormat = 'v1' | 'v2';

/**
 * Resolve the message storage a readable database currently uses.
 * Null means the schema is incompatible and native reads must be skipped;
 * 'unknown' probes stay on v1 so existing behavior is unchanged.
 */
async function resolveNativeReadFormat(databasePath: string, deps: NativeSessionReaderDeps): Promise<NativeReadFormat | null> {
	const kind = await probeNativeSchema(databasePath, deps);
	if (kind === 'incompatible') return null;
	return kind === 'forked' ? 'v2' : 'v1';
}

/** Classify an OpenCode database against the v1 schema; the result is cached per path. */
export async function probeNativeSchema(databasePath: string, deps: NativeSessionReaderDeps = {}): Promise<NativeSchemaKind> {
	const cached = schemaProbeCache.get(databasePath);
	if (cached) return cached;
	let rows: SqliteRow[];
	try {
		rows = await querySqliteJson(databasePath, SCHEMA_PROBE_SQL, deps.sqlite);
	} catch (error) {
		// The probe fails exactly when the database itself is unreadable; leave
		// it unknown (uncached) and let the real query degrade on its own.
		console.warn('[co-ober] native OpenCode schema probe unavailable:', error);
		return 'unknown';
	}
	const row: SqliteRow | undefined = rows[0];
	const sessionTable = typeof row?.session_table === 'number' ? row.session_table : 0;
	const sessionColumns = typeof row?.session_columns === 'number' ? row.session_columns : 0;
	const v2Tables = typeof row?.v2_tables === 'number' ? row.v2_tables : 0;
	let kind: NativeSchemaKind;
	if (sessionTable < 1 || sessionColumns < 6) {
		kind = 'incompatible';
	} else if (v2Tables > 0) {
		kind = (await hasV2DataDiverged(databasePath, deps)) ? 'forked' : 'v1';
	} else {
		kind = 'v1';
	}
	if (schemaProbeCache.size >= SCHEMA_CACHE_LIMIT) schemaProbeCache.clear();
	schemaProbeCache.set(databasePath, kind);
	if ((kind === 'forked' || kind === 'incompatible') && !warnedDegraded.has(databasePath)) {
		warnedDegraded.add(databasePath);
		console.warn(
			kind === 'forked'
				? `[co-ober] OpenCode database "${databasePath}" has migrated to the v2 storage layout; co-ober reads session content through the session_message event tables.`
				: `[co-ober] OpenCode database "${databasePath}" does not match the v1 schema co-ober reads (newer v2 layout?). Native session listing, search and usage are disabled until co-ober supports it.`,
		);
	}
	return kind;
}

/**
 * True when the v2 tables actually carry data. A failed count is treated as
 * diverged: existence plus an unreadable table can only come from a v2-era
 * database, and silently reading a stale v1 mirror is the worse error.
 */
async function hasV2DataDiverged(databasePath: string, deps: NativeSessionReaderDeps): Promise<boolean> {
	try {
		const rows = await querySqliteJson(databasePath, SCHEMA_FORK_SQL, deps.sqlite);
		const row: SqliteRow | undefined = rows[0];
		const migrated = typeof row?.migrated === 'number' ? row.migrated : 0;
		const v2Rows = typeof row?.v2_rows === 'number' ? row.v2_rows : 0;
		return migrated > 0 || v2Rows > 0;
	} catch {
		return true;
	}
}

/** Drop cached probe results — test seam, or after the database file is replaced. */
export function resetNativeSchemaProbe(): void {
	schemaProbeCache.clear();
	warnedDegraded.clear();
}

/** Escape a value for safe embedding as a single-quoted SQLite string literal. */
export function escapeSqlLiteral(value: string): string {
	if (hasControlCharacter(value)) {
		throw new Error('Illegal control character in SQL literal');
	}
	return value.split("'").join("''");
}

/** Escape LIKE metacharacters; the query uses ESCAPE '\'. */
export function escapeLikePattern(value: string): string {
	return value
		.split('\\').join('\\\\')
		.split('%').join('\\%')
		.split('_').join('\\_');
}

export function buildNativeSessionsSql(cwd: string, limit: number = NATIVE_SESSION_LIMIT): string {
	const exact = escapeSqlLiteral(cwd);
	const prefix = escapeSqlLiteral(escapeLikePattern(cwd)) + '/%';
	const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || NATIVE_SESSION_LIMIT));
	return [
		'select id, title, directory, time_updated, summary_additions, summary_deletions, summary_files from session',
		`where parent_id is null and time_archived is null`,
		`and (directory = '${exact}' or directory like '${prefix}' escape '\\')`,
		'order by time_updated desc',
		`limit ${safeLimit}`,
	].join(' ');
}

// ── v2 (forked database) read variants ──
// After a fork, `session` rows stay current (session_message foreign-keys to
// them) but message content moves to `session_message`: one row per message,
// ordered by `seq`, with the payload in `data` JSON. Assistant `data.content`
// inlines the v1 part rows as a JSON array. All queries below alias their
// columns onto the v1 shapes so row mapping stays shared.

/** Newest activity: the session row's update time or its latest event row. */
const V2_TIME_UPDATED_EXPR = [
	'max(s.time_updated,',
	'coalesce((select max(sm0.time_updated) from session_message sm0 where sm0.session_id = s.id), s.time_updated)) as time_updated',
].join(' ');

export function buildNativeSessionsSqlV2(cwd: string, limit: number = NATIVE_SESSION_LIMIT): string {
	const exact = escapeSqlLiteral(cwd);
	const prefix = escapeSqlLiteral(escapeLikePattern(cwd)) + '/%';
	const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || NATIVE_SESSION_LIMIT));
	return [
		`select s.id, s.title, s.directory, ${V2_TIME_UPDATED_EXPR},`,
		's.summary_additions, s.summary_deletions, s.summary_files',
		'from session s',
		'where s.parent_id is null and s.time_archived is null',
		`and (s.directory = '${exact}' or s.directory like '${prefix}' escape '\\')`,
		'order by time_updated desc',
		`limit ${safeLimit}`,
	].join(' ');
}

function v2TextMatch(dataExpr: string, query: string): string {
	return `${dataExpr} like '${escapeSqlLiteral(`%${escapeLikePattern(query)}%`)}' escape '\\'`;
}

/** Union of user text (`$.text`) and assistant content text parts for one session. */
function v2MessageTextSelects(sessionIdExpr: string, query: string): string[] {
	return [
		`select json_extract(sm.data, '$.text') as txt from session_message sm where sm.session_id = ${sessionIdExpr} and sm.type = 'user' and json_valid(sm.data) and ${v2TextMatch("json_extract(sm.data, '$.text')", query)}`,
		'union all',
		`select json_extract(j.value, '$.text') as txt from session_message sm, json_each(sm.data, '$.content') j where sm.session_id = ${sessionIdExpr} and json_valid(sm.data) and json_extract(j.value, '$.type') = 'text' and ${v2TextMatch("json_extract(j.value, '$.text')", query)}`,
	];
}

export function buildNativeSessionSearchSqlV2(cwd: string, query: string, limit: number = NATIVE_SESSION_SEARCH_LIMIT): string {
	const exact = escapeSqlLiteral(cwd);
	const prefix = escapeSqlLiteral(escapeLikePattern(cwd)) + '/%';
	const term = escapeSqlLiteral(query);
	const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || NATIVE_SESSION_SEARCH_LIMIT));
	const textSelects = v2MessageTextSelects('s.id', query);
	return [
		'select s.id, s.title, s.directory,',
		V2_TIME_UPDATED_EXPR + ',',
		'(select substr(replace(t.txt, char(10), \' \'),',
		`max(1, instr(lower(replace(t.txt, char(10), ' ')), lower('${term}')) - 20), 100) as snippet`,
		'from (',
		...textSelects,
		') t) as snippet',
		'from session s',
		'where s.parent_id is null and s.time_archived is null',
		`and (s.directory = '${exact}' or s.directory like '${prefix}' escape '\\')`,
		`and (s.title like '${escapeSqlLiteral(`%${escapeLikePattern(query)}%`)}' escape '\\' or exists (`,
		...textSelects,
		'))',
		'order by time_updated desc',
		`limit ${safeLimit}`,
	].join(' ');
}

function toIsoString(ms: unknown): string | undefined {
	return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export interface NativeSessionUsage {
	cost: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Context size of the newest assistant turn (message tokens.total), if any. */
	contextTokens?: number;
}

/**
 * Aggregate cost/token columns of the session row plus the context size of its
 * newest assistant message (message.data JSON: `tokens.total`).
 */
export function buildSessionUsageSql(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		'select s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,',
		's.tokens_cache_read, s.tokens_cache_write,',
		'(select cast(json_extract(m.data, \'$.tokens.total\') as integer)',
		`from message m where m.session_id = s.id and json_extract(m.data, '$.role') = 'assistant'`,
		'order by m.time_created desc limit 1) as context_tokens',
		`from session s where s.id = '${id}'`,
	].join(' ');
}

function v2AssistantSum(sessionIdLiteral: string, path: string, alias: string, cast: 'real' | 'integer'): string {
	return [
		`(select coalesce(sum(cast(json_extract(sm.data, '$.${path}') as ${cast})), 0)`,
		`from session_message sm where sm.session_id = '${sessionIdLiteral}'`,
		`and sm.type = 'assistant' and json_valid(sm.data)) as ${alias}`,
	].join(' ');
}

/**
 * v2 totals: the legacy `session` bookkeeping may lag the event log after a
 * fork, so aggregate cost from step-finish parts inside assistant `content`
 * and tokens from each assistant row's own `tokens` object.
 */
export function buildSessionUsageSqlV2(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		'select',
		"(select coalesce(sum(cast(json_extract(j.value, '$.cost') as real)), 0)",
		`from session_message sm, json_each(sm.data, '$.content') j`,
		`where sm.session_id = '${id}' and sm.type = 'assistant' and json_valid(sm.data)`,
		`and json_extract(j.value, '$.type') = 'step-finish') as cost,`,
		v2AssistantSum(id, 'tokens.input', 'tokens_input', 'integer') + ',',
		v2AssistantSum(id, 'tokens.output', 'tokens_output', 'integer') + ',',
		v2AssistantSum(id, 'tokens.reasoning', 'tokens_reasoning', 'integer') + ',',
		v2AssistantSum(id, 'tokens.cache.read', 'tokens_cache_read', 'integer') + ',',
		v2AssistantSum(id, 'tokens.cache.write', 'tokens_cache_write', 'integer') + ',',
		"(select cast(json_extract(sm.data, '$.tokens.total') as integer)",
		`from session_message sm where sm.session_id = '${id}' and sm.type = 'assistant' and json_valid(sm.data)`,
		`and json_extract(sm.data, '$.tokens.total') is not null`,
		'order by sm.seq desc limit 1) as context_tokens',
	].join(' ');
}

function toNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Resolve the OpenCode database and run a read-only query; undefined on any failure. */
async function readNativeRows(sqlFor: (format: NativeReadFormat) => string, deps: NativeSessionReaderDeps, context: string): Promise<SqliteRow[] | undefined> {
	const env = deps.env ?? process.env;
	const databasePath = resolveOpencodeDatabasePath(env, deps.fs);
	if (!databasePath) return undefined;
	const format = await resolveNativeReadFormat(databasePath, deps);
	if (!format) return undefined;
	try {
		return await querySqliteJson(databasePath, sqlFor(format), deps.sqlite);
	} catch (error) {
		console.warn(`[co-ober] ${context} unavailable:`, error);
		return undefined;
	}
}

/**
 * Read authoritative cost/token totals for one OpenCode session from the
 * native database. Returns undefined when the database, backend or row is
 * unavailable; never throws.
 */
export async function readNativeSessionUsage(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<NativeSessionUsage | undefined> {
	if (!sessionId) return undefined;
	const env = deps.env ?? process.env;
	const databasePath = resolveOpencodeDatabasePath(env, deps.fs);
	if (!databasePath) return undefined;
	const format = await resolveNativeReadFormat(databasePath, deps);
	if (!format) return undefined;

	let rows: SqliteRow[];
	try {
		const sql = format === 'v2' ? buildSessionUsageSqlV2(sessionId) : buildSessionUsageSql(sessionId);
		rows = await querySqliteJson(databasePath, sql, deps.sqlite);
	} catch (error) {
		console.warn('[co-ober] native session usage unavailable:', error);
		return undefined;
	}

	const row = rows[0];
	if (!row) return undefined;
	const usage: NativeSessionUsage = {
		cost: toNumber(row.cost),
		inputTokens: toNumber(row.tokens_input),
		outputTokens: toNumber(row.tokens_output),
		reasoningTokens: toNumber(row.tokens_reasoning),
		cacheReadTokens: toNumber(row.tokens_cache_read),
		cacheWriteTokens: toNumber(row.tokens_cache_write),
	};
	const contextTokens = typeof row.context_tokens === 'number' && Number.isFinite(row.context_tokens) ? row.context_tokens : undefined;
	if (contextTokens !== undefined) usage.contextTokens = contextTokens;
	return usage;
}

export interface NativeSessionTodo {
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | string;
	priority?: string;
}

export function buildSessionTodosSql(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return `select content, status, priority from todo where session_id = '${id}' order by position asc`;
}

/**
 * Read the OpenCode-native todo list for one session, ordered by position.
 * Returns an empty list when the database or rows are unavailable; never throws.
 */
export async function readNativeSessionTodos(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<NativeSessionTodo[]> {
	if (!sessionId) return [];
	// `todo` is a session-registry table (FK to `session`) and survives the fork unchanged.
	const rows = await readNativeRows(() => buildSessionTodosSql(sessionId), deps, 'native session todos');
	if (!rows) return [];
	const todos: NativeSessionTodo[] = [];
	for (const row of rows) {
		if (typeof row.content !== 'string' || typeof row.status !== 'string') continue;
		const todo: NativeSessionTodo = { content: row.content, status: row.status };
		if (typeof row.priority === 'string' && row.priority) todo.priority = row.priority;
		todos.push(todo);
	}
	return todos;
}

export interface NativeMessageStat {
	messageId: string;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

/**
 * Aggregate per-assistant-message cost/tokens from step-finish parts, ordered
 * chronologically so stats can be matched to replayed assistant messages by position.
 */
export function buildMessageStatsSql(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		'select m.id as message_id,',
		"sum(coalesce(cast(json_extract(p.data, '$.cost') as real), 0)) as cost,",
		"sum(coalesce(cast(json_extract(p.data, '$.tokens.input') as integer), 0)) as input_tokens,",
		"sum(coalesce(cast(json_extract(p.data, '$.tokens.output') as integer), 0)) as output_tokens,",
		"sum(coalesce(cast(json_extract(p.data, '$.tokens.total') as integer), 0)) as total_tokens",
		'from part p join message m on m.id = p.message_id',
		`where p.session_id = '${id}' and json_extract(p.data, '$.type') = 'step-finish'`,
		"and json_extract(m.data, '$.role') = 'assistant'",
		'group by m.id',
		'order by m.time_created asc',
	].join(' ');
}

export function buildMessageStatsSqlV2(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		'select sm.id as message_id,',
		"(select coalesce(sum(cast(json_extract(j.value, '$.cost') as real)), 0)",
		`from json_each(sm.data, '$.content') j where json_extract(j.value, '$.type') = 'step-finish') as cost,`,
		"coalesce(cast(json_extract(sm.data, '$.tokens.input') as integer), 0) as input_tokens,",
		"coalesce(cast(json_extract(sm.data, '$.tokens.output') as integer), 0) as output_tokens,",
		"coalesce(cast(json_extract(sm.data, '$.tokens.total') as integer), 0) as total_tokens",
		'from session_message sm',
		`where sm.session_id = '${id}' and sm.type = 'assistant' and json_valid(sm.data)`,
		'order by sm.seq asc',
	].join(' ');
}

/** Per-message cost/token stats for a session; empty list on any failure. */
export async function readNativeMessageStats(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<NativeMessageStat[]> {
	if (!sessionId) return [];
	const rows = await readNativeRows(
		(format) => (format === 'v2' ? buildMessageStatsSqlV2(sessionId) : buildMessageStatsSql(sessionId)),
		deps,
		'native message stats',
	);
	if (!rows) return [];
	const stats: NativeMessageStat[] = [];
	for (const row of rows) {
		if (typeof row.message_id !== 'string') continue;
		stats.push({
			messageId: row.message_id,
			cost: toNumber(row.cost),
			inputTokens: toNumber(row.input_tokens),
			outputTokens: toNumber(row.output_tokens),
			totalTokens: toNumber(row.total_tokens),
		});
	}
	return stats;
}

/** Select call IDs of errored tool parts so failed calls can be re-rendered on restore. */
export function buildToolErrorsSql(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		"select json_extract(data, '$.callID') as call_id, json_extract(data, '$.state.error') as error",
		'from part',
		`where session_id = '${id}' and json_extract(data, '$.type') = 'tool'`,
		"and json_extract(data, '$.state.error') is not null",
	].join(' ');
}

export function buildToolErrorsSqlV2(sessionId: string): string {
	const id = escapeSqlLiteral(sessionId);
	return [
		"select json_extract(j.value, '$.callID') as call_id, json_extract(j.value, '$.state.error') as error",
		"from session_message sm, json_each(sm.data, '$.content') j",
		`where sm.session_id = '${id}' and json_valid(sm.data)`,
		"and json_extract(j.value, '$.type') = 'tool'",
		"and json_extract(j.value, '$.state.error') is not null",
	].join(' ');
}

/** Map of OpenCode tool callID -> error message for one session; empty map on any failure. */
export async function readNativeToolErrors(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<Record<string, string>> {
	if (!sessionId) return {};
	const rows = await readNativeRows(
		(format) => (format === 'v2' ? buildToolErrorsSqlV2(sessionId) : buildToolErrorsSql(sessionId)),
		deps,
		'native tool errors',
	);
	const errors: Record<string, string> = {};
	if (!rows) return errors;
	for (const row of rows) {
		if (typeof row.call_id !== 'string' || typeof row.error !== 'string' || !row.error) continue;
		errors[row.call_id] = row.error;
	}
	return errors;
}

/**
 * List OpenCode-native sessions for the given working directory via read-only
 * SQLite access. Degrades to an empty list when no database or SQLite runtime
 * is available; never throws.
 */
export async function listNativeSessions(cwd: string, deps: NativeSessionReaderDeps = {}): Promise<SessionMeta[]> {
	const env = deps.env ?? process.env;
	const databasePath = resolveOpencodeDatabasePath(env, deps.fs);
	if (!databasePath) return [];
	const format = await resolveNativeReadFormat(databasePath, deps);
	if (!format) return [];

	let rows: SqliteRow[];
	try {
		const sql = format === 'v2' ? buildNativeSessionsSqlV2(cwd) : buildNativeSessionsSql(cwd);
		rows = await querySqliteJson(databasePath, sql, deps.sqlite);
	} catch (error) {
		console.warn('[co-ober] native session listing unavailable:', error);
		return [];
	}

	const sessions: SessionMeta[] = [];
	for (const row of rows) {
		const sessionId = typeof row.id === 'string' ? row.id : '';
		if (!sessionId) continue;
		const additions = toOptionalNumber(row.summary_additions);
		const deletions = toOptionalNumber(row.summary_deletions);
		const files = toOptionalNumber(row.summary_files);
		const meta: SessionMeta = {
			sessionId,
			title: typeof row.title === 'string' && row.title.trim() ? row.title : sessionId,
			cwd: typeof row.directory === 'string' ? row.directory : undefined,
			updatedAt: toIsoString(row.time_updated),
		};
		if (additions !== undefined) meta.additions = additions;
		if (deletions !== undefined) meta.deletions = deletions;
		if (files !== undefined) meta.files = files;
		sessions.push(meta);
	}
	return sessions;
}

/**
 * Search OpenCode-native sessions by title or message text. The snippet column
 * extracts 100 characters around the first text-part match.
 */
export function buildNativeSessionSearchSql(cwd: string, query: string, limit: number = NATIVE_SESSION_SEARCH_LIMIT): string {
	const exact = escapeSqlLiteral(cwd);
	const prefix = escapeSqlLiteral(escapeLikePattern(cwd)) + '/%';
	const term = escapeSqlLiteral(query);
	const like = `'${escapeSqlLiteral(`%${escapeLikePattern(query)}%`)}'`;
	const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || NATIVE_SESSION_SEARCH_LIMIT));
	const textMatch = `json_extract(p.data, '$.text') like ${like} escape '\\'`;
	return [
		'select s.id, s.title, s.directory, s.time_updated,',
		"(select substr(replace(json_extract(p.data, '$.text'), char(10), ' '),",
		`max(1, instr(lower(replace(json_extract(p.data, '$.text'), char(10), ' ')), lower('${term}')) - 20), 100) as snippet`,
		'from part p join message m on m.id = p.message_id',
		`where m.session_id = s.id and json_extract(p.data, '$.type') = 'text' and ${textMatch})`,
		'from session s',
		'where s.parent_id is null and s.time_archived is null',
		`and (s.directory = '${exact}' or s.directory like '${prefix}' escape '\\')`,
		`and (s.title like ${like} escape '\\' or exists (select 1 from part p join message m on m.id = p.message_id where m.session_id = s.id and json_extract(p.data, '$.type') = 'text' and ${textMatch}))`,
		'order by s.time_updated desc',
		`limit ${safeLimit}`,
	].join(' ');
}

/** Content-search OpenCode-native sessions for the vault; empty list on any failure. */
export async function searchNativeSessions(cwd: string, query: string, deps: NativeSessionReaderDeps = {}): Promise<SessionMeta[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const env = deps.env ?? process.env;
	const databasePath = resolveOpencodeDatabasePath(env, deps.fs);
	if (!databasePath) return [];
	const format = await resolveNativeReadFormat(databasePath, deps);
	if (!format) return [];

	let rows: SqliteRow[];
	try {
		const sql = format === 'v2' ? buildNativeSessionSearchSqlV2(cwd, trimmed) : buildNativeSessionSearchSql(cwd, trimmed);
		rows = await querySqliteJson(databasePath, sql, deps.sqlite);
	} catch (error) {
		console.warn('[co-ober] native session search unavailable:', error);
		return [];
	}

	const sessions: SessionMeta[] = [];
	for (const row of rows) {
		const sessionId = typeof row.id === 'string' ? row.id : '';
		if (!sessionId) continue;
		const meta: SessionMeta = {
			sessionId,
			title: typeof row.title === 'string' && row.title.trim() ? row.title : sessionId,
			cwd: typeof row.directory === 'string' ? row.directory : undefined,
			updatedAt: toIsoString(row.time_updated),
		};
		if (typeof row.snippet === 'string' && row.snippet.trim()) meta.snippet = row.snippet.trim();
		sessions.push(meta);
	}
	return sessions;
}