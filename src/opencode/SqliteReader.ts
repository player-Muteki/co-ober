import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';

export interface SqliteRow {
	[key: string]: unknown;
}

interface SqliteModule {
	DatabaseSync: new (location: string, options: { readOnly: boolean }) => {
		close(): void;
		prepare(sql: string): { all(...params: unknown[]): SqliteRow[] };
	};
}

export interface SqliteReaderDeps {
	env?: NodeJS.ProcessEnv;
	requireSqliteModule?: () => SqliteModule | null;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	execPath?: string;
	platform?: NodeJS.Platform;
	maxBufferBytes?: number;
}

const SQLITE_QUERY_TIMEOUT_MS = 10000;

const CHILD_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const [databasePath, sql] = process.argv.slice(1);
let db;
try {
	db = new DatabaseSync(databasePath, { readOnly: true });
	process.stdout.write(JSON.stringify(db.prepare(sql).all()));
} finally {
	if (db) db.close();
}
`.trim();

/**
 * Run a read-only SQL query against an OpenCode SQLite database.
 * Falls back from in-process node:sqlite to a spawned node child, then to the sqlite3 CLI.
 */
export async function querySqliteJson(
	databasePath: string,
	sql: string,
	deps: SqliteReaderDeps = {},
): Promise<SqliteRow[]> {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const spawnFn = deps.spawn ?? spawn;
	const maxBuffer = deps.maxBufferBytes ?? 8 * 1024 * 1024;
	const errors: string[] = [];

	// 1. In-process node:sqlite (Node 22.5+, current Obsidian runtimes).
	try {
		const sqlite = (deps.requireSqliteModule ?? requireSqliteModule)();
		if (!sqlite) throw new Error('node:sqlite unavailable');
		const db = new sqlite.DatabaseSync(databasePath, { readOnly: true });
		try {
			return db.prepare(sql).all();
		} finally {
			db.close();
		}
	} catch (error) {
		errors.push(`in-process: ${formatError(error)}`);
	}

	// 2. Spawn a node executable that has node:sqlite (system Node ≥ 22.13).
	const nodeCandidates = getNodeCandidates(env, platform, deps.execPath);
	for (const nodePath of nodeCandidates) {
		try {
			const stdout = await runChild(spawnFn, nodePath, ['-e', CHILD_SCRIPT, databasePath, sql], env, platform, maxBuffer);
			const rows = JSON.parse(stdout);
			if (!Array.isArray(rows)) throw new Error('invalid JSON output');
			return rows as SqliteRow[];
		} catch (error) {
			errors.push(`node (${nodePath}): ${formatError(error)}`);
		}
	}

	// 3. sqlite3 CLI as a last resort.
	try {
		const stdout = await runChild(spawnFn, 'sqlite3', ['-json', databasePath, sql], env, platform, maxBuffer);
		return stdout.trim() ? (JSON.parse(stdout) as SqliteRow[]) : [];
	} catch (error) {
		errors.push(`sqlite3: ${formatError(error)}`);
	}

	throw new Error(`Unable to read OpenCode database.\n${errors.join('\n')}`);
}

function requireSqliteModule(): SqliteModule | null {
	try {
		// Optional dependency: older Electron runtimes lack node:sqlite.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require('node:sqlite') as SqliteModule | undefined;
		return mod && typeof mod.DatabaseSync === 'function' ? mod : null;
	} catch {
		return null;
	}
}

function getNodeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, execPath?: string): string[] {
	const candidates: string[] = [];
	const exec = execPath ?? process.execPath;
	// Electron ships node:sqlite since Node 22.5; the Obsidian runtime may or may not expose it.
	if (exec && !candidates.includes(exec)) candidates.push(exec);
	if (env.CO_OBER_NODE_PATH?.trim()) candidates.push(env.CO_OBER_NODE_PATH.trim());
	if (!candidates.includes('node')) candidates.push('node');
	void platform;
	return candidates;
}

function runChild(
	spawnFn: NonNullable<SqliteReaderDeps['spawn']>,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	maxBuffer: number,
): Promise<string> {
	const info = getSpawnInfo(command, args, platform, env);
	return new Promise<string>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawnFn(info.command, info.args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				env,
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGKILL');
			reject(new Error(`timed out after ${SQLITE_QUERY_TIMEOUT_MS}ms`));
		}, SQLITE_QUERY_TIMEOUT_MS);

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8');
			if (stdout.length > maxBuffer) {
				child.kill('SIGKILL');
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8').slice(0, 2000);
		});
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
		});
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
