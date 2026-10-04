import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';

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

export type OpencodeCatalogStatus = 'observed' | 'unavailable';

export interface OpencodeCatalogObservation {
  status: OpencodeCatalogStatus;
  models: OpencodeNativeModel[];
  commands: OpencodeNativeCommand[];
  agents: OpencodeNativeAgent[];
}

export interface OpencodeCatalogDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
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

async function defaultRequest(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OpenCode serve responded ${response.status}`);
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
  if (!cliPath?.trim()) return empty;

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? defaultRequest;
  const timeoutMs = deps.timeoutMs ?? SERVER_TIMEOUT_MS;

  const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
  let child: ChildProcess;
  try {
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return empty;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const origin = await waitForServerUrl(child, controller);
    const suffix = `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
    const settled = await Promise.allSettled([
      requestFn(`${origin}/api/model?${suffix}`, controller.signal),
      requestFn(`${origin}/api/command?${suffix}`, controller.signal),
      requestFn(`${origin}/api/agent?${suffix}`, controller.signal),
    ]);
    // A route that answered is read honestly; a route that failed contributes an
    // empty list. `unavailable` is reserved for the whole probe failing — the
    // server never came up, or every catalog read failed — so a partial read is
    // never laundered into "the install has nothing" nor an unreachable install
    // into "the install is empty".
    if (settled.every((entry) => entry.status === 'rejected')) return empty;
    const models = settled[0].status === 'fulfilled' ? mapNativeModels(settled[0].value) : [];
    const commands = settled[1].status === 'fulfilled' ? mapNativeCommands(settled[1].value) : [];
    const agents = settled[2].status === 'fulfilled' ? mapNativeAgents(settled[2].value) : [];
    return { status: 'observed', models, commands, agents };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    controller.abort();
    child.kill('SIGKILL');
  }
}

function waitForServerUrl(child: ChildProcess, controller: AbortController): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error?: Error, origin?: string): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(origin!);
    };
    const onAbort = (): void => finish(new Error('OpenCode serve startup aborted.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(new Error('Could not start OpenCode serve.')));
    child.on('close', () => finish(new Error('OpenCode serve closed before readiness.')));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString('utf-8');
      if (output.length > SERVER_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve readiness output exceeded the limit.'));
        return;
      }
      const origin = parseOpencodeServerUrl(output);
      if (origin) finish(undefined, origin);
    });
  });
}
