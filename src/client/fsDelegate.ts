import { normalize, relative, isAbsolute, sep, dirname } from 'path';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'fs';
import { TRUNCATION_MARKER } from '../constants';

export interface FsReadResult {
	content: string;
	error?: string;
}

export interface FsWriteResult {
	success: boolean;
	error?: string;
}

/**
 * Obsidian-aware write path. When provided, writes go through the vault API so
 * the metadata cache and open editors see the change; when absent, the raw fs
 * fallback remains for tests and headless use.
 */
export interface VaultWriteIo {
	/** Write a vault-relative path, creating parent folders and overwriting as needed. */
	writeText(relPath: string, content: string): Promise<void>;
}

export interface FsDelegateOptions {
	vaultPath: string;
	maxBytes: number;
	vaultIo?: VaultWriteIo;
}

export interface FsReadWindow {
	/** 1-based line to start reading from, as `ReadTextFileRequest.line` means it. */
	line?: number;
	/** Maximum number of lines to read; 0 means an empty window. */
	limit?: number;
}

export class FsDelegate {
	private vaultPath: string;
	private maxBytes: number;
	private vaultIo: VaultWriteIo | null;

	constructor(options: FsDelegateOptions) {
		this.vaultPath = this.normalizePath(options.vaultPath);
		this.maxBytes = options.maxBytes;
		this.vaultIo = options.vaultIo ?? null;
	}

	setMaxBytes(maxBytes: number): void {
		this.maxBytes = maxBytes;
	}

	/**
	 * Read a text file within the vault boundary.
	 * @param filePath - Absolute or relative path to read
	 * @param window - Line window the agent asked for; absent means the whole file
	 * @returns File content or error message
	 */
	readTextFile(filePath: string, window: FsReadWindow = {}): FsReadResult {
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

			if (window.line === undefined && window.limit === undefined) {
				if (stat.size > this.maxBytes) {
					const content = this.readLimited(resolvedPath, this.maxBytes);
					return { content: `${content}\n${TRUNCATION_MARKER}` };
				}

				const content = readFileSync(resolvedPath, 'utf-8');
				return { content };
			}

			// A window is a request for particular lines. Answering it with the
			// head bytes of the file would have the agent rewrite line 1 while it
			// believes it read line 500, so slice by line first and only then
			// apply the byte ceiling to what was actually asked for.
			const lines = readFileSync(resolvedPath, 'utf-8').split('\n');
			const start = Math.max(0, (window.line ?? 1) - 1);
			const count = window.limit ?? lines.length;
			let content = lines.slice(start, start + Math.max(0, count)).join('\n');
			if (Buffer.byteLength(content, 'utf-8') > this.maxBytes) {
				const clipped = Buffer.from(content, 'utf-8').subarray(0, this.maxBytes).toString('utf-8');
				content = `${clipped.replace(/\uFFFD+$/, '')}\n${TRUNCATION_MARKER}`;
			}
			return { content };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return { content: '', error: `Failed to read file: ${message}` };
		}
	}

	/**
	 * Write a text file within the vault boundary.
	 * @param filePath - Absolute or relative path to write
	 * @param content - Content to write
	 * @returns Success status or error message
	 */
	async writeTextFile(filePath: string, content: string): Promise<FsWriteResult> {
		try {
			const resolvedPath = this.resolveWithinVault(filePath);
			if (!resolvedPath) {
				return { success: false, error: 'Access denied: path is outside vault boundary' };
			}

			if (this.vaultIo) {
				const rel = toVaultRelativePath(resolvedPath, this.vaultPath);
				if (!rel) {
					return { success: false, error: 'Refusing to write the vault root' };
				}
				await this.vaultIo.writeText(rel, content);
				return { success: true };
			}

			// Ensure parent directory exists
			const dir = dirname(resolvedPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			writeFileSync(resolvedPath, content, 'utf-8');
			return { success: true };
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return { success: false, error: `Failed to write file: ${message}` };
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
		const normalized = normalize(p);
		return normalized.replace(/[/\\]+$/, '') || normalized;
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
