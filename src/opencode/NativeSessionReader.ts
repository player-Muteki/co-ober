import type { SessionMeta } from '../types';
import { resolveOpencodeDatabasePath, type PathFs } from './OpencodePaths';
import { querySqliteJson, type SqliteReaderDeps, type SqliteRow } from './SqliteReader';

export const NATIVE_SESSION_LIMIT = 50;

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
		'select id, title, directory, time_updated from session',
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
		sessions.push({
			sessionId,
			title: typeof row.title === 'string' && row.title.trim() ? row.title : sessionId,
			cwd: typeof row.directory === 'string' ? row.directory : undefined,
			updatedAt: toIsoString(row.time_updated),
		});
	}
	return sessions;
}