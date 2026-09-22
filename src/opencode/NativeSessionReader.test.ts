import { describe, expect, it, vi } from 'vitest';
import {
	escapeSqlLiteral,
	escapeLikePattern,
	buildNativeSessionsSql,
	listNativeSessions,
	buildSessionUsageSql,
	readNativeSessionUsage,
	buildSessionTodosSql,
	readNativeSessionTodos,
	buildMessageStatsSql,
	readNativeMessageStats,
	buildToolErrorsSql,
	readNativeToolErrors,
} from './NativeSessionReader';

const dbPath = '/home/u/.local/share/opencode/opencode.db';
const fakeFs = {
	existsSync: (p: string) => p === dbPath,
	readdirSync: (): string[] => ['opencode.db'],
};

function sqliteBacked(rows: unknown[]) {
	return {
		requireSqliteModule: () => ({
			DatabaseSync: class {
				constructor() {}
				close() {}
				prepare() {
					return { all: () => rows };
				}
			},
		}),
	};
}

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
