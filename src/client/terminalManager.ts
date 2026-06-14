import { spawn, type ChildProcess } from 'child_process';
import type { TerminalInstance, TerminalCreateParams, TerminalOutputResult } from '../types';

export interface TerminalManagerOptions {
	timeoutMs: number;
	maxOutputBytes: number;
}

const ALLOWED_COMMANDS = new Set([
	'sh', 'bash', 'zsh', 'dash', 'ksh',
	'cmd', 'powershell', 'pwsh',
	'node', 'python', 'python3', 'pip', 'pip3',
	'git', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno',
	'cat', 'grep', 'find', 'ls', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tee',
	'which', 'where', 'type', 'date', 'sleep', 'env', 'printenv', 'pwd',
	'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'chmod', 'chown',
	'curl', 'wget', 'http',
	'opencode',
]);

export class TerminalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TerminalError';
	}
}

/**
 * Extract the base command name from a full command string.
 * Handles paths with spaces, extensions, and embedded arguments.
 */
function getBaseCommand(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return '';

	// Split on whitespace to get the first token (the command)
	const firstToken = trimmed.split(/\s+/)[0];
	if (!firstToken) return '';

	// Extract the filename part from path separators
	const base = firstToken.split(/[\\/]/).pop() ?? firstToken;
	return base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase();
}

/**
 * Check whether a command the Agent wants to run is on the allowlist.
 *
 * Note: shell commands (sh, bash, cmd, powershell) are on the allowlist but
 * their arguments are NOT validated. In safe / plan permission modes the user
 * will be prompted before execution, which is the intended mitigation.
 */
function isAllowedCommand(command: string): boolean {
	const base = getBaseCommand(command);
	if (!base) return false;
	return ALLOWED_COMMANDS.has(base);
}

interface ExitWaiter {
	resolve: (value: { exitCode: number | null; signal: string | null } | null) => void;
	timeout: number;
}

export class TerminalManager {
	private terminals = new Map<string, TerminalInstance>();
	private processes = new Map<string, ChildProcess>();
	private exitWaiters = new Map<string, ExitWaiter>();
	private nextId = 1;
	private timeoutMs: number;
	private maxOutputBytes: number;

	constructor(options: TerminalManagerOptions) {
		this.timeoutMs = options.timeoutMs;
		this.maxOutputBytes = options.maxOutputBytes;
	}

	setConfig(options: Partial<TerminalManagerOptions>): void {
		if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
		if (options.maxOutputBytes !== undefined) this.maxOutputBytes = options.maxOutputBytes;
	}

	create(params: TerminalCreateParams, vaultPath: string): TerminalInstance {
		const terminalId = `term-${this.nextId++}`;
		const cwd = params.cwd || vaultPath;
		const args = params.args || [];

		if (!params.command || !params.command.trim()) {
			throw new TerminalError('Command is empty');
		}

		if (!isAllowedCommand(params.command)) {
			throw new TerminalError(`Command not allowed: ${getBaseCommand(params.command)}`);
		}

		const instance: TerminalInstance = {
			terminalId,
			command: params.command,
			args,
			cwd,
			pid: null,
			status: 'running',
			output: '',
			exitCode: null,
			signal: null,
			createdAt: Date.now(),
		};

		this.terminals.set(terminalId, instance);
		this.spawnProcess(terminalId, params.command, args, cwd, params.env);

		return instance;
	}

	/**
	 * Get terminal output and status.
	 */
	output(terminalId: string): TerminalOutputResult {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return { output: '', error: `Terminal not found: ${terminalId}` };
		}

		return {
			output: instance.output,
			exitStatus: instance.status !== 'running'
				? { exitCode: instance.exitCode, signal: instance.signal }
				: undefined,
		};
	}

	/**
	 * Kill a running terminal process.
	 */
	kill(terminalId: string): boolean {
		const proc = this.processes.get(terminalId);
		const instance = this.terminals.get(terminalId);

		if (!proc || !instance) {
			return false;
		}

		if (instance.status !== 'running') {
			return false;
		}

		try {
			proc.kill('SIGTERM');
			instance.status = 'killed';
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Release a terminal and clean up resources.
	 */
	release(terminalId: string): boolean {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return false;
		}

		if (instance.status === 'running') {
			this.kill(terminalId);
		}

		this.terminals.delete(terminalId);
		this.processes.delete(terminalId);
		return true;
	}

	async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null } | null> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return null;
		}

		if (instance.status !== 'running') {
			return { exitCode: instance.exitCode, signal: instance.signal };
		}

		return new Promise((resolve) => {
			const timeout = window.setTimeout(() => {
				this.exitWaiters.delete(terminalId);
				this.kill(terminalId);
				resolve({ exitCode: null, signal: 'SIGTERM' });
			}, this.timeoutMs);

			this.exitWaiters.set(terminalId, { resolve, timeout });
		});
	}

	/**
	 * Get all terminal instances.
	 */
	getAll(): TerminalInstance[] {
		return [...this.terminals.values()];
	}

	/**
	 * Get a specific terminal instance.
	 */
	get(terminalId: string): TerminalInstance | undefined {
		return this.terminals.get(terminalId);
	}

	/**
	 * Clean up all terminals.
	 */
	dispose(): void {
		for (const [, waiter] of this.exitWaiters) {
			window.clearTimeout(waiter.timeout);
		}
		this.exitWaiters.clear();

		for (const [terminalId] of this.terminals) {
			this.kill(terminalId);
		}
		this.terminals.clear();
		this.processes.clear();
	}

	private spawnProcess(
		terminalId: string,
		command: string,
		args: string[],
		cwd: string,
		env?: Record<string, string>,
	): void {
		const proc = spawn(command, args, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: env ? { ...process.env, ...env } : process.env,
			shell: false,
		});

		this.processes.set(terminalId, proc);

		const instance = this.terminals.get(terminalId);
		if (instance) {
			instance.pid = proc.pid ?? null;
		}

		proc.stdout?.on('data', (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
			const term = this.terminals.get(terminalId);
			if (!term) return;

			// Truncate output to maxOutputBytes
			const maxBytes = this.maxOutputBytes;
			if (term.output.length + text.length > maxBytes) {
				term.output = term.output.slice(-Math.floor(maxBytes * 0.75)) + text;
			} else {
				term.output += text;
			}
		});

		proc.stderr?.on('data', (chunk: Buffer | string) => {
			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
			const term = this.terminals.get(terminalId);
			if (!term) return;

			const maxBytes = this.maxOutputBytes;
			if (term.output.length + text.length > maxBytes) {
				term.output = term.output.slice(-Math.floor(maxBytes * 0.75)) + text;
			} else {
				term.output += text;
			}
		});

		proc.on('error', (_err: unknown) => {
			const term = this.terminals.get(terminalId);
			if (term) {
				term.status = 'exited';
				term.exitCode = null;
				term.signal = null;
			}
			this.processes.delete(terminalId);
			this.resolveExitWaiter(terminalId);
		});

		proc.on('exit', (code, signal) => {
			const term = this.terminals.get(terminalId);
			if (term) {
				term.status = 'exited';
				term.exitCode = code;
				term.signal = signal;
			}
			this.processes.delete(terminalId);
			this.resolveExitWaiter(terminalId);
		});
	}

	private resolveExitWaiter(terminalId: string): void {
		const waiter = this.exitWaiters.get(terminalId);
		if (!waiter) return;
		window.clearTimeout(waiter.timeout);
		this.exitWaiters.delete(terminalId);

		const instance = this.terminals.get(terminalId);
		waiter.resolve(instance ? { exitCode: instance.exitCode, signal: instance.signal } : null);
	}
}
