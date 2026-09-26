import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FsDelegate, toVaultRelativePath } from './fsDelegate';

// Mock fs module
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	statSync: vi.fn(),
	openSync: vi.fn(),
	readSync: vi.fn(),
	closeSync: vi.fn(),
}));

import { existsSync, readFileSync, statSync } from 'fs';

describe('FsDelegate', () => {
	let delegate: FsDelegate;

	beforeEach(() => {
		vi.clearAllMocks();
		delegate = new FsDelegate({
			vaultPath: '/vault',
			maxBytes: 8000,
		});
	});

	describe('writeTextFile', () => {
		it('routes in-vault writes through the injected VaultWriteIo (vault-path relative)', async () => {
			const writes: Array<[string, string]> = [];
			// Trailing slash in vaultPath must not defeat the boundary check or the rel-path.
			const ioDelegate = new FsDelegate({
				vaultPath: '/vault/',
				maxBytes: 8000,
				vaultIo: {
					writeText: async (rel, content) => {
						writes.push([rel, content]);
					},
				},
			});

			const result = await ioDelegate.writeTextFile('notes/a.md', 'hello');

			expect(result.success).toBe(true);
			expect(writes).toEqual([['notes/a.md', 'hello']]);
		});

		it('refuses absolute paths outside the vault without touching vaultIo', async () => {
			const writeText = vi.fn();
			const ioDelegate = new FsDelegate({ vaultPath: '/vault', maxBytes: 8000, vaultIo: { writeText } });

			const result = await ioDelegate.writeTextFile('/etc/passwd', 'x');

			expect(result.success).toBe(false);
			expect(result.error).toContain('outside vault');
			expect(writeText).not.toHaveBeenCalled();
		});

		it('refuses to overwrite the vault root itself', async () => {
			const writeText = vi.fn();
			const ioDelegate = new FsDelegate({ vaultPath: '/vault', maxBytes: 8000, vaultIo: { writeText } });

			const result = await ioDelegate.writeTextFile('/vault', 'x');

			expect(result.success).toBe(false);
			expect(result.error).toContain('vault root');
			expect(writeText).not.toHaveBeenCalled();
		});

		it('reports VaultWriteIo failures as write errors', async () => {
			const ioDelegate = new FsDelegate({
				vaultPath: '/vault',
				maxBytes: 8000,
				vaultIo: {
					writeText: async () => {
						throw new Error('disk on fire');
					},
				},
			});

			const result = await ioDelegate.writeTextFile('a.md', 'x');

			expect(result.success).toBe(false);
			expect(result.error).toContain('disk on fire');
		});
	});

	describe('readTextFile', () => {
		it('reads file within vault boundary', () => {
			(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
			(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false, size: 100 });
			(readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('file content');

			const result = delegate.readTextFile('notes/test.md');

			expect(result.content).toBe('file content');
			expect(result.error).toBeUndefined();
		});

		it('rejects path traversal attempts', () => {
			const result = delegate.readTextFile('../etc/passwd');

			expect(result.content).toBe('');
			expect(result.error).toContain('Access denied');
		});

		it('rejects absolute paths outside vault', () => {
			const result = delegate.readTextFile('/etc/passwd');

			expect(result.content).toBe('');
			expect(result.error).toContain('Access denied');
		});

		it('returns error for non-existent file', () => {
			(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

			const result = delegate.readTextFile('nonexistent.md');

			expect(result.content).toBe('');
			expect(result.error).toContain('File not found');
		});

		it('returns error for directory', () => {
			(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
			(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => true, size: 0 });

			const result = delegate.readTextFile('some-folder');

			expect(result.content).toBe('');
			expect(result.error).toContain('Path is a directory');
		});

		it('truncates large files', () => {
			(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
			(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false, size: 10000 });

			// Mock readLimited by mocking the internal fs calls
			const fs = require('fs');
			fs.openSync = vi.fn().mockReturnValue(1);
			fs.readSync = vi.fn().mockReturnValue(10000);
			fs.closeSync = vi.fn();

			const result = delegate.readTextFile('large-file.txt');

			expect(result.content).toContain('truncated');
		});
	});
});

describe('toVaultRelativePath', () => {
	it('converts absolute path to relative', () => {
		const result = toVaultRelativePath('/vault/notes/test.md', '/vault');
		expect(result).toBe('notes/test.md');
	});

	it('handles nested paths', () => {
		const result = toVaultRelativePath('/vault/folder/subfolder/file.md', '/vault');
		expect(result).toBe('folder/subfolder/file.md');
	});
});

describe('the lines an agent pointed at (0.2.5 stage 2)', () => {
	let delegate: FsDelegate;

	const file = (text: string) => {
		(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
		(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false, size: text.length });
		(readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(text);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		delegate = new FsDelegate({ vaultPath: '/vault', maxBytes: 8000 });
	});

	it('starts where the line said, not where the file began', () => {
		file('one\ntwo\nthree\nfour');

		expect(delegate.readTextFile('a.md', { line: 3 }).content).toBe('three\nfour');
	});

	it('stops after the number of lines it was given', () => {
		file('one\ntwo\nthree\nfour');

		expect(delegate.readTextFile('a.md', { line: 2, limit: 2 }).content).toBe('two\nthree');
	});

	it('honours a window of no lines as the empty answer it asked for', () => {
		file('one\ntwo');

		expect(delegate.readTextFile('a.md', { line: 1, limit: 0 }).content).toBe('');
	});

	it('says nothing was there when the line is past the end', () => {
		file('one\ntwo');

		expect(delegate.readTextFile('a.md', { line: 500 }).content).toBe('');
	});

	it('caps the window it was asked for, and marks that it did', () => {
		const narrow = new FsDelegate({ vaultPath: '/vault', maxBytes: 8 });
		file('aaaaaaaaaaaa\nbbbbbbbbbbbb');

		const result = narrow.readTextFile('a.md', { line: 1 });

		expect(result.content).toContain('truncated');
		expect(result.content.startsWith('aaaaaaaa')).toBe(true);
	});

	it('still reads the whole file when no window was named', () => {
		file('one\ntwo\nthree');

		expect(delegate.readTextFile('a.md').content).toBe('one\ntwo\nthree');
	});
});
