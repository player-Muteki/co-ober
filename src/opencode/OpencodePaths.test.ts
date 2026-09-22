import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { resolveOpencodeDataDir, resolveOpencodeDatabasePath, getOpencodeDatabaseCandidates } from './OpencodePaths';

const fakeFs = (files: Set<string>) => ({
	existsSync: (p: string) => files.has(p),
	readdirSync: (p: string) => [...files].filter((f) => path.dirname(f) === p).map((f) => path.basename(f)),
});

describe('OpencodePaths', () => {
	it('prefers XDG_DATA_HOME when set', () => {
		const dir = resolveOpencodeDataDir({ XDG_DATA_HOME: '/xdg', HOME: '/home/u' });
		expect(dir).toBe(path.join('/xdg', 'opencode'));
	});

	it('falls back to ~/.local/share/opencode', () => {
		const dir = resolveOpencodeDataDir({ HOME: '/home/u' });
		expect(dir).toBe(path.join('/home/u', '.local', 'share', 'opencode'));
	});

	it('honors absolute OPENCODE_DB override', () => {
		const resolved = resolveOpencodeDatabasePath(
			{ OPENCODE_DB: '/custom/my.db', HOME: '/home/u' },
			fakeFs(new Set()),
		);
		expect(resolved).toBe('/custom/my.db');
	});

	it('treats relative OPENCODE_DB as data-dir relative', () => {
		const resolved = resolveOpencodeDatabasePath(
			{ OPENCODE_DB: 'alt.db', HOME: '/home/u' },
			fakeFs(new Set()),
		);
		expect(resolved).toBe(path.join('/home/u', '.local', 'share', 'opencode', 'alt.db'));
	});

	it('returns first existing candidate database', () => {
		const defaultPath = path.join('/home/u', '.local', 'share', 'opencode', 'opencode.db');
		const resolved = resolveOpencodeDatabasePath({ HOME: '/home/u' }, fakeFs(new Set([defaultPath])));
		expect(resolved).toBe(defaultPath);
	});

	it('discovers variant database files via directory listing', () => {
		const dir = path.join('/home/u', '.local', 'share', 'opencode');
		const fs = fakeFs(new Set([path.join(dir, 'opencode-work.db')]));
		const candidates = getOpencodeDatabaseCandidates({ HOME: '/home/u' }, fs);
		expect(candidates).toContain(path.join(dir, 'opencode-work.db'));
	});

	it('returns null when no database exists', () => {
		const resolved = resolveOpencodeDatabasePath({ HOME: '/home/u' }, fakeFs(new Set()));
		expect(resolved).toBeNull();
	});
});