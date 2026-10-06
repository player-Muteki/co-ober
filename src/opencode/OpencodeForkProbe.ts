import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';
import { parseOpencodeServerUrl } from './OpencodeCatalog';

/**
 * Measure whether the native `opencode serve` kernel can fork a session at a
 * message boundary with the earlier history actually carried into the child —
 * the premise a per-message "fork from here" would render from. The 0.1.33
 * decision declined this because "the protocol has no anchor"; this probe
 * re-checks that against the running install rather than trusting any reference.
 *
 * The wire shapes here are read off the live 1.18.33 install: the JSON API has
 * `POST /api/session/{id}/fork` NOT at all — that route is captured by the
 * server's single-page web UI and answers `200` with `text/html`, so a caller
 * that assumed JSON would fork nothing. The fork that exists is the legacy
 * `POST /session/{id}/fork?directory=<cwd>` with a `{ messageID }` body, whose
 * response is the child Session object directly. Whether that child actually
 * carries the source rows is exactly what this probe classifies, and `anchored`
 * is claimed only when the child's own readback shows history through the
 * anchor and not beyond it. No model answer is waited for or required: two
 * admitted prompts put two user rows on the transcript, which is enough to
 * distinguish an empty child, a whole copy, and a true truncation.
 */

const FORK_TIMEOUT_MS = 20_000;
const STARTUP_OUTPUT_MAX_CHARS = 8_000;
const PROBE_TEXT_A = 'Reply with exactly the word ONE and nothing else.';
const PROBE_TEXT_B = 'Reply with exactly the word TWO and nothing else.';

export type OpencodeForkStatus = 'anchored' | 'copied-whole' | 'child-empty' | 'unexpected' | 'unavailable';

export type OpencodeForkRouteShape = 'json' | 'html' | 'error';

export interface OpencodeForkObservation {
  status: OpencodeForkStatus;
  parentRows: number;
  childRows: number;
  apiForkRoute: OpencodeForkRouteShape;
}

export interface OpencodeForkDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal) => Promise<unknown>;
  requestRaw?: (url: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal) => Promise<{ status: number; contentType: string; payload: unknown }>;
  timeoutMs?: number;
  pollMs?: number;
  pollAttempts?: number;
}

const DEFAULT_FORK: OpencodeForkObservation = { status: 'unavailable', parentRows: 0, childRows: 0, apiForkRoute: 'error' };

export interface ForkRow {
  id: string;
  type: string;
}

/**
 * Classify the `/api/session/{id}/fork` answer by its transport facts, not its
 * status code alone: a 200 carrying `text/html` is the web UI's catch-all, not a
 * fork. Only a JSON payload naming a child session id counts as `json`.
 */
export function forkRouteShape(status: number, contentType: string, payload: unknown): OpencodeForkRouteShape {
  if (/html/u.test(contentType)) return 'html';
  if (status >= 200 && status < 300 && contentType.includes('json')) {
    const data = (payload as { data?: unknown } | undefined)?.data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).id === 'string') {
      return 'json';
    }
  }
  return 'error';
}

/**
 * Decide what the forked child holds, by comparing id sequences oldest-first.
 * `anchored` requires the child to be exactly the source prefix ending at the
 * anchor — the shape a "fork from here" needs. Anything else is said plainly:
 * an empty child is not a truncation, and a full copy ignored the anchor.
 */
export function classifyForkCopy(parent: ForkRow[], child: ForkRow[], anchorId: string): OpencodeForkStatus {
  if (child.length === 0) return 'child-empty';
  const anchorIndex = parent.findIndex((row) => row.id === anchorId);
  if (anchorIndex === -1) return 'unexpected';
  if (child.length === parent.length && child.every((row, i) => row.id === parent[i].id)) return 'copied-whole';
  if (child.length === anchorIndex + 1 && child.every((row, i) => row.id === parent[i].id)) return 'anchored';
  return 'unexpected';
}

function isAdmitted(payload: unknown): boolean {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const data = (payload as { data?: unknown }).data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      return typeof d.id === 'string' || typeof d.admittedSeq === 'number';
    }
  }
  return false;
}

function childIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const direct = (payload as Record<string, unknown>).id;
  if (typeof direct === 'string' && direct) return direct;
  const data = (payload as { data?: unknown }).data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

function rowsFrom(payload: unknown): ForkRow[] {
  const data = (payload as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const rows: ForkRow[] = [];
  for (const row of [...data].reverse()) {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
      const r = row as Record<string, unknown>;
      if (typeof r.id === 'string' && typeof r.type === 'string') rows.push({ id: r.id, type: r.type });
    }
  }
  return rows;
}

function randomProbeId(): string {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

async function defaultRequest(
  url: string,
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { 'content-type': 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`OpenCode serve responded ${response.status}`);
  return response.json();
}

async function defaultRequestRaw(
  url: string,
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
): Promise<{ status: number; contentType: string; payload: unknown }> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { 'content-type': 'application/json' },
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { status: response.status, contentType, payload };
}

/**
 * Drive one throwaway session against the native install and classify what its
 * forked child holds. This never throws: a missing CLI, a server that never
 * names an address, a session that admits no rows, or a fork whose child is
 * unreadable all degrade to an honest `unavailable`. The two throwaway prompts
 * are interrupted and the server SIGKILLed in a `finally`, so neither a running
 * turn nor a process leaks.
 */
export async function detectOpencodeNativeCheckpointFork(
  cliPath: string,
  cwd: string,
  deps: OpencodeForkDeps = {},
): Promise<OpencodeForkObservation> {
  if (!cliPath?.trim()) return DEFAULT_FORK;

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? defaultRequest;
  const rawFn = deps.requestRaw ?? defaultRequestRaw;
  const timeoutMs = deps.timeoutMs ?? FORK_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1_000;
  const pollAttempts = deps.pollAttempts ?? 8;

  const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
  let child: ChildProcess;
  try {
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return DEFAULT_FORK;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    child.kill('SIGKILL');
  }, timeoutMs);

  let sessionId: string | null = null;
  let forkedId: string | null = null;
  let origin: string | undefined;
  try {
    origin = await waitForServerUrl(child, controller);
    const created = await requestFn(
      `${origin}/api/session`,
      { method: 'POST', body: { location: { directory: cwd }, agent: 'build' } },
      controller.signal,
    ) as { data?: { id?: unknown } } | undefined;
    sessionId = typeof created?.data?.id === 'string' ? created.data.id : null;
    if (!sessionId) return DEFAULT_FORK;

    const encoded = encodeURIComponent(sessionId);
    // Two admitted prompts put at least two user rows on the transcript, which
    // is what separates an anchored copy from a whole one. Neither answer is
    // needed, so no turn is ever waited for.
    const firstId = `msg_${randomProbeId()}`;
    const admittedA = await requestFn(
      `${origin}/api/session/${encoded}/prompt`,
      { method: 'POST', body: { id: firstId, prompt: { text: PROBE_TEXT_A } } },
      controller.signal,
    );
    if (!isAdmitted(admittedA)) return DEFAULT_FORK;
    const admittedB = await requestFn(
      `${origin}/api/session/${encoded}/prompt`,
      { method: 'POST', body: { id: `msg_${randomProbeId()}`, prompt: { text: PROBE_TEXT_B } } },
      controller.signal,
    );
    if (!isAdmitted(admittedB)) return DEFAULT_FORK;

    let parent: ForkRow[] = [];
    let anchorId = firstId;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (controller.signal.aborted) break;
      const page = await requestFn(
        `${origin}/api/session/${encoded}/message?order=desc&limit=50`,
        undefined,
        controller.signal,
      );
      parent = rowsFrom(page);
      const users = parent.filter((row) => row.type === 'user');
      if (users.length >= 2) {
        anchorId = users[0].id;
        break;
      }
      await sleep(pollMs);
    }
    const users = parent.filter((row) => row.type === 'user');
    if (users.length < 2) return DEFAULT_FORK;

    // Stop the throwaway turns before forking so the measurement watches the
    // transcript the kernel already holds, not one still growing under it.
    try {
      await requestFn(`${origin}/api/session/${encoded}/interrupt?resume=false`, { method: 'POST' }, controller.signal);
    } catch { /* teardown must not mask the reading */ }

    // The reference claim to test: a v2 JSON fork route. The running kernel
    // answers this with its web UI — record that honestly instead of forking on it.
    const apiRoute = await rawFn(
      `${origin}/api/session/${encoded}/fork`,
      { method: 'POST', body: { before: anchorId } },
      controller.signal,
    ).catch(() => ({ status: 0, contentType: '', payload: undefined }));
    const apiForkRoute = forkRouteShape(apiRoute.status, apiRoute.contentType, apiRoute.payload);

    const forked = await requestFn(
      `${origin}/session/${encoded}/fork?directory=${encodeURIComponent(cwd)}`,
      { method: 'POST', body: { messageID: anchorId } },
      controller.signal,
    );
    forkedId = childIdOf(forked);
    if (!forkedId) return DEFAULT_FORK;

    const childPage = await requestFn(
      `${origin}/api/session/${encodeURIComponent(forkedId)}/message?order=desc&limit=50`,
      undefined,
      controller.signal,
    );
    const childRows = rowsFrom(childPage);
    return {
      status: classifyForkCopy(parent, childRows, anchorId),
      parentRows: parent.length,
      childRows: childRows.length,
      apiForkRoute,
    };
  } catch {
    return DEFAULT_FORK;
  } finally {
    clearTimeout(timer);
    if (sessionId && origin) {
      try {
        await requestFn(`${origin}/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, { method: 'POST' });
      } catch { /* ignore interrupt outcome */ }
      // A forked child that held history would be real user data; here it is at
      // most an empty throwaway, and the probe deletes both it and its source
      // session so the measurement leaves nothing behind to discover later.
      if (forkedId) {
        try {
          await requestFn(`${origin}/session/${encodeURIComponent(forkedId)}?directory=${encodeURIComponent(cwd)}`, { method: 'DELETE' });
        } catch { /* ignore delete outcome */ }
      }
      try {
        await requestFn(`${origin}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(cwd)}`, { method: 'DELETE' });
      } catch { /* ignore delete outcome */ }
    }
    controller.abort();
    child.kill('SIGKILL');
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
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
      if (output.length > STARTUP_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve startup output exceeded the limit.'));
        return;
      }
      const origin = parseOpencodeServerUrl(output);
      if (origin) finish(undefined, origin);
    });
  });
}
