import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';
import { parseOpencodeServerUrl } from './OpencodeCatalog';
import { parseSseDataFrames } from './OpencodeStreamProbe';
import {
  newOpencodeServePassword,
  opencodeServeAuthHeaders,
  opencodeServeEnvironment,
} from './OpencodeServeAuth';

/**
 * Measure the native OpenCode *execution* slice — the leg past the catalog, where 0.2.55
 * proved a turn could run on 1.18.33. That measurement is void on the install this plugin
 * now runs against: the CLI reports 2.0.32, and the wire it speaks is not the one the
 * 0.2.55 turn probe encodes.
 *
 * Every shape below was read off a running 2.0.32 server with an isolated database and
 * `OPENCODE_SIMULATE=1`, never copied from another reference:
 *
 * - The prompt body is **top-level** `POST /api/session/{id}/prompt` with `{id, text}`.
 *   The 1.x nested `{id, prompt:{text}}` is refused with
 *   `400 {"_tag":"InvalidRequestError","message":"Missing key at [\"text\"]"}` — which is
 *   why the 0.2.55 probe reports `unavailable` here and why "unavailable" was the wrong
 *   word to begin with.
 * - The lifecycle lives on the same `GET /api/event` stream but under a different
 *   namespace than `session.next.*`: `session.inbox.enqueued`,
 *   `session.execution.started`, `session.inbox.delivered`, `session.step.started`,
 *   `session.retry.scheduled`. `session.inbox.delivered` is the steer-delivery signal —
 *   the event a caller must wait for before treating a mid-turn message as consumed.
 * - The user row carries `text` at the top level rather than a `content` array, and the
 *   read-back envelope gained `cursor`.
 * - Teardown is `DELETE /api/session/{id}?directory=…` (**204**). The 1.x
 *   `DELETE /session/{id}?directory=…` the fork probe still uses answers **405**, so that
 *   probe's cleanup is a silent no-op on this install — this probe deletes on the route
 *   that exists and reports whether it managed to.
 *
 * What this probe deliberately does NOT claim: a successful answer. Producing one needs
 * working provider credentials, so on this install the observed terminal was a named
 * transport failure rather than an assistant text part. `answered` is therefore defined
 * narrowly and can only be reached by actually reading a non-empty assistant text part
 * off the transcript; it is carried as a distinct bucket precisely so a future run with
 * credentials can fill it without merging into `admitted`.
 */

const SLICE_TIMEOUT_MS = 45_000;
const STARTUP_OUTPUT_MAX_CHARS = 8_000;
const SLICE_READ_MAX_CHARS = 400_000;
const PROBE_TEXT = 'Reply with exactly the word OK and nothing else.';
const POLL_MS = 250;
/** How long the event stream is given to deliver frames emitted alongside the answer. */
const FRAME_DRAIN_MS = 250;

export type OpencodeV2SliceStatus = 'answered' | 'interrupted' | 'failed' | 'admitted' | 'unavailable';

export interface OpencodeV2SliceReading {
  status: OpencodeV2SliceStatus;
  /** The prompt was taken into the session's inbox. */
  enqueued: boolean;
  /** `session.inbox.delivered` — the steer reached the run, not merely the queue. */
  delivered: boolean;
  /** `session.execution.started` — the kernel actually began executing. */
  started: boolean;
  /** Whether the answer was assembled purely from live `session.text.delta` frames. */
  streamed: boolean;
  /** The kernel's own `session.text.ended` text agreed with that assembly. */
  confirmed: boolean;
  answer: string | undefined;
  modelId: string | undefined;
  /** The terminal outcome the kernel itself recorded, verbatim and uninterpreted. */
  outcome: string | undefined;
  /** The terminal execution event's own name, e.g. `session.execution.interrupted`. */
  terminal: string | undefined;
  /** The reason the kernel gave for an interrupted terminal, e.g. `user`. */
  reason: string | undefined;
  /** A failure the kernel named, taken from `session.step.failed` or the assistant row. */
  errorType: string | undefined;
  errorMessage: string | undefined;
  retries: number;
  finish: string | undefined;
  cost: number | undefined;
  outputTokens: number | undefined;
  /** True when teardown could not remove the throwaway session on any known route. */
  leftover: boolean;
}

export interface OpencodeV2SliceDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal) => Promise<unknown>;
  openEventStream?: (url: string, signal?: AbortSignal) => Promise<AsyncIterable<string>>;
  timeoutMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_SLICE: OpencodeV2SliceReading = {
  status: 'unavailable', enqueued: false, delivered: false, started: false,
  streamed: false, confirmed: false, answer: undefined, modelId: undefined,
  outcome: undefined, terminal: undefined, reason: undefined,
  errorType: undefined, errorMessage: undefined, retries: 0,
  finish: undefined, cost: undefined, outputTokens: undefined, leftover: false,
};

export interface NativeV2SliceEvents {
  enqueued: boolean;
  delivered: boolean;
  started: boolean;
  steps: number;
  retries: number;
  /** The terminal execution event observed, by its own name, e.g. `session.execution.succeeded`. */
  terminal: string | undefined;
  /** Answer assembled purely from `session.text.delta` frames, in arrival order. */
  assembled: string | undefined;
  /** The text the kernel's own `session.text.ended` frame carried. */
  endedText: string | undefined;
  finish: string | undefined;
  cost: number | undefined;
  outputTokens: number | undefined;
  /** The model the step announced, from `session.step.started`. */
  modelId: string | undefined;
  /** Why the kernel interrupted, from `session.execution.interrupted`. */
  reason: string | undefined;
  /** The first failure the kernel named, from `session.step.failed` or a scheduled retry. */
  errorType: string | undefined;
  errorMessage: string | undefined;
}

/**
 * Fold the event stream into what this session actually demonstrated. Frames belonging to
 * another session are dropped: the directory-scoped stream carries global hydration noise
 * and any concurrent session's frames, and counting those would let a foreign execution
 * certify this one.
 *
 * The namespace and the frame keys are read off a running 2.0.32 server, not assumed. The
 * streaming channel is `session.text.*` — keyed by `assistantMessageID` and an `ordinal`
 * that distinguishes reasoning from answer text — and not the 1.x `session.next.text.*`
 * this plugin's older stream probe encodes. `session.execution.succeeded` is the terminal
 * event actually observed; any *other* `session.execution.*` name is recorded verbatim
 * rather than guessed into a meaning, because naming an unobserved terminal would be the
 * same fabrication this probe exists to stop.
 */
export function reduceV2SliceEvents(events: unknown[], sessionId: string): NativeV2SliceEvents {
  const seen: NativeV2SliceEvents = {
    enqueued: false, delivered: false, started: false, steps: 0, retries: 0,
    terminal: undefined, assembled: undefined, endedText: undefined,
    finish: undefined, cost: undefined, outputTokens: undefined, modelId: undefined,
    reason: undefined, errorType: undefined, errorMessage: undefined,
  };
  let assembled = '';
  const rememberError = (payload: unknown): void => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const err = payload as Record<string, unknown>;
    // Keep the FIRST named failure: later frames repeat or replace it, and a reader
    // shown the eighth retry's error has lost the one that started the trouble.
    if (seen.errorType === undefined && typeof err.type === 'string') seen.errorType = err.type;
    if (seen.errorMessage === undefined && typeof err.message === 'string') seen.errorMessage = err.message;
  };
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
    const e = event as Record<string, unknown>;
    const d = e.data;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) continue;
    const data = d as Record<string, unknown>;
    if (data.sessionID !== sessionId) continue;
    const type = typeof e.type === 'string' ? e.type : '';
    switch (type) {
      case 'session.inbox.enqueued': seen.enqueued = true; break;
      case 'session.inbox.delivered': seen.delivered = true; break;
      case 'session.execution.started': seen.started = true; break;
      case 'session.step.started':
        seen.steps += 1;
        seen.modelId = stepModelId(data) ?? seen.modelId;
        break;
      case 'session.retry.scheduled':
        seen.retries += 1;
        rememberError(data.error);
        break;
      case 'session.step.failed':
        rememberError(data.error);
        break;
      // Only the answer channel (ordinal 0 in the observed run) is assembled; a later
      // ordinal is a different part of the same step and must not be spliced into it.
      case 'session.text.delta':
        if (data.ordinal === 0 && typeof data.delta === 'string') assembled += data.delta;
        break;
      case 'session.text.ended':
        if (data.ordinal === 0 && typeof data.text === 'string') seen.endedText = data.text;
        break;
      case 'session.step.ended':
        if (typeof data.finish === 'string') seen.finish = data.finish;
        if (typeof data.cost === 'number') seen.cost = data.cost;
        if (data.tokens !== null && typeof data.tokens === 'object' && !Array.isArray(data.tokens)) {
          const output = (data.tokens as Record<string, unknown>).output;
          if (typeof output === 'number') seen.outputTokens = output;
        }
        break;
      default:
        if (type.startsWith('session.execution.') && seen.terminal === undefined) {
          seen.terminal = type;
          if (typeof data.reason === 'string') seen.reason = data.reason;
        }
        break;
    }
  }
  seen.assembled = assembled.trim().length > 0 ? assembled : undefined;
  return seen;
}

/**
 * Which bucket a run belongs in. The order matters and is the whole point: an answer
 * beats a terminal, a terminal beats a mid-flight observation, and an interrupt is kept
 * apart from a failure because the kernel names them apart and the reader's remedy
 * differs — one of them did this, the other is something to go fix.
 *
 * A named failure counts the moment the kernel names it. Waiting for an execution-level
 * terminal instead means sitting out a retry backoff that grows with every attempt and,
 * as measured, may not resolve inside the probe window at all — which would report a run
 * that is visibly failing as merely "in flight".
 */
export function sliceStatus(input: {
  answer: string | undefined;
  outcome: string | undefined;
  started: boolean;
  errorType: string | undefined;
}): OpencodeV2SliceStatus {
  if (input.answer) return 'answered';
  if (input.outcome === 'interrupted') return 'interrupted';
  if (input.errorType !== undefined) return 'failed';
  if (input.outcome !== undefined && input.outcome !== 'succeeded') return 'failed';
  if (input.started) return 'admitted';
  return 'unavailable';
}

function rowErrorType(row: Record<string, unknown> | undefined): string | undefined {
  const error = row?.error;
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const type = (error as Record<string, unknown>).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function rowErrorMessage(row: Record<string, unknown> | undefined): string | undefined {
  const error = row?.error;
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}

/**
 * The terminal the kernel recorded on its own transcript. A successful run appends a row
 * of `type: "idle"` carrying an `outcome`; the field is read verbatim so an outcome this
 * build has never seen still reaches the reader instead of being rounded into "succeeded".
 */
export function v2TerminalOutcome(row: Record<string, unknown> | undefined): string | undefined {
  if (!row || row.type !== 'idle') return undefined;
  return typeof row.outcome === 'string' ? row.outcome : undefined;
}

/**
 * An assistant answer counts only when a row actually carries a non-empty text part. A
 * reasoning-only, retry-stalled or empty assistant row is not a produced answer, and
 * rounding one up would repeat the exact lie this probe exists to stop.
 */
export function v2AssistantAnswer(row: Record<string, unknown> | undefined): { text: string; modelId?: string } | undefined {
  if (!row || row.type !== 'assistant') return undefined;
  const content = row.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0) {
        return { text: p.text, modelId: assistantModelId(row) };
      }
    }
  }
  return undefined;
}

function assistantModelId(row: Record<string, unknown>): string | undefined {
  return stepModelId(row);
}

/** The `{providerID}/{id}` pair both an assistant row and a `session.step.started` frame carry. */
function stepModelId(data: Record<string, unknown>): string | undefined {
  const model = data.model;
  if (model !== null && typeof model === 'object' && !Array.isArray(model)) {
    const m = model as Record<string, unknown>;
    if (typeof m.id === 'string' && typeof m.providerID === 'string') return `${m.providerID}/${m.id}`;
  }
  return undefined;
}

/**
 * Decode a successful response body. A delete answers 204 with no body at all, and
 * calling `JSON.parse` on an empty string throws — which would make this probe report a
 * leftover session it had in fact just removed, the same lie pointed the other way.
 */
export function parseOpencodeServeBody(text: string): unknown {
  return text ? JSON.parse(text) : undefined;
}

async function defaultRequest(url: string, password: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    headers: { 'content-type': 'application/json', ...opencodeServeAuthHeaders(password) },
    signal,
  });
  if (!response.ok) throw new Error(`OpenCode serve responded ${response.status}`);
  return parseOpencodeServeBody(await response.text());
}

async function defaultOpenEventStream(url: string, password: string, signal?: AbortSignal): Promise<AsyncIterable<string>> {
  const response = await fetch(url, { headers: { accept: 'text/event-stream', ...opencodeServeAuthHeaders(password) }, signal });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream responded ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (signal?.aborted) break;
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) break;
        yield decoder.decode(result.value, { stream: true });
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function randomProbeId(): string {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/**
 * Drive one throwaway session through create -> prompt -> execution and report what was
 * actually observed. This never throws: a missing CLI, a server that never names an
 * address, a refused session or prompt, or a run that never starts all degrade to an
 * honest `unavailable`. `admitted` means the kernel took the prompt and began executing
 * without an answer being read back — live channel, answer NOT confirmed. `answered` is
 * reserved for an assistant text part actually observed on the transcript.
 *
 * The throwaway session is deleted on the v2 route and, when that fails, the reading says
 * `leftover` rather than quietly leaving it behind.
 */
export async function detectOpencodeV2ExecutionSlice(
  cliPath: string,
  cwd: string,
  deps: OpencodeV2SliceDeps = {},
): Promise<OpencodeV2SliceReading> {
  if (!cliPath?.trim() || deps.signal?.aborted) return DEFAULT_SLICE;

  const password = newOpencodeServePassword();
  const env = opencodeServeEnvironment(deps.env ?? process.env, password);
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? ((url, init, signal) => defaultRequest(url, password, init, signal));
  const openStream = deps.openEventStream ?? ((url, signal) => defaultOpenEventStream(url, password, signal));
  const timeoutMs = deps.timeoutMs ?? SLICE_TIMEOUT_MS;
  const settleMs = deps.settleMs ?? 20_000;

  const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
  let child: ChildProcess;
  try {
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return DEFAULT_SLICE;
  }

  const controller = new AbortController();
  const killChild = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };
  let onCancel: () => void = () => {};
  const cancelled = new Promise<OpencodeV2SliceReading>((resolve) => {
    onCancel = () => {
      controller.abort();
      killChild();
      resolve(DEFAULT_SLICE);
    };
    deps.signal?.addEventListener('abort', onCancel, { once: true });
  });
  const timer = setTimeout(() => {
    controller.abort();
    killChild();
  }, timeoutMs);

  let sessionId: string | null = null;
  let origin: string | undefined;

  const run = async (): Promise<OpencodeV2SliceReading> => {
    origin = await waitForServerUrl(child, controller);
    const created = await requestFn(
      `${origin}/api/session`,
      { method: 'POST', body: { location: { directory: cwd }, agent: 'build' } },
      controller.signal,
    ) as { data?: { id?: unknown } } | undefined;
    sessionId = typeof created?.data?.id === 'string' ? created.data.id : null;
    if (!sessionId) return DEFAULT_SLICE;

    const encoded = encodeURIComponent(sessionId);
    // Open the stream BEFORE the prompt so the lifecycle frames are watched live rather
    // than reconstructed after the fact. It is drained rather than cut short at the first
    // lifecycle frame: `session.inbox.delivered` follows `session.execution.started`, and a
    // watcher that stopped at `started` would report `delivered: false` forever while the
    // reader was told the probe had looked.
    const stream = await openStream(`${origin}/api/event?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, controller.signal);
    const collected: string[] = [];
    const watch = (async () => {
      try {
        for await (const chunk of stream) {
          collected.push(chunk);
          if (collected.join('').length > SLICE_READ_MAX_CHARS) break;
        }
      } catch {
        // A stream that died mid-read is not evidence about the run; the transcript is.
      }
    })();

    const admitted = await requestFn(
      `${origin}/api/session/${encoded}/prompt`,
      { method: 'POST', body: { id: `msg_${randomProbeId()}`, text: PROBE_TEXT } },
      controller.signal,
    );
    if (!isAdmitted(admitted)) {
      await watch.catch(() => undefined);
      return DEFAULT_SLICE;
    }

    // Poll the transcript for a real answer, bounded by the settle window. The run may
    // finish without one — a transport failure looks exactly like this — and that is the
    // honest `admitted` middle state rather than a fabricated completion.
    let answerCell: { text: string; modelId?: string } | undefined;
    let rows: Record<string, unknown>[] = [];
    const deadline = Date.now() + settleMs;
    for (;;) {
      const page = await requestFn(
        `${origin}/api/session/${encoded}/message?order=desc&limit=10`,
        undefined,
        controller.signal,
      ) as { data?: unknown[] } | undefined;
      rows = Array.isArray(page?.data)
        ? page.data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
        : [];
      answerCell = rows.map(v2AssistantAnswer).find((a) => a !== undefined);
      // A terminal the kernel recorded means there is nothing further to wait for.
      if (answerCell || rows.map(v2TerminalOutcome).find(Boolean) || controller.signal.aborted || Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    const answerModelId = answerCell?.modelId;
    const assistantRow = rows.find((r) => r.type === 'assistant');
    const answerFinish = typeof assistantRow?.finish === 'string' ? assistantRow.finish : undefined;
    // Give the stream one last turn so frames emitted alongside the answer are not lost.
    await Promise.race([watch, sleep(FRAME_DRAIN_MS)]);

    const events = reduceV2SliceEvents(parseSseDataFrames(collected.join('')), sessionId);
    // The delta assembly and the transcript are two independent reads of the same run, so
    // disagreement is worth reporting rather than smoothing over: `confirmed` says the
    // kernel's own ended frame matched what the deltas produced.
    const streamedAnswer = events.assembled;
    // One resolved answer for both the status and the payload. Deriving the status from
    // only one of the two reads would let the panel say "no answer was read back" while
    // the same row displays an answer.
    const answer = answerCell?.text ?? streamedAnswer;

    const outcome = rows.map(v2TerminalOutcome).find((o) => o !== undefined);
    return {
      status: sliceStatus({ answer, outcome, started: events.started, errorType: events.errorType }),
      enqueued: events.enqueued,
      delivered: events.delivered,
      started: events.started,
      streamed: streamedAnswer !== undefined,
      confirmed: events.endedText !== undefined && events.endedText === streamedAnswer,
      answer,
      modelId: answerModelId ?? events.modelId,
      outcome,
      terminal: events.terminal,
      reason: events.reason,
      errorType: events.errorType ?? rowErrorType(assistantRow),
      errorMessage: events.errorMessage ?? rowErrorMessage(assistantRow),
      retries: events.retries,
      finish: answerFinish ?? events.finish,
      cost: events.cost,
      outputTokens: events.outputTokens,
      leftover: false,
    };
  };

  /**
   * Stop the throwaway run and remove the throwaway session, then report whether the
   * session is actually gone. This runs before the reading is handed back on purpose: a
   * cleanup flag computed after the fact could never reach the reader, which would make it
   * the same class of decoration this project keeps removing.
   */
  const teardown = async (reading: OpencodeV2SliceReading): Promise<OpencodeV2SliceReading> => {
    if (!sessionId || !origin) return reading;
    try {
      await requestFn(`${origin}/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, { method: 'POST' });
    } catch { /* teardown must not mask the reading */ }
    // Delete on the route that exists on this generation. The 1.x `/session/{id}` form
    // answers 405 here, and a silently-failed delete is exactly the leftover this reports.
    try {
      await requestFn(`${origin}/api/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(cwd)}`, { method: 'DELETE' });
      return { ...reading, leftover: false };
    } catch {
      return { ...reading, leftover: true };
    }
  };

  try {
    const reading = await Promise.race([cancelled, run()]).catch(() => DEFAULT_SLICE);
    return await teardown(reading);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onCancel);
    controller.abort();
    killChild();
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
      if (output.length > STARTUP_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve startup output exceeded the limit.'));
        return;
      }
      const parsed = parseOpencodeServerUrl(output);
      if (parsed) finish(undefined, parsed);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', onError);
    child.on('close', onClose);
    child.stdout?.on('data', onData);
  });
}
