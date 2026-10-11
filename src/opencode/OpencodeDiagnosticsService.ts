import { captureOpencodeProbeSource, opencodeProbeSourceKey, type OpencodeProbeSource } from './OpencodeProbeSource';

export interface DiagnosticResult {
  label: string;
  ok: boolean;
  detail: string;
}

export interface OpencodeDiagnosticContext {
  source: Required<OpencodeProbeSource>;
  signal: AbortSignal;
  /** Call before each stage and after awaits, especially before runtime side effects. */
  checkCurrent(): void;
}

interface DiagnosticsSnapshot {
  running: boolean;
  results: readonly DiagnosticResult[];
  failed: boolean;
}

/** Owns diagnostic publication; cancellation never disconnects the shared chat client. */
export class OpencodeDiagnosticsService {
  private key: string | null = null;
  private active: AbortController | null = null;
  private state: DiagnosticsSnapshot = { running: false, results: [], failed: false };

  getSnapshot(): Readonly<DiagnosticsSnapshot> {
    return { ...this.state, results: [...this.state.results] };
  }

  setSource(source: OpencodeProbeSource): void {
    const key = opencodeProbeSourceKey(captureOpencodeProbeSource(source));
    if (key === this.key) return;
    this.clear();
    this.key = key;
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    this.state = { ...this.state, running: false };
    active?.abort();
  }

  clear(): void {
    this.cancel();
    this.state = { running: false, results: [], failed: false };
  }

  async run(
    source: OpencodeProbeSource,
    collect: (context: OpencodeDiagnosticContext) => Promise<DiagnosticResult[]>,
  ): Promise<boolean> {
    const captured = captureOpencodeProbeSource(source);
    this.setSource(captured);
    this.clear();
    const controller = new AbortController();
    this.active = controller;
    this.state = { running: true, results: [], failed: false };
    const checkCurrent = (): void => {
      controller.signal.throwIfAborted();
      if (opencodeProbeSourceKey(captureOpencodeProbeSource(source)) !== this.key) this.setSource(source);
      controller.signal.throwIfAborted();
    };
    let onAbort: () => void = () => {};
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const results = await Promise.race([
        cancelled,
        collect({ source: captured, signal: controller.signal, checkCurrent }),
      ]);
      if (this.active !== controller || results === null) return false;
      checkCurrent();
      this.active = null;
      this.state = { running: false, results, failed: false };
      return true;
    } catch {
      if (this.active !== controller) return false;
      // A failure from an obsolete environment is not a failure of the new source.
      try {
        checkCurrent();
      } catch {
        return false;
      }
      this.active = null;
      this.state = { running: false, results: [], failed: true };
      return true;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
