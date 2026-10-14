import { captureOpencodeProbeSource, opencodeProbeSourceKey, type OpencodeProbeSource } from './OpencodeProbeSource';

/**
 * The owned lifecycle for one opt-in native probe — the shape `OpencodeCatalogService`
 * gave the catalog read and `OpencodeDiagnosticsService` gave the diagnostics run, applied
 * to the three probes that spend a real model turn.
 *
 * Those three held their running flag and last reading as fields on the settings tab, so
 * a probe could not be cancelled, could not be fenced when the CLI path changed underneath
 * it, and painted a late result after the reader had closed the panel. Here the owner
 * holds all three facts and answers one question: is this reading still about the source
 * the reader is looking at?
 *
 * A reading is kept when the source changes, and marked stale rather than dropped: the
 * reader saw it, so blanking it would be its own kind of lie. Only an explicit re-run
 * clears the mark. This is the same rule the catalog already keeps.
 */

export interface OpencodeProbeSnapshot<T> {
  running: boolean;
  reading: T | null;
  stale: boolean;
}

/**
 * The reader shape every native probe already satisfies once a signal is threaded into it:
 * a captured source, an abort signal, and an observation that is never thrown.
 */
export type OpencodeProbeReader<T> = (
  cliPath: string,
  cwd: string,
  deps: { env: NodeJS.ProcessEnv; signal: AbortSignal },
) => Promise<T>;

/**
 * Owns one probe's cancellation and publication. Cancellation never reaches the chat: it
 * stops the probe publishing and stops the next stage, and nothing more. `run` resolves
 * `false` whenever the reading it produced may not be shown — cancelled, superseded, or
 * belonging to a source that has since moved.
 */
export class OpencodeProbeService<T> {
  private key: string | null = null;
  private active: AbortController | null = null;
  private state: OpencodeProbeSnapshot<T> = { running: false, reading: null, stale: false };

  constructor(private readonly read: OpencodeProbeReader<T>) {}

  getSnapshot(): Readonly<OpencodeProbeSnapshot<T>> {
    return { ...this.state };
  }

  setSource(source: OpencodeProbeSource): void {
    const key = opencodeProbeSourceKey(captureOpencodeProbeSource(source));
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    // Keep whatever the reader already saw, but stop letting it speak for the new source.
    this.state = { ...this.state, stale: this.state.reading !== null };
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    this.state = { ...this.state, running: false };
    active?.abort();
  }

  async run(source: OpencodeProbeSource): Promise<boolean> {
    const captured = captureOpencodeProbeSource(source);
    this.setSource(captured);
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    this.state = { ...this.state, running: true };
    let onAbort: () => void = () => {};
    // Cancellation settles on its own rather than waiting for a reader that ignores the
    // signal it was handed; a late answer can no longer publish because `this.active` has
    // already moved on by the time it arrives.
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const reading = await Promise.race([
        cancelled,
        this.read(captured.cliPath, captured.cwd, { env: captured.env, signal: controller.signal }),
      ]);
      if (this.active !== controller || reading === null) return false;
      // The source may have moved during the await. A reading captured from the old CLI
      // path must not be published under the new one.
      if (opencodeProbeSourceKey(captureOpencodeProbeSource(source)) !== this.key) {
        this.setSource(source);
        return false;
      }
      this.active = null;
      this.state = { running: false, reading, stale: false };
      return true;
    } catch {
      if (this.active !== controller) return false;
      if (opencodeProbeSourceKey(captureOpencodeProbeSource(source)) !== this.key) {
        this.setSource(source);
        return false;
      }
      this.active = null;
      this.state = { ...this.state, running: false };
      return true;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
