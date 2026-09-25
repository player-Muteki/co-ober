import { spawn, type ChildProcess } from 'child_process';
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'timers';
import { AcpProcessExitError } from './AcpErrors';
const SIGKILL_TIMEOUT_MS = 3_000;
const STDERR_BUFFER_LIMIT = 8_000;
export interface AcpSubprocessLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
}
type CloseListener = (error?: Error) => void;
export class AcpSubprocess {
  private proc: ChildProcess | null = null;
  private stderrBuffer = '';
  private readonly closeListeners = new Set<CloseListener>();
  private closed = false;
  constructor(private readonly launchSpec: AcpSubprocessLaunchSpec) {}
  get stdin(): NodeJS.WritableStream | null {
    return this.proc?.stdin ?? null;
  }
  get stdout(): NodeJS.ReadableStream | null {
    return this.proc?.stdout ?? null;
  }
  start(): void {
    if (this.proc) return;
    this.closed = false;
    const proc = spawn(this.launchSpec.command, this.launchSpec.args, {
      cwd: this.launchSpec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    proc.stdin?.on('error', (e: unknown) => console.error('[co-ober] stdin:', e));
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-STDERR_BUFFER_LIMIT);
    });
    proc.on('error', (error) => this.notifyClose(error));
    // Tear down on 'close', not 'exit': exit fires while stdout may still
    // hold buffered frames, and tearing down then drops the agent's last
    // responses. 'close' means both pipes have drained.
    proc.on('close', (code, signal) => {
      const exitError = code === 0 && signal === null ? undefined : new AcpProcessExitError(code, signal);
      this.notifyClose(exitError);
    });
    this.proc = proc;
  }
  isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }
  getStderrSnapshot(): string {
    return this.stderrBuffer.trim();
  }
  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  async shutdown(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null || this.closed) {
      this.proc = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const proc = this.proc!;
      let done = false;
      let timeout: ReturnType<typeof nodeSetTimeout> | null = null;
      const onDone = () => {
        if (done) return;
        done = true;
        if (timeout) nodeClearTimeout(timeout);
        proc.removeAllListeners();
        resolve();
      };
      proc.once('close', onDone);
      try {
        proc.kill();
      } catch {
        onDone();
      }
      timeout = nodeSetTimeout(() => {
        if (!done) proc.kill('SIGKILL');
        // onDone will be called by the existing 'close' listener once the process exits
      }, SIGKILL_TIMEOUT_MS);
    });
    this.closed = true;
    this.proc = null;
  }
  private notifyClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.proc = null;
    for (const listener of this.closeListeners) {
      try {
        listener(error);
      } catch {
        /* ignore */
      }
    }
  }
}
