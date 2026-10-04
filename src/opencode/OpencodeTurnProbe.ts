import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';
import { parseOpencodeServerUrl } from './OpencodeCatalog';

/**
 * Verify that the native OpenCode install can actually execute a turn over its
 * loopback `opencode serve` HTTP kernel — a step past the catalog probe, which
 * only proves the install lists models. This drives one throwaway session: create
 * a session, admit a minimal prompt, then read the session's own message back to
 * see whether an assistant turn with real text was produced. The server is torn
 * down on exit, so nothing persists and no live conversation is touched.
 *
 * The wire shapes here are read off the running 1.18.33 install, not copied from
 * another reference: a prompt is `POST /api/session/{id}/prompt` with a nested
 * `{ prompt: { text } }` body and a `msg_`-prefixed id, and the message readback is
 * `GET /api/session/{id}/message?order=desc`. A turn is only ever claimed `executed`
 * when an assistant message with a non-empty text part is actually observed.
 */

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_OUTPUT_MAX_CHARS = 8_000;
const PROBE_TEXT = 'Reply with exactly the word OK and nothing else.';

export type OpencodeTurnStatus = 'executed' | 'admitted' | 'unavailable';

export interface OpencodeTurnObservation {
  status: OpencodeTurnStatus;
  modelId: string | undefined;
  finish: string | undefined;
  outputTokens: number | undefined;
}

export interface OpencodeTurnDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
  pollAttempts?: number;
}

const DEFAULT_OBSERVATION: OpencodeTurnObservation = { status: 'unavailable', modelId: undefined, finish: undefined, outputTokens: undefined };

/**
 * An assistant message counts as execution only when it carries a text part with
 * actual content. A reasoning-only or empty assistant row is not a produced answer,
 * so the probe would report the prompt as merely admitted rather than overclaiming
 * a completion the wire did not show.
 */
export function assistantTextOf(row: Record<string, unknown> | undefined): string | undefined {
  if (!row || row.type !== 'assistant') return undefined;
  const content = row.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) return p.text;
    }
  }
  return undefined;
}

function assistantModelId(row: Record<string, unknown>): string | undefined {
  const model = row.model;
  if (model !== null && typeof model === 'object' && !Array.isArray(model)) {
    const m = model as Record<string, unknown>;
    if (typeof m.id === 'string' && typeof m.providerID === 'string') return `${m.providerID}/${m.id}`;
  }
  return undefined;
}

function assistantTokens(row: Record<string, unknown>): number | undefined {
  const tokens = row.tokens;
  if (tokens !== null && typeof tokens === 'object' && !Array.isArray(tokens)) {
    const output = (tokens as Record<string, unknown>).output;
    if (typeof output === 'number') return output;
  }
  return undefined;
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

/**
 * Run one throwaway turn against the native install and report what was observed.
 * This never throws: a missing CLI, a server that never names an address, a failed
 * session/prompt, or an assistant answer that never arrives all degrade to an honest
 * `unavailable` or `admitted` rather than a fabricated execution. `executed` is
 * reserved for the one reading the probe actually watched — an assistant message
 * whose text content was non-empty.
 */
export async function detectOpencodeNativeTurnExecution(
  cliPath: string,
  cwd: string,
  deps: OpencodeTurnDeps = {},
): Promise<OpencodeTurnObservation> {
  if (!cliPath?.trim()) return DEFAULT_OBSERVATION;

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? defaultRequest;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1_000;
  const pollAttempts = deps.pollAttempts ?? 8;

  const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
  let child: ChildProcess;
  try {
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return DEFAULT_OBSERVATION;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
    child.kill('SIGKILL');
  }, timeoutMs);

  let sessionId: string | null = null;
  let origin: string | undefined;
  try {
    origin = await waitForServerUrl(child, controller);
    const created = await requestFn(
      `${origin}/api/session`,
      { method: 'POST', body: { location: { directory: cwd }, agent: 'build' } },
      controller.signal,
    ) as { data?: { id?: unknown } } | undefined;
    sessionId = typeof created?.data?.id === 'string' ? created.data.id : null;
    if (!sessionId) return DEFAULT_OBSERVATION;

    // Admission is the server taking the prompt into the session; it is observed
    // from the POST response, so a channel that admits but never answers still
    // reports the honest middle state rather than collapsing to unavailable.
    const admitted = await requestFn(
      `${origin}/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { method: 'POST', body: { id: `msg_${randomProbeId()}`, prompt: { text: PROBE_TEXT } } },
      controller.signal,
    );
    if (!isAdmitted(admitted)) return DEFAULT_OBSERVATION;

    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (controller.signal.aborted) break;
      await sleep(pollMs);
      const page = await requestFn(
        `${origin}/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=5`,
        undefined,
        controller.signal,
      ) as { data?: unknown[] } | undefined;
      const rows = Array.isArray(page?.data) ? page.data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)) : [];
      const assistant = rows.find(row => row.type === 'assistant');
      if (assistant && assistantTextOf(assistant) !== undefined) {
        return {
          status: 'executed',
          modelId: assistantModelId(assistant),
          finish: typeof assistant.finish === 'string' ? assistant.finish : undefined,
          outputTokens: assistantTokens(assistant),
        };
      }
    }
    // Admitted, but no assistant answer observed within the window: the channel is
    // live, the turn is not confirmed. Report that rather than a completion.
    return { status: 'admitted', modelId: undefined, finish: undefined, outputTokens: undefined };
  } catch {
    return DEFAULT_OBSERVATION;
  } finally {
    clearTimeout(timer);
    if (sessionId && origin) {
      // Best-effort: stop the throwaway turn so it does not keep generating, and
      // swallow any interrupt error — teardown must not mask the reading. A 204
      // answer carries no JSON body, so the request helper may throw; that is the
      // expected success shape and is ignored here.
      try {
        await requestFn(`${origin}/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, { method: 'POST' });
      } catch { /* ignore interrupt outcome */ }
    }
    controller.abort();
    child.kill('SIGKILL');
  }
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

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function randomProbeId(): string {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
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
      if (output.length > PROBE_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve startup output exceeded the limit.'));
        return;
      }
      const origin = parseOpencodeServerUrl(output);
      if (origin) finish(undefined, origin);
    });
  });
}
