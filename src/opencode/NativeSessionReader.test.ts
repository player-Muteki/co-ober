import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	escapeSqlLiteral,
	escapeLikePattern,
	buildNativeSessionsSql,
	buildNativeSessionsSqlV2,
	listNativeSessions,
	buildSessionUsageSql,
	buildSessionUsageSqlV2,
	readNativeSessionUsage,
	buildSessionTodosSql,
	readNativeSessionTodos,
	buildMessageStatsSql,
	buildMessageStatsSqlV2,
	readNativeMessageStats,
	buildToolErrorsSql,
	buildToolErrorsSqlV2,
	readNativeToolErrors,
	buildNativeSessionSearchSql,
	buildNativeSessionSearchSqlV2,
	searchNativeSessions,
	buildTurnStatsSql,
	buildTurnStatsSqlV2,
	computeNativeTurnStats,
	readNativeTurnStats,
	probeNativeSchema,
	resetNativeSchemaProbe,
} from './NativeSessionReader';

const dbPath = '/home/u/.local/share/opencode/opencode.db';
const fakeFs = {
	existsSync: (p: string) => p === dbPath,
	readdirSync: (): string[] => ['opencode.db'],
};

const V1_PROBE_ROW = { session_table: 1, session_columns: 6, v2_tables: 0 };
const FORK_CLEAN_ROW = { migrated: 0, v2_rows: 0 };

/** Read helper that answers the schema probe with v1 shapes (or a custom row). */
function sqliteBacked(rows: unknown[], probeRow: unknown = V1_PROBE_ROW) {
	return {
		requireSqliteModule: () => ({
			DatabaseSync: class {
				constructor() {}
				close() {}
				prepare(sql: string) {
					return {
						all: () =>
							sql.includes('sqlite_master')
								? [probeRow]
								: sql.includes('data_migration')
									? [FORK_CLEAN_ROW]
									: rows,
					};
				}
			},
		}),
	};
}

beforeEach(() => {
	resetNativeSchemaProbe();
});

describe('NativeSessionReader SQL building', () => {
	it('doubles embedded quotes', () => {
		expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
	});

	it('rejects control characters', () => {
		expect(() => escapeSqlLiteral('bad' + String.fromCharCode(0) + 'value')).toThrow(/control character/);
	});

	it('escapes LIKE metacharacters', () => {
		expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
	});

	it('builds a directory-scoped query', () => {
		const sql = buildNativeSessionsSql('/vault/proj');
		expect(sql).toContain("directory = '/vault/proj'");
		expect(sql).toContain("directory like '/vault/proj/%'");
		expect(sql).toContain('parent_id is null');
		expect(sql).toContain('time_archived is null');
		expect(sql).toContain('order by time_updated desc');
		expect(sql).toContain('limit 50');
	});

	it('escapes quotes in the directory literal', () => {
		const sql = buildNativeSessionsSql("/vault/it's");
		expect(sql).toContain("directory = '/vault/it''s'");
	});

	it('clamps the limit', () => {
		expect(buildNativeSessionsSql('/v', 9999)).toContain('limit 500');
		expect(buildNativeSessionsSql('/v', -5)).toContain('limit 1');
	});
});

describe('listNativeSessions', () => {
	it('maps rows to session metadata', async () => {
		const rows = [
			{ id: 'ses_a', title: 'Alpha', directory: '/vault', time_updated: 1787369997497 },
			{ id: 'ses_b', title: '  ', directory: '/vault', time_updated: 1787369997498 },
			{ id: '', title: 'ignored', directory: '/vault', time_updated: 0 },
		];
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked(rows) as never,
		});
		expect(sessions.length).toBe(2);
		expect(sessions[0]).toEqual({
			sessionId: 'ses_a',
			title: 'Alpha',
			cwd: '/vault',
			updatedAt: new Date(1787369997497).toISOString(),
		});
		expect(sessions[1].title).toBe('ses_b');
	});

	it('returns empty list when the database is missing', async () => {
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: { existsSync: () => false, readdirSync: () => [] },
		});
		expect(sessions).toEqual([]);
	});

	it('degrades to empty list when all SQLite backends fail', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: {
				requireSqliteModule: () => null,
				spawn: () => {
					throw new Error('no spawn');
				},
				execPath: '',
				env: {},
			} as never,
		});
		expect(sessions).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('readNativeSessionUsage', () => {
	it('builds a session-scoped usage query with context subselect', () => {
		const sql = buildSessionUsageSql("ses_it's");
		expect(sql).toContain("from session s where s.id = 'ses_it''s'");
		expect(sql).toContain('s.cost');
		expect(sql).toContain("json_extract(m.data, '$.tokens.total')");
		expect(sql).toContain("json_extract(m.data, '$.role') = 'assistant'");
		expect(sql).toContain('order by m.time_created desc limit 1');
	});

	it('maps the session row to usage totals', async () => {
		const usage = await readNativeSessionUsage('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([{
				cost: 0.42,
				tokens_input: 1000,
				tokens_output: 200,
				tokens_reasoning: 50,
				tokens_cache_read: 9000,
				tokens_cache_write: 0,
				context_tokens: 32770,
			}]) as never,
		});
		expect(usage).toEqual({
			cost: 0.42,
			inputTokens: 1000,
			outputTokens: 200,
			reasoningTokens: 50,
			cacheReadTokens: 9000,
			cacheWriteTokens: 0,
			contextTokens: 32770,
		});
	});

	it('omits contextTokens when the session has no assistant message', async () => {
		const usage = await readNativeSessionUsage('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([{
				cost: 0,
				tokens_input: 1,
				tokens_output: 2,
				tokens_reasoning: 0,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				context_tokens: null,
			}]) as never,
		});
		expect(usage?.contextTokens).toBeUndefined();
		expect(usage?.outputTokens).toBe(2);
	});

	it('returns undefined when the session row is missing', async () => {
		const usage = await readNativeSessionUsage('ses_missing', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([]) as never,
		});
		expect(usage).toBeUndefined();
	});

	it('degrades to undefined when the database is unavailable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const usage = await readNativeSessionUsage('ses_a', {
			env: { HOME: '/home/u' },
			fs: { existsSync: () => false, readdirSync: () => [] },
		});
		expect(usage).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
describe('session summary columns', () => {
	it('selects the summary columns in the listing query', () => {
		const sql = buildNativeSessionsSql('/vault');
		expect(sql).toContain('summary_additions');
		expect(sql).toContain('summary_deletions');
		expect(sql).toContain('summary_files');
	});

	it('maps summary counts onto session metadata', async () => {
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([
				{ id: 'ses_a', title: 'Alpha', directory: '/vault', time_updated: 1, summary_additions: 12, summary_deletions: 3, summary_files: 4 },
				{ id: 'ses_b', title: 'Beta', directory: '/vault', time_updated: 2 },
			]) as never,
		});
		expect(sessions[0]).toMatchObject({ additions: 12, deletions: 3, files: 4 });
		expect(sessions[1]).not.toHaveProperty('additions');
		expect(sessions[1]).not.toHaveProperty('files');
	});
});

describe('native agent and model columns', () => {
	it('selects agent and model only in the v1 listing query', () => {
		const sql = buildNativeSessionsSql('/vault');
		expect(sql).toMatch(/,\s*agent,\s*model\s+from session/);
		expect(buildNativeSessionsSqlV2('/vault')).not.toMatch(/\bagent\b/);
		expect(buildNativeSessionsSqlV2('/vault')).not.toMatch(/\bmodel\b/);
	});

	it('maps agent and model onto session metadata when present', async () => {
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([
				{ id: 'ses_a', title: 'Alpha', directory: '/vault', time_updated: 1, agent: 'build', model: 'claude-sonnet' },
				{ id: 'ses_b', title: 'Beta', directory: '/vault', time_updated: 2, agent: '', model: null },
			]) as never,
		});
		expect(sessions[0]).toMatchObject({ agent: 'build', model: 'claude-sonnet' });
		expect(sessions[1]).not.toHaveProperty('agent');
		expect(sessions[1]).not.toHaveProperty('model');
	});
});

describe('readNativeSessionTodos', () => {
	it('builds a position-ordered todo query', () => {
		const sql = buildSessionTodosSql("ses_it's");
		expect(sql).toContain("from todo where session_id = 'ses_it''s'");
		expect(sql).toContain('order by position asc');
		expect(sql).toContain('select content, status, priority');
	});

	it('maps todo rows in order', async () => {
		const todos = await readNativeSessionTodos('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([
				{ content: 'first', status: 'completed', priority: 'high' },
				{ content: 'second', status: 'in_progress', priority: null },
				{ content: 42, status: 'pending', priority: null },
			]) as never,
		});
		expect(todos).toEqual([
			{ content: 'first', status: 'completed', priority: 'high' },
			{ content: 'second', status: 'in_progress' },
		]);
	});

	it('degrades to an empty list when unavailable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const todos = await readNativeSessionTodos('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: { requireSqliteModule: () => null, spawn: () => { throw new Error('nope'); }, execPath: '', env: {} } as never,
		});
		expect(todos).toEqual([]);
		warn.mockRestore();
	});

	it('returns empty without a session id', async () => {
		expect(await readNativeSessionTodos('')).toEqual([]);
	});
});

describe('readNativeMessageStats', () => {
	it('builds a per-assistant-message aggregate query', () => {
		const sql = buildMessageStatsSql('ses_a');
		expect(sql).toContain("json_extract(p.data, '$.type') = 'step-finish'");
		expect(sql).toContain("json_extract(m.data, '$.role') = 'assistant'");
		expect(sql).toContain("p.session_id = 'ses_a'");
		expect(sql).toContain('group by m.id');
		expect(sql).toContain('order by m.time_created asc');
	});

	it('maps stat rows', async () => {
		const stats = await readNativeMessageStats('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([
				{ message_id: 'msg_1', cost: 0.5, input_tokens: 100, output_tokens: 10, total_tokens: 110 },
				{ message_id: 'bad', cost: null, input_tokens: null, output_tokens: null, total_tokens: null },
			]) as never,
		});
		expect(stats).toEqual([
			{ messageId: 'msg_1', cost: 0.5, inputTokens: 100, outputTokens: 10, totalTokens: 110 },
			{ messageId: 'bad', cost: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		]);
	});

	it('degrades to an empty list when the database is missing', async () => {
		expect(await readNativeMessageStats('ses_a', { env: { HOME: '/home/u' }, fs: { existsSync: () => false, readdirSync: () => [] } })).toEqual([]);
	});
});

describe('readNativeToolErrors', () => {
	it('builds an errored-tool-part query', () => {
		const sql = buildToolErrorsSql("ses_it's");
		expect(sql).toContain("session_id = 'ses_it''s'");
		expect(sql).toContain("json_extract(data, '$.type') = 'tool'");
		expect(sql).toContain("json_extract(data, '$.state.error') is not null");
	});

	it('maps call ids to error messages', async () => {
		const errors = await readNativeToolErrors('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked([
				{ call_id: 'call_1', error: 'boom' },
				{ call_id: 'call_2', error: null },
				{ call_id: null, error: 'orphan' },
			]) as never,
		});
		expect(errors).toEqual({ call_1: 'boom' });
	});

	it('degrades to an empty map on failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errors = await readNativeToolErrors('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: { requireSqliteModule: () => null, spawn: () => { throw new Error('nope'); }, execPath: '', env: {} } as never,
		});
		expect(errors).toEqual({});
		warn.mockRestore();
	});
});

describe('native session content search', () => {
	it('builds a scoped query with escaped title and text filters', () => {
		const sql = buildNativeSessionSearchSql('/vault', "O'br%x");
		expect(sql).toContain("directory = '/vault'");
		expect(sql).toContain("s.title like '%O''br\\%x%' escape");
		expect(sql).toContain("json_extract(p.data, '$.type') = 'text'");
		expect(sql).toContain("json_extract(p.data, '$.text') like");
		expect(sql).toContain('parent_id is null');
		expect(sql).toContain('time_archived is null');
		expect(sql).toContain('as snippet');
		expect(sql).toContain('order by s.time_updated desc');
		expect(sql).toContain('limit 20');
	});

	it('clamps the search limit', () => {
		expect(buildNativeSessionSearchSql('/v', 'q', 9999)).toContain('limit 200');
		expect(buildNativeSessionSearchSql('/v', 'q', 0)).toContain('limit 20');
		expect(buildNativeSessionSearchSql('/v', 'q', -3)).toContain('limit 1');
	});

	it('maps rows to session metadata with trimmed snippets', async () => {
		const rows = [
			{ id: 'ses_a', title: 'Alpha', directory: '/vault', time_updated: 1787369997497, snippet: '  around the term  ' },
			{ id: 'ses_b', title: '  ', directory: '/vault', time_updated: 0, snippet: '' },
			{ id: '', title: 'ignored', directory: '/vault', time_updated: 0 },
		];
		const sessions = await searchNativeSessions('/vault', 'the term', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked(rows) as never,
		});
		expect(sessions.length).toBe(2);
		expect(sessions[0]).toEqual({
			sessionId: 'ses_a',
			title: 'Alpha',
			cwd: '/vault',
			updatedAt: new Date(1787369997497).toISOString(),
			snippet: 'around the term',
		});
		expect(sessions[1].title).toBe('ses_b');
		expect(sessions[1].snippet).toBeUndefined();
	});

	it('returns an empty list for a blank query without touching SQLite', async () => {
		const sessions = await searchNativeSessions('/vault', '   ', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: {
				requireSqliteModule: () => {
					throw new Error('must not read');
				},
			} as never,
		});
		expect(sessions).toEqual([]);
	});

	it('degrades to an empty list when the query fails', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sessions = await searchNativeSessions('/vault', 'term', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: { requireSqliteModule: () => null, spawn: () => { throw new Error('nope'); }, execPath: '', env: {} } as never,
		});
		expect(sessions).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('v2 (forked database) SQL builders', () => {
	it('lists sessions with event-fresh timestamps', () => {
		const sql = buildNativeSessionsSqlV2("/vault/it's");
		expect(sql).toContain("s.directory = '/vault/it''s'");
		expect(sql).toContain('session_message sm0');
		expect(sql).toContain('s.parent_id is null');
		expect(sql).toContain('s.time_archived is null');
		expect(sql).toContain('order by time_updated desc');
		expect(sql).toContain('limit 50');
	});

	it('clamps the v2 listing limit', () => {
		expect(buildNativeSessionsSqlV2('/v', 9999)).toContain('limit 500');
		expect(buildNativeSessionsSqlV2('/v', -5)).toContain('limit 1');
	});

	it('searches user text and assistant content parts with a snippet', () => {
		const sql = buildNativeSessionSearchSqlV2('/vault', "O'br%x");
		expect(sql).toContain("sm.type = 'user'");
		expect(sql).toContain("json_extract(sm.data, '$.text') like '%O''br\\%x%' escape");
		expect(sql).toContain("json_each(sm.data, '$.content')");
		expect(sql).toContain("json_extract(j.value, '$.type') = 'text'");
		expect(sql).toContain('as snippet');
		expect(sql).toContain('json_valid');
		expect(sql).toContain('union all');
		expect(sql).toContain('limit 20');
	});

	it('aggregates usage from event rows without touching stale message tables', () => {
		const sql = buildSessionUsageSqlV2("ses_it's");
		expect(sql).toContain("sm.session_id = 'ses_it''s'");
		expect(sql).toContain("json_extract(j.value, '$.cost')");
		expect(sql).toContain("json_extract(sm.data, '$.tokens.input')");
		expect(sql).toContain("json_extract(sm.data, '$.tokens.cache.read')");
		expect(sql).toContain('order by sm.seq desc limit 1');
		expect(sql).not.toContain('from message m');
		expect(sql).not.toContain('from session s');
	});

	it('orders message stats by seq', () => {
		const sql = buildMessageStatsSqlV2('ses_a');
		expect(sql).toContain("sm.type = 'assistant'");
		expect(sql).toContain("json_extract(j.value, '$.type') = 'step-finish'");
		expect(sql).toContain('order by sm.seq asc');
	});

	it('reads tool errors from inlined content parts', () => {
		const sql = buildToolErrorsSqlV2('ses_a');
		expect(sql).toContain('json_each(sm.data');
		expect(sql).toContain("json_extract(j.value, '$.type') = 'tool'");
		expect(sql).toContain("json_extract(j.value, '$.state.error') is not null");
	});
});

describe('native turn stats', () => {
	it('builds a chronological v1 turn-evidence query', () => {
		const sql = buildTurnStatsSql("ses_it's");
		expect(sql).toContain('from message m');
		expect(sql).toContain("m.session_id = 'ses_it''s'");
		expect(sql).toContain("json_extract(m.data, '$.role') in ('user', 'assistant')");
		expect(sql).toContain("coalesce(cast(json_extract(m.data, '$.time.created') as integer), m.time_created) as started_at");
		expect(sql).toContain('order by m.time_created asc, m.id asc');
	});

	it('builds a seq-ordered v2 turn-evidence query over session_message', () => {
		const sql = buildTurnStatsSqlV2('ses_a');
		expect(sql).toContain('from session_message sm');
		expect(sql).toContain("sm.type in ('user', 'assistant')");
		expect(sql).toContain('json_valid');
		expect(sql).toContain('order by sm.seq asc');
	});

	it('accumulates turn tokens and emits only on a clean finish', () => {
		const stats = computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 1000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', parentId: 'u1', outputTokens: 10, reasoningTokens: 2, finish: 'tool-calls', hasError: false },
			{ messageId: 'a2', role: 'assistant', parentId: 'u1', outputTokens: 20, reasoningTokens: 5, completedAt: 7000, finish: 'stop', hasError: false },
		]);
		expect(stats).toEqual([{ messageId: 'a2', outputTokens: 37, durationMs: 6000 }]);
	});

	it('emits once per user turn and restarts accumulation on the next', () => {
		const stats = computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 1000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', outputTokens: 4, reasoningTokens: 0, completedAt: 3000, finish: 'stop', hasError: false },
			{ messageId: 'u2', role: 'user', startedAt: 4000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a2', role: 'assistant', outputTokens: 6, reasoningTokens: 1, completedAt: 6000, finish: 'length', hasError: false },
		]);
		expect(stats).toEqual([
			{ messageId: 'a1', outputTokens: 4, durationMs: 2000 },
			{ messageId: 'a2', outputTokens: 7, durationMs: 2000 },
		]);
	});

	it('invalidates the turn on errors or mismatched v1 parents', () => {
		expect(computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 1000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', outputTokens: 5, reasoningTokens: 0, completedAt: 2000, finish: 'stop', hasError: true },
		])).toEqual([]);
		expect(computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 1000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', parentId: 'u_other', outputTokens: 5, reasoningTokens: 0, completedAt: 2000, finish: 'stop', hasError: false },
		])).toEqual([]);
	});

	it('requires positive tokens and a positive measured duration', () => {
		expect(computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 1000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', outputTokens: 0, reasoningTokens: 0, completedAt: 5000, finish: 'stop', hasError: false },
		])).toEqual([]);
		expect(computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 5000, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', outputTokens: 9, reasoningTokens: 0, completedAt: 5000, finish: 'stop', hasError: false },
		])).toEqual([]);
	});

	it('ignores assistants that precede any user row and keeps accumulating without a close', () => {
		expect(computeNativeTurnStats([
			{ messageId: 'a0', role: 'assistant', outputTokens: 9, reasoningTokens: 0, completedAt: 100, finish: 'stop', hasError: false },
		])).toEqual([]);
		expect(computeNativeTurnStats([
			{ messageId: 'u1', role: 'user', startedAt: 0, outputTokens: 0, reasoningTokens: 0, hasError: false },
			{ messageId: 'a1', role: 'assistant', outputTokens: 3, reasoningTokens: 0, finish: 'stop', hasError: false },
			{ messageId: 'a2', role: 'assistant', outputTokens: 4, reasoningTokens: 0, completedAt: 2000, finish: 'stop', hasError: false },
		])).toEqual([{ messageId: 'a2', outputTokens: 7, durationMs: 2000 }]);
	});

	it('maps raw rows through the reader and degrades on blank ids', async () => {
		const rows = [
			{ message_id: 'u1', role: 'user', parent_id: null, started_at: 1000, completed_at: null, finish: null, error: null, output_tokens: 0, reasoning_tokens: 0 },
			{ message_id: 'a1', role: 'assistant', parent_id: 'u1', started_at: 1100, completed_at: 3000, finish: 'stop', error: null, output_tokens: 30, reasoning_tokens: 10 },
			{ message_id: '', role: 'assistant', parent_id: null, started_at: null, completed_at: null, finish: null, error: null, output_tokens: 0, reasoning_tokens: 0 },
			{ message_id: 'a2', role: 'session.updated', parent_id: null, started_at: null, completed_at: null, finish: null, error: null, output_tokens: 0, reasoning_tokens: 0 },
		];
		const stats = await readNativeTurnStats('ses_a', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: sqliteBacked(rows) as never,
		});
		expect(stats).toEqual([{ messageId: 'a1', outputTokens: 40, durationMs: 2000 }]);
		expect(await readNativeTurnStats('')).toEqual([]);
	});
});

describe('v2 SQL against a real SQLite engine', () => {
	let db: { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): void } } | null = null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const sqlite = require('node:sqlite') as {
			DatabaseSync: new (path: string) => {
				prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): void };
			};
		};
		const real = new sqlite.DatabaseSync(':memory:');
		const exec = (sql: string) => real.prepare(sql).run();
		exec(
			'create table session (id text primary key, parent_id text, directory text, title text, time_archived integer, time_updated integer, summary_additions integer, summary_deletions integer, summary_files integer)',
		);
		exec(
			'create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)',
		);
		exec("insert into session values ('ses_a', null, '/vault', 'Alpha', null, 100, 1, 0, 1)");
		exec(
			'insert into session_message values ' +
				"('m_user', 'ses_a', 'user', 1, 200, 200, '{\"text\":\"hello needle here\"}'), " +
				"('m_ctrl', 'ses_a', 'session.updated', 2, 300, 300, '{}'), " +
				"('m_asst', 'ses_a', 'assistant', 3, 400, 400, " +
					"'{\"time\":{\"created\":400,\"completed\":6400},\"finish\":\"stop\"," +
					"\"tokens\":{\"input\":10,\"output\":5,\"reasoning\":2,\"total\":17,\"cache\":{\"read\":90,\"write\":3}}," +
					"\"content\":[{\"type\":\"step-finish\",\"cost\":0.5,\"tokens\":{\"input\":10,\"output\":5,\"total\":15}}," +
					"{\"type\":\"text\",\"text\":\"reply about needle here\"}," +
					"{\"type\":\"tool\",\"callID\":\"call_1\",\"state\":{\"error\":\"boom\"}}]}')",
		);
		db = real;
	} catch {
		db = null; // runtime without node:sqlite: skip this suite
	}
	const maybe = db ? describe : describe.skip;

	maybe('executes every v2 builder without error', () => {
		const queries: Array<[string, () => string]> = [
			['listing', () => buildNativeSessionsSqlV2('/vault')],
			['search', () => buildNativeSessionSearchSqlV2('/vault', 'needle')],
			['usage', () => buildSessionUsageSqlV2('ses_a')],
			['stats', () => buildMessageStatsSqlV2('ses_a')],
			['errors', () => buildToolErrorsSqlV2('ses_a')],
			['turn stats', () => buildTurnStatsSqlV2('ses_a')],
		];
		it.each(queries)('%s', (_name, build) => {
			expect(() => db!.prepare(build()).all()).not.toThrow();
		});

		it('returns fork-correct results', () => {
			const listed = db!.prepare(buildNativeSessionsSqlV2('/vault')).all();
			expect(listed[0]).toMatchObject({ id: 'ses_a', title: 'Alpha', time_updated: 400, summary_additions: 1 });

			const found = db!.prepare(buildNativeSessionSearchSqlV2('/vault', 'needle')).all();
			expect(found).toHaveLength(1);
			expect(String(found[0].snippet)).toContain('needle');
			expect(db!.prepare(buildNativeSessionSearchSqlV2('/vault', 'zzz-absent')).all()).toHaveLength(0);

			const usage = db!.prepare(buildSessionUsageSqlV2('ses_a')).all()[0];
			expect(usage).toMatchObject({
				cost: 0.5, tokens_input: 10, tokens_output: 5, tokens_reasoning: 2,
				tokens_cache_read: 90, tokens_cache_write: 3, context_tokens: 17,
			});

			const stats = db!.prepare(buildMessageStatsSqlV2('ses_a')).all();
			expect(stats).toEqual([{ message_id: 'm_asst', cost: 0.5, input_tokens: 10, output_tokens: 5, total_tokens: 17 }]);

			const errors = db!.prepare(buildToolErrorsSqlV2('ses_a')).all();
			expect(errors).toEqual([{ call_id: 'call_1', error: 'boom' }]);

			const turnRows = db!.prepare(buildTurnStatsSqlV2('ses_a')).all();
			expect(turnRows.map((r) => r.role)).toEqual(['user', 'assistant']);
			const turnStats = computeNativeTurnStats(turnRows.map((r) => ({
				messageId: String(r.message_id),
				role: r.role as 'user' | 'assistant',
				startedAt: typeof r.started_at === 'number' ? r.started_at : undefined,
				completedAt: typeof r.completed_at === 'number' ? r.completed_at : undefined,
				finish: typeof r.finish === 'string' ? r.finish : undefined,
				hasError: r.error !== null && r.error !== undefined,
				outputTokens: typeof r.output_tokens === 'number' ? r.output_tokens : 0,
				reasoningTokens: typeof r.reasoning_tokens === 'number' ? r.reasoning_tokens : 0,
			})));
			expect(turnStats).toEqual([{ messageId: 'm_asst', outputTokens: 7, durationMs: 6200 }]);
		});
	});
});

describe('native schema probe (v2 defense)', () => {
	function recordingSqlite(probeRow: unknown, forkRow: unknown = FORK_CLEAN_ROW, contentRows: unknown[] = []) {
		const seen: string[] = [];
		return {
			seen,
			deps: {
				requireSqliteModule: () => ({
					DatabaseSync: class {
						constructor() {}
						close() {}
						prepare(sql: string) {
							seen.push(sql);
							if (sql.includes('sqlite_master')) return { all: () => [probeRow] };
							if (sql.includes('data_migration')) return { all: () => [forkRow] };
							return { all: () => contentRows };
						}
					},
				}),
			},
		} as const;
	}

	it('degrades every native read on an incompatible schema without running v1 queries', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { seen, deps } = recordingSqlite({ session_table: 1, session_columns: 2 });
		const base = { env: { HOME: '/home/u' }, fs: fakeFs };
		expect(await listNativeSessions('/vault', { ...base, sqlite: deps as never })).toEqual([]);
		expect(await searchNativeSessions('/vault', 'term', { ...base, sqlite: deps as never })).toEqual([]);
		expect(await readNativeSessionUsage('ses_a', { ...base, sqlite: deps as never })).toBeUndefined();
		expect(await readNativeSessionTodos('ses_a', { ...base, sqlite: deps as never })).toEqual([]);
		expect(seen.every((sql) => sql.includes('sqlite_master'))).toBe(true);
		const v2Warnings = warn.mock.calls.filter((args) => String(args[0]).includes('does not match the v1 schema'));
		expect(v2Warnings.length).toBe(1);
		warn.mockRestore();
	});

	it('classifies an unreadable probe as unknown and still degrades gracefully', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const sessions = await listNativeSessions('/vault', {
			env: { HOME: '/home/u' },
			fs: fakeFs,
			sqlite: { requireSqliteModule: () => null, spawn: () => { throw new Error('nope'); }, execPath: '', env: {} } as never,
		});
		expect(sessions).toEqual([]);
		expect(warn).toHaveBeenCalled();
		expect(await probeNativeSchema(dbPath, { sqlite: { requireSqliteModule: () => null, spawn: () => { throw new Error('nope'); }, execPath: '', env: {} } as never })).toBe('unknown');
		warn.mockRestore();
	});

	it('accepts v1 databases that carry extra unknown tables', async () => {
		const { deps } = recordingSqlite(V1_PROBE_ROW);
		expect(await probeNativeSchema(dbPath, { sqlite: deps as never })).toBe('v1');
	});

	it('skips the fork count entirely when no v2 tables exist', async () => {
		const { seen, deps } = recordingSqlite(V1_PROBE_ROW);
		expect(await probeNativeSchema(dbPath, { sqlite: deps as never })).toBe('v1');
		expect(seen.filter((sql) => !sql.includes('sqlite_master'))).toEqual([]);
	});

	it('keeps v1 readable when v2 scaffold tables exist but hold no data', async () => {
		const { deps } = recordingSqlite({ session_table: 1, session_columns: 6, v2_tables: 1 }, { migrated: 0, v2_rows: 0 });
		expect(await probeNativeSchema(dbPath, { sqlite: deps as never })).toBe('v1');
	});

	it('classifies a migrated database as forked, warns once, and reads content via v2 tables', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { seen, deps } = recordingSqlite(
			{ session_table: 1, session_columns: 6, v2_tables: 3 },
			{ migrated: 12, v2_rows: 0 },
			[{ id: 'ses_a', title: 'Alpha', directory: '/vault', time_updated: 123 }],
		);
		const base = { env: { HOME: '/home/u' }, fs: fakeFs };
		expect(await probeNativeSchema(dbPath, { sqlite: deps as never })).toBe('forked');
		const sessions = await listNativeSessions('/vault', { ...base, sqlite: deps as never });
		expect(sessions).toEqual([
			{ sessionId: 'ses_a', title: 'Alpha', cwd: '/vault', updatedAt: new Date(123).toISOString() },
		]);
		await readNativeSessionUsage('ses_a', { ...base, sqlite: deps as never });
		await readNativeMessageStats('ses_a', { ...base, sqlite: deps as never });
		await readNativeToolErrors('ses_a', { ...base, sqlite: deps as never });
		const contentQueries = seen.filter((sql) => !sql.includes('sqlite_master') && !sql.includes('data_migration'));
		expect(contentQueries.length).toBeGreaterThanOrEqual(4);
		expect(contentQueries.every((sql) => sql.includes('session_message'))).toBe(true);
		const forkWarnings = warn.mock.calls.filter((args) => String(args[0]).includes('v2 storage layout'));
		expect(forkWarnings.length).toBe(1);
		warn.mockRestore();
	});

	it('treats an unreadable v2 table count as forked rather than trusting a stale mirror', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const deps = {
			requireSqliteModule: () => ({
				DatabaseSync: class {
					constructor() {}
					close() {}
					prepare(sql: string) {
						if (sql.includes('sqlite_master')) {
							return { all: () => [{ session_table: 1, session_columns: 6, v2_tables: 2 }] };
						}
						return { all: () => { throw new Error('table is corrupt'); } };
					}
				},
			}),
			spawn: () => { throw new Error('nope'); },
			execPath: '',
			env: {},
		};
		expect(await probeNativeSchema(dbPath, { sqlite: deps as never })).toBe('forked');
		warn.mockRestore();
	});
});
