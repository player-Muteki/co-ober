import { normalize, relative, isAbsolute, sep } from 'path';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';

export interface FsReadResult {
	content: string;
	error?: string;
}

export interface FsDelegateOptions {
	vaultPath: string;
	maxBytes: number;
}

export class FsDelegate {
	private vaultPath: string;
	private maxBytes: number;

	constructor(options: FsDelegateOptions) {
		this.vaultPath = this.normalizePath(options.vaultPath);
		this.maxBytes = options.maxBytes;
	}

	/**
	 * Read a text file within the vault boundary.
	 * @param filePath - Absolute or relative path to read
	 * @returns File content or error message
	 */
	readTextFile(filePath: string): FsReadResult {
		try {
			const resolvedPath = this.resolveWithinVault(filePath);
			if (!resolvedPath) {
				return { content: '', error: 'Access denied: path is outside vault boundary' };
			}

			if (!existsSync(resolvedPath)) {
				return { content: '', error: `File not found: ${filePath}` };
			}

			const stat = statSync(resolvedPath);
			if (stat.isDirectory()) {
				return { content: '', error: `Path is a directory: ${filePath}` };
			}

			if (stat.size > this.maxBytes) {
				const content = this.readLimited(resolvedPath, this.maxBytes);
				return { content: content + '\n... [truncated]' };
			}

			const content = readFileSync(resolvedPath, 'utf-8');
			return { content };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return { content: '', error: `Failed to read file: ${message}` };
		}
	}

	/**
	 * Resolve a file path within the vault boundary.
	 * Returns the absolute path if valid, or null if outside vault.
	 */
	private resolveWithinVault(filePath: string): string | null {
		let resolved: string;

		if (isAbsolute(filePath)) {
			resolved = this.normalizePath(filePath);
		} else {
			resolved = this.normalizePath(this.vaultPath + sep + filePath);
		}

		// Check if the resolved path is within the vault
		const rel = relative(this.vaultPath, resolved);
		if (rel.startsWith('..') || isAbsolute(rel)) {
			return null;
		}

		// Reject path traversal attempts
		const segments = rel.split(sep);
		if (segments.includes('..')) {
			return null;
		}

		return resolved;
	}

	/**
	 * Normalize path separators and remove trailing slashes.
	 */
	private normalizePath(p: string): string {
		return normalize(p).replace(/[/\\]$/, '');
	}

	/**
	 * Read file up to a byte limit.
	 */
	private readLimited(filePath: string, maxBytes: number): string {
		const buffer = Buffer.alloc(maxBytes);
		const fd = openSync(filePath, 'r');
		try {
			const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
			return buffer.toString('utf-8', 0, bytesRead);
		} finally {
			closeSync(fd);
		}
	}
}

/**
 * Convert an absolute vault path to a relative path.
 */
export function toVaultRelativePath(absolutePath: string, vaultPath: string): string {
	const normalizedAbsolute = normalize(absolutePath);
	const normalizedVault = normalize(vaultPath);
	const rel = relative(normalizedVault, normalizedAbsolute);
	return rel.split(sep).join('/');
}
