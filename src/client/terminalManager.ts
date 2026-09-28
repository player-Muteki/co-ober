import { spawn, type ChildProcess } from 'child_process';
import { DEFAULT_SETTINGS, type TerminalInstance, type TerminalCreateParams, type TerminalOutputResult } from '../types';

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
 * This list is a name filter, not a decision: shells (sh, bash, cmd,
 * powershell) are on it and their arguments are NOT validated, so `rm -rf` and
 * `curl … | sh` both pass whatever this function returns. Nothing here prompts
 * the user either — the prompt a command may get comes from the agent's own
 * permission request before it reaches this client. What actually gates this
 * surface is the tier: `readonly` and `plan` disable the terminal outright
 * (see permissionTier.ts), and `safe`/`yolo` run it while the grant is written
 * into the tab's transcript, so what ran unasked is at least readable
 * afterwards.
 */
function isAllowedCommand(command: string): boolean {
	const base = getBaseCommand(command);
	if (!base) return false;
	return ALLOWED_COMMANDS.has(base);
}

interface ExitWaiter {
	resolves: Array<(value: { exitCode: number | null; signal: string | null } | null) => void>;
	timeout: number;
}

/**
 * A limit that is not a positive, finite number is not a limit this manager
 * can honour: a zero or negative deadline fires every wait instantly, and a
 * zero byte ceiling erases output, which reads back to the agent as a command
 * that ran and printed nothing. Fall through to the value already in force.
 */
function usableLimit(value: number | undefined, current: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : current;
}

// CoOberSettings marks these optional, so the manager keeps its own answer for
// a caller that handed it nothing usable.
const DEFAULT_TIMEOUT_MS = DEFAULT_SETTINGS.terminalTimeoutMs ?? 30000;
const DEFAULT_MAX_OUTPUT_BYTES = DEFAULT_SETTINGS.terminalMaxOutputBytes ?? 100000;

export class TerminalManager {
	private terminals = new Map<string, TerminalInstance>();
	private processes = new Map<string, ChildProcess>();
	private exitWaiters = new Map<string, ExitWaiter>();
	private nextId = 1;
	private timeoutMs: number = DEFAULT_TIMEOUT_MS;
	private maxOutputBytes: number = DEFAULT_MAX_OUTPUT_BYTES;

	constructor(options: TerminalManagerOptions) {
		this.timeoutMs = usableLimit(options.timeoutMs, this.timeoutMs);
		this.maxOutputBytes = usableLimit(options.maxOutputBytes, this.maxOutputBytes);
	}

	setConfig(options: Partial<TerminalManagerOptions>): void {
		if (options.timeoutMs !== undefined) this.timeoutMs = usableLimit(options.timeoutMs, this.timeoutMs);
		if (options.maxOutputBytes !== undefined) this.maxOutputBytes = usableLimit(options.maxOutputBytes, this.maxOutputBytes);
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
			outputByteLimit: params.outputByteLimit,
			exitCode: null,
			signal: null,
			createdAt: Date.now(),
		};

		this.terminals.set(terminalId, instance);
		try {
			this.spawnProcess(terminalId, params.command, args, cwd, params.env);
		} catch (e) {
			// A command `spawn` refused outright leaves no process to stop, read or
			// release. Leaving its record behind made it a terminal the agent was
			// never given the id of — still counted by stopAllRunning, still listed
			// as running, and unreachable by whoever would have cleaned it up.
			this.terminals.delete(terminalId);
			throw e;
		}

		return instance;
	}

	/**
	 * Get terminal output and status.
	 */
	output(terminalId: string): TerminalOutputResult {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return { output: '', truncated: false, error: `Terminal not found: ${terminalId}` };
		}

		return {
			output: instance.output,
			truncated: instance.outputTruncated === true,
			// Only what this process actually reported. A kill we asked for is not
			// an exit we saw: handing back `{exitCode: null, signal: null}` for a
			// command that had merely been signalled told the agent the work had
			// ended, and `terminalContentFrom` prints nothing at all for that pair,
			// so a live command read back as one that finished silently.
			exitStatus: instance.exitObserved === true
				? { exitCode: instance.exitCode, signal: instance.signal }
				: undefined,
		};
	}

	/**
	 * Kill a running terminal process. Killing is idempotent: a terminal that
	 * already exited is not "not found" — the agent asked us to stop a command
	 * that is already stopped, and answering that with an error would make a
	 * routine cleanup race look like a lost terminal. Only an id we never had
	 * returns false.
	 */
	kill(terminalId: string): boolean {
		const proc = this.processes.get(terminalId);
		const instance = this.terminals.get(terminalId);

		if (!instance) {
			return false;
		}

		if (instance.status !== 'running') {
			return true;
		}

		if (!proc) {
			// Its own documented contract: only an id we never had answers false.
			// A terminal we created but have no live process for is already stopped
			// — refusing here made the handler answer "Terminal not found" for a
			// terminal the agent had been handed the id of, which sends it retrying
			// a cleanup that can never succeed.
			return true;
		}

		try {
			proc.kill('SIGTERM');
			// What we did is ask it to stop, not know that it did. The status says
			// so; the exit status stays unreported until the process reports one.
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
		// Forget the waits too, the way dispose does. A caller parked on this
		// terminal will not see its exit through us any more, so leaving the waiter
		// in the map handed it a timer and a deadline for a terminal this manager
		// had just said it released.
		this.resolveExitWaiter(terminalId);
		return true;
	}

	async waitForExit(terminalId: string): Promise<{ exitCode: number | null; signal: string | null } | null> {
		const instance = this.terminals.get(terminalId);
		if (!instance) {
			return null;
		}

		if (instance.exitObserved === true) {
			return { exitCode: instance.exitCode, signal: instance.signal };
		}

		return new Promise((resolve) => {
			// A second wait on the same terminal must join the first waiter,
			// not replace it — an overwritten resolver would hang that caller
			// until dispose while the process is long gone.
			const existing = this.exitWaiters.get(terminalId);
			if (existing) {
				existing.resolves.push(resolve);
				return;
			}

			const timeout = window.setTimeout(() => {
				const waiter = this.exitWaiters.get(terminalId);
				this.exitWaiters.delete(terminalId);
				// A wait that ran out is not an order to stop the command: the
				// agent asked to observe an exit, not to cause one. Killing here
				// both ended a process nobody asked us to end and then reported a
				// SIGTERM we were the author of. Say nothing exited instead.
				for (const r of waiter?.resolves ?? []) {
					r({ exitCode: null, signal: null });
				}
			}, this.timeoutMs);

			this.exitWaiters.set(terminalId, { resolves: [resolve], timeout });
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
	 * Stop every command still running, keeping the terminals themselves so
	 * their output stays readable and the agent can still release them. Used
	 * when the capability tier closes mid-session: a live process is work that
	 * continues on the user's files after they have said, in the toolbar, that
	 * nothing may change.
	 */
	stopAllRunning(): number {
		let stopped = 0;
		for (const [terminalId, instance] of this.terminals) {
			if (instance.status !== 'running') continue;
			if (this.kill(terminalId)) stopped++;
		}
		return stopped;
	}

	/**
	 * Clean up all terminals.
	 */
	dispose(): void {
		for (const [, waiter] of this.exitWaiters) {
			window.clearTimeout(waiter.timeout);
			// A wait for an exit that will never be observed — the manager is
			// going away — must be answered, not left hanging. Clearing the
			// timeout alone strands every resolve callback and blocks whoever
			// called waitForExit until their own deadline. Say nothing exited.
			for (const resolve of waiter.resolves) {
				resolve(null);
			}
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
		const needsShell = /\.(cmd|bat)$/i.test(command);
		const proc = spawn(command, args, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: env ? { ...process.env, ...env } : process.env,
			shell: needsShell,
		});

		this.processes.set(terminalId, proc);

		const instance = this.terminals.get(terminalId);
		if (instance) {
			instance.pid = proc.pid ?? null;
		}

		proc.stdout?.on('data', (chunk: Buffer | string) => {
			this.appendOutput(terminalId, typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
		});

		proc.stderr?.on('data', (chunk: Buffer | string) => {
			this.appendOutput(terminalId, typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
		});

		proc.on('error', (err: unknown) => {
			// A command that never started is not a command that exited cleanly:
			// the reason goes into the output the agent reads back, because the
			// protocol has no field for it and a null exit code says nothing.
			this.appendOutput(terminalId, `Command failed to start: ${spawnReasonOf(err)}\n`);
			const term = this.terminals.get(terminalId);
			if (term) {
				term.status = 'exited';
				term.exitCode = null;
				term.signal = null;
				// There will be no exit to wait for: this process is finished as
				// much as it will ever be.
				term.exitObserved = true;
			}
			this.processes.delete(terminalId);
			this.resolveExitWaiter(terminalId);
		});

		proc.on('exit', (code, signal) => {
			const term = this.terminals.get(terminalId);
			if (term) {
				if (term.status !== 'killed') term.status = 'exited';
				term.exitCode = code;
				term.signal = signal;
				term.exitObserved = true;
			}
			this.processes.delete(terminalId);
			// Not here. 'exit' fires while stdout and stderr may still hold
			// buffered frames, so a wait answered on it let the agent read the
			// log a moment later and get a version cut mid-write, presented by
			// `terminal/output` as the command's whole output. AcpSubprocess made
			// this same move for the agent's own pipe in 0.2.11; hosted commands
			// are the same pipe-shaped problem.
		});

		proc.on('close', () => {
			// The process is gone and both streams have ended: from here the output
			// we hold is all the output there will be. A terminal that reports only
			// 'close' never told us how it ended, so its exit stays unobserved and
			// the wait answers what it can — nothing seen.
			this.resolveExitWaiter(terminalId);
		});
	}

	private appendOutput(terminalId: string, text: string): void {
		const term = this.terminals.get(terminalId);
		if (!term) return;

		const maxBytes = this.outputLimitFor(term);
		const combined = term.output + text;
		// The ceiling is a byte count — what the agent declared it can accept —
		// so it has to be measured in bytes. String.length counts UTF-16 units:
		// Chinese output is three bytes a character, and honoring the limit by
		// length fed the agent up to triple what it asked to bound its own
		// context with.
		if (Buffer.byteLength(combined, 'utf-8') > maxBytes) {
			// Keep the tail and drop the head: what an agent reads next is how
			// the command ended. One oversized chunk used to sail past the
			// ceiling untouched, so the limit was a floor, not a ceiling.
			const buf = Buffer.from(combined, 'utf-8');
			let start = Math.max(buf.length - maxBytes, 0);
			// ...but never through the middle of a character: 0b10xxxxxx is a
			// continuation byte, and a frame starting on one decodes as U+FFFD.
			while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
			term.output = buf.subarray(start).toString('utf-8');
			term.outputTruncated = true;
		} else {
			term.output = combined;
		}
	}

	/**
	 * The agent's `outputByteLimit` is a ceiling it wants honoured, our setting
	 * a ceiling we must never exceed — so the smaller of the two wins.
	 */
	private outputLimitFor(term: TerminalInstance): number {
		const requested = term.outputByteLimit;
		if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return this.maxOutputBytes;
		return Math.min(requested, this.maxOutputBytes);
	}

	private resolveExitWaiter(terminalId: string): void {
		const waiter = this.exitWaiters.get(terminalId);
		if (!waiter) return;
		window.clearTimeout(waiter.timeout);
		this.exitWaiters.delete(terminalId);

		const instance = this.terminals.get(terminalId);
		for (const resolve of waiter.resolves) {
			resolve(instance ? { exitCode: instance.exitCode, signal: instance.signal } : null);
		}
	}
}

/** Node puts the reason a spawn refused on `code`; without it, say what we got. */
function spawnReasonOf(err: unknown): string {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	if (typeof code === 'string' && code) return code;
	const message = (err as Error | null)?.message;
	return typeof message === 'string' && message ? message : String(err);
}
