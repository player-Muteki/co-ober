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

function toNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toOptionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Resolve the OpenCode database and run a read-only query; undefined on any failure. */
async function readNativeRows(sql: string, deps: NativeSessionReaderDeps, context: string): Promise<SqliteRow[] | undefined> {
	const env = deps.env ?? process.env;
	const databasePath = resolveOpencodeDatabasePath(env, deps.fs);
	if (!databasePath) return undefined;
	try {
		return await querySqliteJson(databasePath, sql, deps.sqlite);
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

	let rows: SqliteRow[];
	try {
		rows = await querySqliteJson(databasePath, buildSessionUsageSql(sessionId), deps.sqlite);
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
	const rows = await readNativeRows(buildSessionTodosSql(sessionId), deps, 'native session todos');
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

/** Per-message cost/token stats for a session; empty list on any failure. */
export async function readNativeMessageStats(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<NativeMessageStat[]> {
	if (!sessionId) return [];
	const rows = await readNativeRows(buildMessageStatsSql(sessionId), deps, 'native message stats');
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

/** Map of OpenCode tool callID -> error message for one session; empty map on any failure. */
export async function readNativeToolErrors(sessionId: string, deps: NativeSessionReaderDeps = {}): Promise<Record<string, string>> {
	if (!sessionId) return {};
	const rows = await readNativeRows(buildToolErrorsSql(sessionId), deps, 'native tool errors');
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

	let rows: SqliteRow[];
	try {
		rows = await querySqliteJson(databasePath, buildNativeSessionsSql(cwd), deps.sqlite);
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

	let rows: SqliteRow[];
	try {
		rows = await querySqliteJson(databasePath, buildNativeSessionSearchSql(cwd, trimmed), deps.sqlite);
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