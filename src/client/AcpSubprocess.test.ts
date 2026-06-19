import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { AcpSubprocess, type AcpSubprocessLaunchSpec } from './AcpSubprocess';
import * as child_process from 'child_process';

vi.mock('child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

describe('AcpSubprocess', () => {
  let launchSpec: AcpSubprocessLaunchSpec;
  let mockProc: any;
  let mockStdin: any;
  let mockStdout: any;
  let mockStderr: any;

  beforeEach(() => {
    vi.clearAllMocks();

    launchSpec = {
      args: ['--version'],
      command: 'test-command',
      cwd: '/test/cwd',
    };

    mockStdin = new EventEmitter();
    mockStdout = new EventEmitter();
    mockStderr = new EventEmitter();

    mockProc = new EventEmitter();
    mockProc.stdin = mockStdin;
    mockProc.stdout = mockStdout;
    mockProc.stderr = mockStderr;
    mockProc.exitCode = null;
    mockProc.killed = false;
    mockProc.kill = vi.fn();
    // Use the actual removeAllListeners implementation from EventEmitter
    mockProc.removeAllListeners = vi.fn(function(this: any, event?: string | symbol) {
      return EventEmitter.prototype.removeAllListeners.call(this, event);
    });

    vi.mocked(child_process.spawn).mockReturnValue(mockProc as any);
  });

  it('start() spawns process with correct args', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();

    expect(child_process.spawn).toHaveBeenCalledWith('test-command', ['--version'], {
      cwd: '/test/cwd',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
  });

  it('start() multiple times only spawns once', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();
    subprocess.start();

    expect(child_process.spawn).toHaveBeenCalledTimes(1);
  });

  it('stdin/stdout getters return stream or null', () => {
    const subprocess = new AcpSubprocess(launchSpec);

    // Before start
    expect(subprocess.stdin).toBeNull();
    expect(subprocess.stdout).toBeNull();

    // After start
    subprocess.start();
    expect(subprocess.stdin).toBe(mockStdin);
    expect(subprocess.stdout).toBe(mockStdout);
  });

  it('isAlive() returns correct state', () => {
    const subprocess = new AcpSubprocess(launchSpec);

    // Not started
    expect(subprocess.isAlive()).toBe(false);

    subprocess.start();

    // Running
    expect(subprocess.isAlive()).toBe(true);

    // Killed
    mockProc.killed = true;
    expect(subprocess.isAlive()).toBe(false);

    // Exited
    mockProc.killed = false;
    mockProc.exitCode = 0;
    expect(subprocess.isAlive()).toBe(false);
  });

  it('onClose() listener receives undefined on normal exit', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    const closeListener = vi.fn();

    subprocess.onClose(closeListener);
    subprocess.start();

    mockProc.emit('exit', 0, null);
    expect(closeListener).toHaveBeenCalledWith(undefined);
  });

  it('onClose() listener receives exit error on non-zero exit', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    const closeListener = vi.fn();

    subprocess.onClose(closeListener);
    subprocess.start();

    mockProc.emit('exit', 1, null);
    expect(closeListener).toHaveBeenCalledTimes(1);
    const errorArg = closeListener.mock.calls[0][0];
    expect(errorArg).toBeInstanceOf(Error);
    expect(errorArg.message).toBe('ACP process exited (code=1, signal=null)');
  });

  it('onClose() can be unsubscribed', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    const closeListener = vi.fn();

    const unsubscribe = subprocess.onClose(closeListener);
    subprocess.start();

    unsubscribe();
    mockProc.emit('exit', 0, null);

    expect(closeListener).not.toHaveBeenCalled();
  });

  it('shutdown() kills process gracefully', async () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();

    const shutdownPromise = subprocess.shutdown();

    expect(mockProc.kill).toHaveBeenCalled();

    // Simulate process closing
    mockProc.emit('close');

    await shutdownPromise;
    expect(subprocess.isAlive()).toBe(false);
  });

  it('shutdown() handles kill throwing gracefully', async () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();


    mockProc.kill.mockImplementation((signal?: string) => {
      // Dont emit close on SIGTERM; simulate a stuck process.
      if (signal === 'SIGKILL') {
        mockProc.emit('close');
      }
    });

    const shutdownPromise = subprocess.shutdown();

    await shutdownPromise;
    expect(mockProc.removeAllListeners).toHaveBeenCalled();
  });

  it('shutdown() is a no-op if process not started or already exited', async () => {
    const subprocess = new AcpSubprocess(launchSpec);

    // Not started
    await subprocess.shutdown();

    subprocess.start();
    mockProc.exitCode = 0; // Simulate exited

    await subprocess.shutdown();
    expect(mockProc.kill).not.toHaveBeenCalled();
  });

  it('getStderrSnapshot() captures stderr', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();

    mockStderr.emit('data', 'error line 1\n');
    mockStderr.emit('data', Buffer.from('error line 2\n'));

    expect(subprocess.getStderrSnapshot()).toBe('error line 1\nerror line 2');
  });

  it('getStderrSnapshot() limits buffer size', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();

    const largeChunk = 'a'.repeat(5000);
    mockStderr.emit('data', largeChunk);
    mockStderr.emit('data', largeChunk); // 10000 chars total

    const snapshot = subprocess.getStderrSnapshot();
    expect(snapshot.length).toBe(8000); // STDERR_BUFFER_LIMIT is 8000
    expect(snapshot).toBe('a'.repeat(8000));
  });

  it('onClose() listener ignores exceptions in listeners', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    const badListener = vi.fn().mockImplementation(() => { throw new Error('bad'); });
    const goodListener = vi.fn();

    subprocess.onClose(badListener);
    subprocess.onClose(goodListener);
    subprocess.start();

    // emit exit to trigger notifyClose
    expect(() => {
      mockProc.emit('exit', 0, null);
    }).not.toThrow();

    expect(badListener).toHaveBeenCalled();
    expect(goodListener).toHaveBeenCalled();
  });

  it('ignores exceptions from onData for error', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const subprocess = new AcpSubprocess(launchSpec);
      subprocess.start();

      const errorEvent = new Error('stdin write error');
      mockStdin.emit('error', errorEvent);

      expect(consoleSpy).toHaveBeenCalledWith('[co-ober] stdin:', errorEvent);
      consoleSpy.mockRestore();
  });

  it('onClose() listener receives process error event', () => {
    const subprocess = new AcpSubprocess(launchSpec);
    const closeListener = vi.fn();

    subprocess.onClose(closeListener);
    subprocess.start();

    const error = new Error('Process spawn error');
    mockProc.emit('error', error);

    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(closeListener).toHaveBeenCalledWith(error);
  });

  it('shutdown resolves on timeout', async () => {
    vi.useFakeTimers();
    const subprocess = new AcpSubprocess(launchSpec);
    subprocess.start();

    mockProc.kill.mockImplementation((signal?: string) => {
      // Dont emit close on SIGTERM; simulate a stuck process.
      if (signal === 'SIGKILL') {
        mockProc.emit('close');
      }
    });

    const shutdownPromise = subprocess.shutdown();

    vi.runAllTimers();
    await shutdownPromise;

    expect(mockProc.removeAllListeners).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
