import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import { getSpawnInfo } from '../utils/commandResolution';
import { parseOpencodeServerUrl } from './OpencodeCatalog';

/**
 * Observe whether the native `opencode serve` kernel STREAMS a turn's answer over
 * its server-sent-event channel — the specific delivery path a live transcript
 * would render from. This is one step past the turn-execution probe: that one read
 * the finished assistant message back by polling `GET .../message`, so it proved the
 * turn happened but never exercised the delta stream. Here the answer is rebuilt
 * purely from the `session.next.text.delta` frames of `GET /api/event`, and only
 * claimed `streamed` when a non-empty answer actually arrives over the wire.
 *
 * The frame shapes are read off the running 1.18.33 install, not copied from another
 * reference: the event stream is `GET /api/event?location[directory]=<cwd>` returning
 * `text/event-stream`, each frame a `data:` line whose JSON carries the event in a
 * `type` field with the payload in `data`; `session.next.text.delta` puts the fragment
 * in `data.delta` and `session.next.text.ended` puts the whole in `data.text`.
 */

const STARTUP_OUTPUT_MAX_CHARS = 8_000;
const STREAM_READ_MAX_CHARS = 200_000;
const STREAM_TIMEOUT_MS = 30_000;
const PROBE_TEXT = 'Reply with exactly the word OK and nothing else.';

export type OpencodeStreamStatus = 'streamed' | 'admitted' | 'unavailable';

export interface OpencodeStreamObservation {
  status: OpencodeStreamStatus;
  textDeltas: number;
  reasoningDeltas: number;
  answer: string | undefined;
  confirmed: boolean;
}

export interface OpencodeStreamDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  request?: (url: string, init?: { method?: string; body?: unknown }, signal?: AbortSignal) => Promise<unknown>;
  openEventStream?: (url: string, signal?: AbortSignal) => Promise<AsyncIterable<string>>;
  timeoutMs?: number;
}

const DEFAULT_STREAM: OpencodeStreamObservation = { status: 'unavailable', textDeltas: 0, reasoningDeltas: 0, answer: undefined, confirmed: false };

/**
 * Split a raw SSE buffer into the JSON payloads of its `data:` frames. Frames are
 * separated by a blank line; comment lines (heartbeat `: …`) and any frame without a
 * `data:` line carry no payload and are skipped, and a frame whose JSON does not parse
 * is dropped rather than trusted — a malformed frame is not evidence of a streamed word.
 */
export function parseSseDataFrames(text: string): unknown[] {
  const frames: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const dataLines = block.split(/\r?\n/u).filter((line) => line.startsWith('data:'));
    if (dataLines.length === 0) continue;
    const payload = dataLines.map((line) => line.slice(5).replace(/^ /u, '')).join('');
    if (!payload) continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // Ignore a frame we cannot read; it contributes nothing to the assembled answer.
    }
  }
  return frames;
}

export interface NativeStreamReading {
  textDeltas: number;
  reasoningDeltas: number;
  answer: string | undefined;
  confirmed: boolean;
  admitted: boolean;
  prompted: boolean;
}

/**
 * Fold the parsed events for one session into a reading. Only events whose payload
 * names this session contribute, so the directory-scoped stream's hydration noise and
 * any other session's frames cannot leak into the answer. Text fragments are concatenated
 * in arrival order; `confirmed` is true only when the kernel itself sent a
 * `session.next.text.ended` frame whose whole text equals what the deltas assembled —
 * agreement between the streamed pieces and the server's own final text, not an assumption.
 */
export function reduceNativeStream(events: unknown[], sessionID: string): NativeStreamReading {
  let textDeltas = 0;
  let reasoningDeltas = 0;
  let admitted = false;
  let prompted = false;
  let assembled = '';
  let endedText: string | undefined;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue;
    const e = event as Record<string, unknown>;
    const data = e.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const d = data as Record<string, unknown>;
    if (d.sessionID !== sessionID) continue;
    const type = e.type;
    if (type === 'session.next.text.delta' && typeof d.delta === 'string') {
      textDeltas++;
      assembled += d.delta;
    } else if (type === 'session.next.reasoning.delta' && typeof d.delta === 'string') {
      reasoningDeltas++;
    } else if (type === 'session.next.text.ended' && typeof d.text === 'string') {
      if (endedText === undefined) endedText = d.text;
    } else if (type === 'session.next.prompt.admitted') {
      admitted = true;
    } else if (type === 'session.next.prompted') {
      prompted = true;
    }
  }
  const answer = assembled.trim().length > 0 ? assembled : undefined;
  return {
    textDeltas,
    reasoningDeltas,
    answer,
    confirmed: endedText !== undefined && endedText === assembled,
    admitted,
    prompted,
  };
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

/**
 * Open the directory-scoped event stream and hand back a decoded-chunk iterator.
 * An abort ends the stream cleanly (the iterator finishes) rather than throwing, so a
 * partially streamed answer is still read and reported rather than lost on teardown.
 */
async function defaultOpenEventStream(url: string, signal?: AbortSignal): Promise<AsyncIterable<string>> {
  const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal });
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

/**
 * Drive one throwaway session against the native install and report whether its answer
 * arrived over the live event stream. This never throws: a missing CLI, a server that
 * never names an address, a failed session/prompt, or a stream that carries no answer all
 * degrade honestly — `unavailable` when the setup itself failed, `admitted` when the kernel
 * took the prompt but streamed no answer text (channel live, streaming not confirmed), and
 * `streamed` only when a non-empty answer was actually assembled from delta frames. The
 * server is SIGKILLed and the throwaway session interrupted in a `finally`, so neither a
 * process nor a running turn leaks.
 */
export async function detectOpencodeNativeTurnStream(
  cliPath: string,
  cwd: string,
  deps: OpencodeStreamDeps = {},
): Promise<OpencodeStreamObservation> {
  if (!cliPath?.trim()) return DEFAULT_STREAM;

  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn ?? spawn;
  const requestFn = deps.request ?? defaultRequest;
  const openStream = deps.openEventStream ?? defaultOpenEventStream;
  const timeoutMs = deps.timeoutMs ?? STREAM_TIMEOUT_MS;

  const info = getSpawnInfo(cliPath.trim(), ['serve', '--hostname', '127.0.0.1', '--port', '0'], platform, env);
  let child: ChildProcess;
  try {
    child = spawnFn(info.command, info.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  } catch {
    return DEFAULT_STREAM;
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
    if (!sessionId) return DEFAULT_STREAM;

    // Open the event stream BEFORE admitting the prompt, so the answer's fragments
    // are watched live rather than reconstructed after the fact.
    const scopedEvents = `${origin}/api/event?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
    const stream = await openStream(scopedEvents, controller.signal);

    const admitted = await requestFn(
      `${origin}/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { method: 'POST', body: { id: `msg_${randomProbeId()}`, prompt: { text: PROBE_TEXT } } },
      controller.signal,
    );
    if (!isAdmitted(admitted)) return DEFAULT_STREAM;

    let raw = '';
    for await (const chunk of stream) {
      raw += chunk;
      if (raw.length > STREAM_READ_MAX_CHARS) break;
      if (raw.includes('"session.next.text.ended"')) break;
    }

    const reading = reduceNativeStream(parseSseDataFrames(raw), sessionId);
    if (reading.answer !== undefined) {
      return {
        status: 'streamed',
        textDeltas: reading.textDeltas,
        reasoningDeltas: reading.reasoningDeltas,
        answer: reading.answer,
        confirmed: reading.confirmed,
      };
    }
    if (reading.admitted) {
      return { status: 'admitted', textDeltas: reading.textDeltas, reasoningDeltas: reading.reasoningDeltas, answer: undefined, confirmed: false };
    }
    return DEFAULT_STREAM;
  } catch {
    return DEFAULT_STREAM;
  } finally {
    clearTimeout(timer);
    if (sessionId && origin) {
      // Stop the throwaway turn so it does not keep generating; a 204 interrupt has no
      // JSON body and may throw in the request helper, which is the expected shape and
      // is swallowed — teardown must never mask or replace the streaming reading.
      try {
        await requestFn(`${origin}/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, { method: 'POST' });
      } catch { /* ignore interrupt outcome */ }
    }
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
      if (output.length > STARTUP_OUTPUT_MAX_CHARS) {
        finish(new Error('OpenCode serve startup output exceeded the limit.'));
        return;
      }
      const origin = parseOpencodeServerUrl(output);
      if (origin) finish(undefined, origin);
    });
  });
}
