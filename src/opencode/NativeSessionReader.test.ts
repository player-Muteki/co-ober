import { describe, expect, it, vi } from 'vitest';
import { escapeSqlLiteral, escapeLikePattern, buildNativeSessionsSql, listNativeSessions } from './NativeSessionReader';

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