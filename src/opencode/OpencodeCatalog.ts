import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';
import {
  newOpencodeServePassword,
  opencodeServeAuthHeaders,
  opencodeServeEnvironment,
  OpencodeServeHttpError,
  isOpencodeServeAuthenticationFailure,
} from './OpencodeServeAuth';

/**
 * The native OpenCode catalog read over the loopback `opencode serve` HTTP API.
 * This channel is separate from the ACP `config_option_update` lists the runtime
 * metadata row reads: ACP answers "what does the connected session offer", while
 * a brief local server answers "what does the native OpenCode install report".
 * Both are observations of real signals; neither certifies the other. The read is
 * read-only, loopback-only, and torn down as soon as the three lists are gathered.
 */

const SERVER_TIMEOUT_MS = 8_000;
const SERVER_OUTPUT_MAX_CHARS = 8_000;

export interface OpencodeNativeModel {
  modelId: string;
  name: string;
  context: number | undefined;
}

export interface OpencodeNativeCommand {
  name: string;
  description: string | undefined;
}

export interface OpencodeNativeAgent {
  id: string;
  description: string | undefined;
}

export type OpencodeCatalogStatus = 'observed' | 'unauthorized' | 'unavailable';

export interface OpencodeCatalogObservation {
  status: OpencodeCatalogStatus;
  models: OpencodeNativeModel[];
  commands: OpencodeNativeCommand[];
  agents: OpencodeNativeAgent[];
  /** Per-route evidence; absent on older callers' observations. */
  routes?: Record<'models' | 'commands' | 'agents', OpencodeCatalogStatus>;
}

/**
 * What one route actually established. A route that answered with a refusal we can name
 * is not a route that "did not answer": the two send the reader to different places, so
 * they must not share a status. Anything else — a connection failure, a malformed body,
 * an HTML catch-all — stays `unavailable`, because those genuinely leave the cause
 * unobserved.
 */
export function classifyCatalogRoute(entry: PromiseSettledResult<unknown>): OpencodeCatalogStatus {
  if (entry.status === 'fulfilled'
    && entry.value !== null && typeof entry.value === 'object'
    && Array.isArray((entry.value as { data?: unknown }).data)) {
    return 'observed';
  }
  if (entry.status === 'rejected' && isOpencodeServeAuthenticationFailure(entry.reason)) return 'unauthorized';
  return 'unavailable';
}

export interface OpencodeCatalogDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Pull the server URL out of `opencode serve` startup output. This CLI prints a
 * plain-text readiness line ("opencode server listening on http://127.0.0.1:PORT")
 * rather than the JSON a `--stdio` variant would, so the first `http` URL is taken
 * from anywhere in the output. The address is only trusted on the http scheme and
 * loopback host with no embedded credentials — a server that announced some other
 * origin is refused rather than contacted, since reading a catalog off an
 * unverified host is exactly the untrusted channel this probe must never open.
 */
export function parseOpencodeServerUrl(output: string): string | undefined {
  const match = output.match(/https?:\/\/[^\s]+/u);
  if (!match) return undefined;
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || url.username || url.password) return undefined;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
  return url.origin;
}

function readData(payload: unknown): Record<string, unknown>[] {
  if (payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data.filter(
      (row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row),
    );
  }
  return [];
}

function contextLimit(row: Record<string, unknown>): number | undefined {
  const limit = row.limit;
  if (limit !== null && typeof limit === 'object' && !Array.isArray(limit)) {
    const context = (limit as Record<string, unknown>).context;
    if (typeof context === 'number') return context;
  }
  return undefined;
}

/**
 * Map the raw `/api/model` rows to catalog entries. Only enabled models are kept:
 * `enabled` is the field the native install uses to state that a model is usable,
 * so an absent or false value is a model the install did not offer, not one to
 * round up into the list. Both id and providerID must be strings for the pair to
 * name a selectable model; a row missing either is dropped rather than guessed at.
 */
export function mapNativeModels(payload: unknown): OpencodeNativeModel[] {
  const models: OpencodeNativeModel[] = [];
  for (const row of readData(payload)) {
    if (row.enabled !== true) continue;
    if (typeof row.id !== 'string' || typeof row.providerID !== 'string') continue;
    models.push({
      modelId: `${row.providerID}/${row.id}`,
      name: typeof row.name === 'string' ? `${row.providerID}/${row.name}` : row.providerID,
      context: contextLimit(row),
    });
  }
  return models;
}

/** Map the raw `/api/command` rows. A command must carry a string name to be listed. */
export function mapNativeCommands(payload: unknown): OpencodeNativeCommand[] {
  const commands: OpencodeNativeCommand[] = [];
  for (const row of readData(payload)) {
    if (typeof row.name !== 'string') continue;
    commands.push({ name: row.name, description: typeof row.description === 'string' ? row.description : undefined });
  }
  return commands;
}

/** Map the raw `/api/agent` rows. An agent must carry a string id to be listed. */
export function mapNativeAgents(payload: unknown): OpencodeNativeAgent[] {
  const agents: OpencodeNativeAgent[] = [];
  for (const row of readData(payload)) {
    if (typeof row.id !== 'string') continue;
    agents.push({ id: row.id, description: typeof row.description === 'string' ? row.description : undefined });
  }
  return agents;
}

async function defaultRequest(url: string, password: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: opencodeServeAuthHeaders(password), signal });
  if (!response.ok) throw new OpencodeServeHttpError(response.status, `OpenCode serve responded ${response.status}`);
  return response.json();
}

/**
 * Ask the native OpenCode install what it can do, via a brief loopback `opencode
 * serve`. This is observation only: it never throws, and an install that is
 * missing, hangs before announcing an address, or whose catalog requests all fail
 * comes back `unavailable` rather than an empty-but-confident catalog or a guessed
 * one. Later work that turns on a native-only capability gates on this reading
 * actually observing the capability, not on a config toggle asserting it.
 */
export async function detectOpencodeNativeCatalog(
  cliPath: string,
  cwd: string,
  deps: OpencodeCatalogDeps = {},
): Promise<OpencodeCatalogObservation> {
  const empty: OpencodeCatalogObservation = { status: 'unavailable', models: [], commands: [], agents: [] };
  if (!cliPath?.trim() || deps.signal?.aborted) return empty;

  // The read is authenticated from the start: this plugin chooses the credential, hands it
  // to the child it spawned, and presents it on every request. A v2 install refuses an
  // unauthenticated read outright, so a probe that does not do this reports a live,
  // fully-stocked server as one that "did not answer".
  const password = newOpencodeServePassword();
  const env = opencodeServeEnvironment(deps.env ?? process.env, password);
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? ((url, signal) => defaultRequest(url, password, signal));
  const timeoutMs = deps.timeoutMs ?? SERVER_TIMEOUT_MS;

  let child: ChildProcess;
  try {
    const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return empty;
  }

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  let onAbort: () => void = () => {};
  const aborted = new Promise<OpencodeCatalogObservation>((resolve) => {
    onAbort = () => resolve(empty);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(abort, timeoutMs);
  deps.signal?.addEventListener('abort', abort, { once: true });
  child.on('error', abort);
  const onProcessClose = (): void => {
    child.removeListener('error', abort);
    abort();
  };
  child.once('close', onProcessClose);
  if (deps.signal?.aborted) abort();

  const read = async (): Promise<OpencodeCatalogObservation> => {
    const origin = await waitForServerUrl(child, controller);
    const suffix = `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
    const settled = await Promise.allSettled([
      requestFn(`${origin}/api/model?${suffix}`, controller.signal),
      requestFn(`${origin}/api/command?${suffix}`, controller.signal),
      requestFn(`${origin}/api/agent?${suffix}`, controller.signal),
    ]);
    // HTTP success is not catalog evidence: HTML catch-alls and other JSON
    // dialects must not become a confidently empty roster.
    const statuses = settled.map(classifyCatalogRoute);
    const routes: NonNullable<OpencodeCatalogObservation['routes']> = {
      models: statuses[0],
      commands: statuses[1],
      agents: statuses[2],
    };
    // A route that was not observed contributes nothing. This is why a refusal can never
    // leak into the lists: only an `observed` route's payload is mapped at all.
    const payloads = settled.map((entry, i) => (statuses[i] === 'observed' && entry.status === 'fulfilled' ? entry.value : undefined));
    if (statuses.every((status) => status === 'unauthorized')) {
      // Every route was refused the same way, so the refusal is the finding — not a server
      // that failed to answer, and emphatically not a server with nothing to list.
      return { status: 'unauthorized', models: [], commands: [], agents: [], routes };
    }
    if (payloads.every((payload) => payload === undefined)) return { ...empty, routes };
    return {
      status: 'observed', routes,
      models: mapNativeModels(payloads[0]),
      commands: mapNativeCommands(payloads[1]),
      agents: mapNativeAgents(payloads[2]),
    };
  };
  try {
    // The deadline belongs to this operation, not to the injected transport's
    // willingness to honour AbortSignal. Late results cannot publish success.
    return await Promise.race([aborted, read()]);
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
    controller.abort();
    controller.signal.removeEventListener('abort', onAbort);
    // spawn/kill can report an asynchronous error after cancellation. Keep the
    // harmless error sink until close so shutdown cannot create an unhandled event.
    try { child.kill('SIGKILL'); } catch { /* The process may already be gone. */ }
  }
}

function waitForServerUrl(child: ChildProcess, controller: AbortController): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (controller.signal.aborted) { reject(new Error('OpenCode serve startup aborted.')); return; }
    let output = '';
    let settled = false;
    const finish = (error?: Error, origin?: string): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('data', onData);
      if (error) reject(error);
      else resolve(origin!);
    };
    const onAbort = (): void => finish(new Error('OpenCode serve startup aborted.'));
    const onError = (): void => finish(new Error('Could not start OpenCode serve.'));
    const onClose = (): void => finish(new Error('OpenCode serve closed before readiness.'));
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString('utf-8');
      if (output.length > SERVER_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve readiness output exceeded the limit.'));
        return;
      }
      const origin = parseOpencodeServerUrl(output);
      if (origin) finish(undefined, origin);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', onError);
    child.on('close', onClose);
    child.stdout?.on('data', onData);
  });
}
