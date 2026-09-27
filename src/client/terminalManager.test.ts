import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'node:events';
import { TerminalManager } from './terminalManager';

// Mock child_process
vi.mock('child_process', () => ({
	spawn: vi.fn(() => {
		const EventEmitter = require('events');
		const proc = new EventEmitter();
		proc.pid = 12345;
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.kill = vi.fn();
		return proc;
	}),
}));

import { spawn } from 'child_process';

describe('TerminalManager', () => {
	let manager: TerminalManager;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new TerminalManager({
			timeoutMs: 5000,
			maxOutputBytes: 1000,
		});
	});

	afterEach(() => {
		manager.dispose();
	});

	describe('create', () => {
		it('creates a terminal instance', () => {
			const instance = manager.create({ command: 'echo hello' }, '/vault');

			expect(instance.terminalId).toMatch(/^term-\d+$/);
			expect(instance.command).toBe('echo hello');
			expect(instance.status).toBe('running');
			expect(instance.pid).toBe(12345);
		});

		it('spawns a process without shell', () => {
			manager.create({ command: 'ls', args: ['-la'] }, '/vault');

			expect(spawn).toHaveBeenCalledWith('ls', ['-la'], expect.objectContaining({
				cwd: '/vault',
				shell: false,
			}));
		});

		it('uses shell for .cmd files', () => {
			manager.create({ command: 'echo.cmd', args: ['hello'] }, '/vault');

			expect(spawn).toHaveBeenCalledWith('echo.cmd', ['hello'], expect.objectContaining({
				shell: true,
			}));
		});

		it('uses shell for .bat files', () => {
			manager.create({ command: 'git.bat', args: ['status'] }, '/vault');

			expect(spawn).toHaveBeenCalledWith('git.bat', ['status'], expect.objectContaining({
				shell: true,
			}));
		});

		it('rejects disallowed commands', () => {
			expect(() => manager.create({ command: 'suspicious-tool' }, '/vault'))
				.toThrow('Command not allowed');
		});

		it('rejects empty command', () => {
			expect(() => manager.create({ command: '' }, '/vault'))
				.toThrow('Command is empty');
		});
	});

	describe('output', () => {
		it('returns output for existing terminal', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			const result = manager.output(instance.terminalId);

			expect(result.output).toBe('');
			expect(result.error).toBeUndefined();
		});

		it('returns error for non-existent terminal', () => {
			const result = manager.output('non-existent');

			expect(result.output).toBe('');
			expect(result.error).toContain('Terminal not found');
		});
	});

	describe('output budget', () => {
		function lastProc(): { stdout: EventEmitter; stderr: EventEmitter } {
			const results = vi.mocked(spawn).mock.results;
			return results[results.length - 1].value;
		}

		it('caps one oversized chunk at the agent\'s own ceiling', () => {
			const instance = manager.create({ command: 'echo', outputByteLimit: 100 }, '/vault');
			lastProc().stdout.emit('data', 'x'.repeat(500));

			const result = manager.output(instance.terminalId);
			expect(result.output).toHaveLength(100);
			expect(result.truncated).toBe(true);
		});

		it('never keeps more than this client\'s own setting allows', () => {
			const instance = manager.create({ command: 'echo', outputByteLimit: 5000 }, '/vault');
			lastProc().stdout.emit('data', 'x'.repeat(1500));

			expect(manager.output(instance.terminalId).output).toHaveLength(1000);
		});

		it('keeps the tail of the stream, not the head', () => {
			const instance = manager.create({ command: 'echo', outputByteLimit: 100 }, '/vault');
			const proc = lastProc();
			proc.stdout.emit('data', 'a'.repeat(90));
			proc.stderr.emit('data', 'b'.repeat(30));

			expect(manager.output(instance.terminalId).output).toBe('a'.repeat(70) + 'b'.repeat(30));
		});

		it('decodes a buffer chunk as text', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			lastProc().stdout.emit('data', Buffer.from('héllo'));

			expect(manager.output(instance.terminalId).output).toBe('héllo');
		});

		it('measures the ceiling in bytes for multibyte output', () => {
			const instance = manager.create({ command: 'echo', outputByteLimit: 100 }, '/vault');
			lastProc().stdout.emit('data', '中'.repeat(100));

			const result = manager.output(instance.terminalId);
			// A CJK log costs three bytes per character: judged by string length
			// this kept ~300 bytes under the 100-byte ceiling the agent declared.
			expect(Buffer.byteLength(result.output, 'utf-8')).toBeLessThanOrEqual(100);
			expect(result.output).toBe('中'.repeat(33));
			expect(result.truncated).toBe(true);
		});

		it('cuts between characters, so a trimmed log never carries half of one', () => {
			const instance = manager.create({ command: 'echo', outputByteLimit: 101 }, '/vault');
			lastProc().stdout.emit('data', '😀'.repeat(40));

			const result = manager.output(instance.terminalId);
			// Starting the slice mid-sequence decoded a replacement character at
			// the front, and a lone surrogate corrupts whatever follows it.
			expect(Buffer.byteLength(result.output, 'utf-8')).toBeLessThanOrEqual(101);
			expect(result.output).not.toContain('\uFFFD');
			expect(result.output).toBe('😀'.repeat(25));
		});

		it('spawns with the environment the agent asked for', () => {
			manager.create({ command: 'git', env: { GIT_AUTHOR_NAME: 'qs' } }, '/vault');

			expect(spawn).toHaveBeenCalledWith('git', [], expect.objectContaining({
				env: expect.objectContaining({ GIT_AUTHOR_NAME: 'qs' }),
			}));
		});
	});

	describe('kill', () => {
		it('kills a running terminal', () => {
			const instance = manager.create({ command: 'sleep 10' }, '/vault');
			const success = manager.kill(instance.terminalId);

			expect(success).toBe(true);
			expect(instance.status).toBe('killed');
		});

		it('returns false for non-existent terminal', () => {
			const success = manager.kill('non-existent');
			expect(success).toBe(false);
		});

		it('succeeds, not errors, when the terminal already exited on its own', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			const proc = Reflect.get(manager, 'processes').get(instance.terminalId);
			proc.emit('exit', 0, null);
			// Killing what already finished is not a failure the agent should
			// have to special-case; the outcome it wanted is already true.
			expect(manager.kill(instance.terminalId)).toBe(true);
			expect(manager.get(instance.terminalId)?.status).toBe('exited');
		});
	});

	describe('stopAllRunning', () => {
		it('signals every running command and says how many it stopped', () => {
			const first = manager.create({ command: 'sleep 5' }, '/vault');
			const second = manager.create({ command: 'sleep 7' }, '/vault');

			expect(manager.stopAllRunning()).toBe(2);
			expect(manager.get(first.terminalId)?.status).toBe('killed');
			expect(manager.get(second.terminalId)?.status).toBe('killed');
			// Stopped, not erased: the agent can still read what it printed and
			// release it, which is what keeps a refusal from looking like a crash.
			expect(manager.output(first.terminalId).error).toBeUndefined();
		});

		it('leaves a terminal that already exited alone', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			const proc = Reflect.get(manager, 'processes').get(instance.terminalId);
			proc.emit('exit', 0, null);
			const killSpy = vi.spyOn(proc, 'kill');

			// Closing the surface is not a licence to rewrite history: a command
			// that finished on its own has an exit code the agent can still read.
			expect(manager.stopAllRunning()).toBe(0);
			expect(killSpy).not.toHaveBeenCalled();
			expect(manager.get(instance.terminalId)?.status).toBe('exited');
		});
	});

	describe('release', () => {
		it('releases a terminal', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			const success = manager.release(instance.terminalId);

			expect(success).toBe(true);
			expect(manager.get(instance.terminalId)).toBeUndefined();
		});

		it('returns false for non-existent terminal', () => {
			const success = manager.release('non-existent');
			expect(success).toBe(false);
		});
	});

	describe('waitForExit', () => {
		it('resolves every concurrent waiter when the process exits', async () => {
			const instance = manager.create({ command: 'sleep 5' }, '/vault');
			const first = manager.waitForExit(instance.terminalId);
			const second = manager.waitForExit(instance.terminalId);

			const proc = vi.mocked(spawn).mock.results[0].value as unknown as { emit: (e: string, ...a: unknown[]) => void };
			proc.emit('exit', 0, null);

			await expect(first).resolves.toEqual({ exitCode: 0, signal: null });
			await expect(second).resolves.toEqual({ exitCode: 0, signal: null });
		});

		it('leaves the command running and reports nothing exited when the shared deadline expires', async () => {
			vi.useFakeTimers();
			const localManager = new TerminalManager({ timeoutMs: 1000, maxOutputBytes: 1000 });
			const instance = localManager.create({ command: 'sleep 5' }, '/vault');
			const proc = Reflect.get(localManager, 'processes').get(instance.terminalId);
			const killSpy = vi.spyOn(proc, 'kill');
			const first = localManager.waitForExit(instance.terminalId);
			const second = localManager.waitForExit(instance.terminalId);

			vi.advanceTimersByTime(1500);

			// A wait that ran out is an observation, not an order to stop the
			// command: the timeout must neither signal the process nor claim a
			// SIGTERM it never sent.
			await expect(first).resolves.toEqual({ exitCode: null, signal: null });
			await expect(second).resolves.toEqual({ exitCode: null, signal: null });
			expect(killSpy).not.toHaveBeenCalled();
			expect(localManager.get(instance.terminalId)?.status).toBe('running');
			localManager.dispose();
			vi.useRealTimers();
		});
	});

	describe('getAll', () => {
		it('returns all terminals', () => {
			manager.create({ command: 'echo 1' }, '/vault');
			manager.create({ command: 'echo 2' }, '/vault');

			const all = manager.getAll();
			expect(all).toHaveLength(2);
		});
	});

	describe('get', () => {
		it('returns a specific terminal', () => {
			const instance = manager.create({ command: 'echo' }, '/vault');
			const retrieved = manager.get(instance.terminalId);

			expect(retrieved).toBe(instance);
		});

		it('returns undefined for non-existent terminal', () => {
			const retrieved = manager.get('non-existent');
			expect(retrieved).toBeUndefined();
		});
	});

	describe('configured limits', () => {
		it('keeps the limit in force when Settings hand it one that is not a limit', () => {
			// A number that survives sanitisation as 0 or -5 is not "no wait" or
			// "print nothing": it is a broken value, and honouring it turned every
			// waitForExit into an instant answer and every log into an empty one.
			manager.setConfig({ timeoutMs: -5, maxOutputBytes: 0 });

			expect(Reflect.get(manager, 'timeoutMs')).toBe(5000);
			expect(Reflect.get(manager, 'maxOutputBytes')).toBe(1000);
		});

		it('applies a usable limit', () => {
			manager.setConfig({ timeoutMs: 250, maxOutputBytes: 64 });

			expect(Reflect.get(manager, 'timeoutMs')).toBe(250);
			expect(Reflect.get(manager, 'maxOutputBytes')).toBe(64);
		});

		it('starts on the plugin default rather than an unusable configured value', () => {
			const localManager = new TerminalManager({ timeoutMs: NaN, maxOutputBytes: -1 });

			expect(Reflect.get(localManager, 'timeoutMs')).toBe(30000);
			expect(Reflect.get(localManager, 'maxOutputBytes')).toBe(100000);
			localManager.dispose();
		});
	});

	describe('dispose', () => {
		it('cleans up all terminals', () => {
			manager.create({ command: 'echo 1' }, '/vault');
			manager.create({ command: 'echo 2' }, '/vault');

			manager.dispose();
			expect(manager.getAll()).toHaveLength(0);
		});

		it('resolves a pending waitForExit instead of stranding it when the manager is disposed', async () => {
			const instance = manager.create({ command: 'sleep 5' }, '/vault');
			const waiter = manager.waitForExit(instance.terminalId);

			manager.dispose();

			// Clearing the waiter's timeout without answering it left whoever
			// called waitForExit hanging for a process the manager was taking
			// away. Resolve it as "no exit observed".
			await expect(waiter).resolves.toBeNull();
		});
	});
});

describe('TerminalManager — a command that never started (0.2.6 stage 3)', () => {
	let manager: TerminalManager;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new TerminalManager({
			timeoutMs: 5000,
			maxOutputBytes: 1000,
		});
	});

	afterEach(() => {
		manager.dispose();
	});

	function lastProc(): { emit: (event: string, ...args: unknown[]) => void } {
		const results = vi.mocked(spawn).mock.results;
		return results[results.length - 1].value as unknown as {
			emit: (event: string, ...args: unknown[]) => void;
		};
	}

	it('writes the errno code into the output the agent reads back', () => {
		const instance = manager.create({ command: 'echo' }, '/vault');
		lastProc().emit('error', Object.assign(new Error('spawn echo failed'), { code: 'ENOENT' }));

		const result = manager.output(instance.terminalId);
		expect(result.output).toContain('Command failed to start: ENOENT');
		expect(result.error).toBeUndefined();
	});

	it('falls back to the raw message when the error carries no code', () => {
		const instance = manager.create({ command: 'echo' }, '/vault');
		lastProc().emit('error', new Error('posix_spawnp failed'));

		expect(manager.output(instance.terminalId).output).toContain('posix_spawnp failed');
	});

	it('marks the terminal exited instead of leaving it running forever', () => {
		const instance = manager.create({ command: 'echo' }, '/vault');
		lastProc().emit('error', Object.assign(new Error('nope'), { code: 'EACCES' }));

		expect(instance.status).toBe('exited');
		expect(instance.exitCode).toBeNull();
	});

	it('answers a waiter whose command never started', async () => {
		const instance = manager.create({ command: 'sleep 5' }, '/vault');
		const waiter = manager.waitForExit(instance.terminalId);

		lastProc().emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));

		await expect(waiter).resolves.toEqual({ exitCode: null, signal: null });
	});
});
