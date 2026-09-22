import { describe, expect, it, vi } from 'vitest';
import { escapeSqlLiteral, escapeLikePattern, buildNativeSessionsSql, listNativeSessions, buildSessionUsageSql, readNativeSessionUsage } from './NativeSessionReader';

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