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
