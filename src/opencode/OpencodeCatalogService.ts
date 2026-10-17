import { detectOpencodeNativeCatalog, type OpencodeCatalogObservation } from './OpencodeCatalog';

import { captureOpencodeProbeSource as capture, opencodeProbeSourceKey as sourceKey } from './OpencodeProbeSource';
export type { OpencodeProbeSource as OpencodeCatalogSource } from './OpencodeProbeSource';
import type { OpencodeProbeSource as OpencodeCatalogSource } from './OpencodeProbeSource';

export interface OpencodeCatalogSnapshot {
  loading: boolean;
  observation: OpencodeCatalogObservation | null;
  stale: boolean;
  unavailable: boolean;
}

/** Read-only discovery owns its cancellation/publication, never a chat session. */
export class OpencodeCatalogService {
  private key: string | null = null;
  private active: AbortController | null = null;
  private state: OpencodeCatalogSnapshot = {
    loading: false,
    observation: null,
    stale: false,
    unavailable: false,
  };

  constructor(private readonly read = detectOpencodeNativeCatalog) {}

  getSnapshot(): Readonly<OpencodeCatalogSnapshot> {
    return { ...this.state };
  }

  setSource(source: OpencodeCatalogSource): void {
    const key = sourceKey(capture(source));
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    this.state = { ...this.state, stale: this.state.observation !== null, unavailable: false };
  }

  cancel(): void {
    const active = this.active;
    this.active = null;
    this.state = { ...this.state, loading: false };
    active?.abort();
  }

  async refresh(source: OpencodeCatalogSource): Promise<boolean> {
    const captured = capture(source);
    this.setSource(captured);
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    this.state = { ...this.state, loading: true, unavailable: false };
    let onAbort: () => void = () => {};
    const cancelled = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const observation = await Promise.race([
        cancelled,
        this.read(captured.cliPath, captured.cwd, {
          env: captured.env,
          signal: controller.signal,
        }),
      ]);
      if (this.active !== controller || !observation) return false;
      if (sourceKey(capture(source)) !== this.key) {
        this.setSource(source);
        return false;
      }
      // A refusal is evidence too. Discarding it would restore the exact lie this stage
      // removes: the panel would fall back to "did not answer" and the reader would lose
      // the one thing the server actually said. Only a genuinely unobserved read marks the
      // snapshot unavailable.
      this.state =
        observation.status === 'unavailable'
          ? { ...this.state, loading: false, unavailable: true, stale: this.state.observation !== null }
          : { loading: false, observation, stale: false, unavailable: false };
      this.active = null;
      return true;
    } catch {
      if (this.active !== controller) return false;
      if (sourceKey(capture(source)) !== this.key) {
        this.setSource(source);
        return false;
      }
      this.active = null;
      this.state = { ...this.state, loading: false, unavailable: true, stale: this.state.observation !== null };
      return true;
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
