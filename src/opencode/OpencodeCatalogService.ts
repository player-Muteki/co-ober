import { detectOpencodeNativeCatalog, type OpencodeCatalogObservation } from './OpencodeCatalog';

export interface OpencodeCatalogSource {
  cliPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface OpencodeCatalogSnapshot {
  loading: boolean;
  observation: OpencodeCatalogObservation | null;
  stale: boolean;
  unavailable: boolean;
}

function capture(source: OpencodeCatalogSource): Required<OpencodeCatalogSource> {
  return { cliPath: source.cliPath.trim(), cwd: source.cwd, env: { ...(source.env ?? process.env) } };
}

function sourceKey(source: Required<OpencodeCatalogSource>): string {
  // Private and ephemeral: never persist or display environment values.
  return JSON.stringify([
    source.cliPath,
    source.cwd,
    Object.keys(source.env)
      .sort()
      .map((key) => [key, source.env[key]]),
  ]);
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
      this.state =
        observation.status === 'observed'
          ? { loading: false, observation, stale: false, unavailable: false }
          : { ...this.state, loading: false, unavailable: true, stale: this.state.observation !== null };
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
