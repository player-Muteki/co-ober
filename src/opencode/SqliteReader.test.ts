import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { querySqliteJson } from './SqliteReader';

function fakeChild(stdoutData: string, exitCode = 0) {
	const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	setImmediate(() => {
		child.stdout.end(stdoutData);
		child.stderr.end('');
		setImmediate(() => child.emit('close', exitCode));
	});
	return child;
}

describe('querySqliteJson', () => {
	it('uses in-process node:sqlite when available', async () => {
		const calls: { ctor: unknown[]; prepareSql: string[]; closed: number } = { ctor: [], prepareSql: [], closed: 0 };
		const DatabaseSync = class {
			constructor(...args: unknown[]) {
				calls.ctor.push(args);
			}
			close() {
				calls.closed += 1;
			}
			prepare(sql: string) {
				calls.prepareSql.push(sql);
				return { all: () => [{ id: 1 }] };
			}
		};
		const rows = await querySqliteJson('/db.sqlite', 'select 1', {
			requireSqliteModule: () => ({ DatabaseSync } as never),
		});
		expect(rows).toEqual([{ id: 1 }]);
		expect(calls.prepareSql).toEqual(['select 1']);
		expect(calls.closed).toBe(1);
		expect(calls.ctor[0]).toEqual(['/db.sqlite', { readOnly: true }]);
	});

	it('falls back to a spawned node child when in-process sqlite is unavailable', async () => {
		const spawn = vi.fn().mockImplementation(() => fakeChild('[{"id":2}]'));
		const rows = await querySqliteJson('/db.sqlite', 'select 2', {
			requireSqliteModule: () => {
				throw new Error('unavailable');
			},
			spawn: spawn as never,
			execPath: '/bin/other',
			env: { PATH: '/usr/bin' },
			platform: 'linux',
		});
		expect(rows).toEqual([{ id: 2 }]);
		const commands = spawn.mock.calls.map((call) => call[0]);
		expect(commands).toContain('/bin/other');
	});

	it('falls back to the sqlite3 CLI when no node executable works', async () => {
		// The spawn layer may resolve `sqlite3` to a full path when the CLI is
		// installed, so match on the basename to stay machine-independent.
		const isSqlite3 = (command: unknown) => String(command).split(/[\\/]/).pop() === 'sqlite3';
		const spawn = vi.fn().mockImplementation((command: string) => {
			if (isSqlite3(command)) return fakeChild('[{"id":3}]');
			return fakeChild('', 1);
		});
		const rows = await querySqliteJson('/db.sqlite', 'select 3', {
			requireSqliteModule: () => null,
			spawn: spawn as never,
			execPath: '/bin/node',
			env: {},
			platform: 'linux',
		});
		expect(rows).toEqual([{ id: 3 }]);
		const sqliteCall = spawn.mock.calls.find((call) => isSqlite3(call[0]));
		expect(sqliteCall?.[1]).toEqual(['-json', '/db.sqlite', 'select 3']);
	});

	it('rejects with aggregated errors when every backend fails', async () => {
		const spawn = vi.fn().mockImplementation(() => fakeChild('', 1));
		await expect(
			querySqliteJson('/db.sqlite', 'select 4', {
				requireSqliteModule: () => null,
				spawn: spawn as never,
				execPath: '',
				env: {},
				platform: 'linux',
			}),
		).rejects.toThrow(/Unable to read OpenCode database/);
	});
});