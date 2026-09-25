import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

		it('answers both waiters with SIGTERM when the shared deadline expires', async () => {
			vi.useFakeTimers();
			const localManager = new TerminalManager({ timeoutMs: 1000, maxOutputBytes: 1000 });
			const instance = localManager.create({ command: 'sleep 5' }, '/vault');
			const first = localManager.waitForExit(instance.terminalId);
			const second = localManager.waitForExit(instance.terminalId);

			vi.advanceTimersByTime(1500);

			await expect(first).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
			await expect(second).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
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

	describe('dispose', () => {
		it('cleans up all terminals', () => {
			manager.create({ command: 'echo 1' }, '/vault');
			manager.create({ command: 'echo 2' }, '/vault');

			manager.dispose();
			expect(manager.getAll()).toHaveLength(0);
		});
	});
});
