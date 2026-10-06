import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseSseDataFrames,
  reduceNativeStream,
  detectOpencodeNativeTurnStream,
} from './OpencodeStreamProbe';

/** A serve child that prints its readiness line and stays alive until killed. */
function fakeServeChild(stdoutLine: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => { child.stdout.write(stdoutLine); });
  return child;
}

/** A serve child that exits without ever naming an address. */
function fakeServeChildFailsToStart() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => { child.emit('close', 1); });
  return child;
}

function requestRouter(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    void init;
    for (const [fragment, payload] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (payload instanceof Error) throw payload;
        return payload;
      }
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const READY = 'opencode server listening on http://127.0.0.1:4096';
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

/** An event-stream source that yields the given decoded chunks and then finishes. */
function eventStream(chunks: string[]) {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** The create/prompt routes a full turn needs, plus an interrupt that returns empty. */
function turnRequest(assistantSessionId = 'ses_1') {
  return requestRouter({
    '/prompt': { data: { admittedSeq: 1 } },
    '/interrupt': {},
    '/api/session': { data: { id: assistantSessionId } },
  });
}

describe('parseSseDataFrames', () => {
  it('reads the JSON of each data frame and ignores heartbeats and malformed frames', () => {
    const raw = [
      frame({ type: 'server.connected', data: {} }),
      ': heartbeat\n\n',
      'data: {not json}\n\n',
      frame({ type: 'session.next.text.delta', data: { delta: 'O' } }),
    ].join('');
    expect(parseSseDataFrames(raw)).toEqual([
      { type: 'server.connected', data: {} },
      { type: 'session.next.text.delta', data: { delta: 'O' } },
    ]);
  });

  it('joins a multi-line data frame into one payload', () => {
    const raw = 'data: {"type":"x","data":\ndata: {"n":1}}\n\n';
    expect(parseSseDataFrames(raw)).toEqual([{ type: 'x', data: { n: 1 } }]);
  });

  it('returns nothing for a buffer with no data frames', () => {
    expect(parseSseDataFrames(': heartbeat\n\n\n\n')).toEqual([]);
  });
});

describe('reduceNativeStream', () => {
  it('assembles the answer only from text deltas of the named session', () => {
    const events = [
      { type: 'session.next.prompt.admitted', data: { sessionID: 'other' } },
      { type: 'session.next.text.delta', data: { sessionID: 'other', delta: 'ZZZ' } },
      { type: 'session.next.text.delta', data: { sessionID: 'ses_1', delta: 'O' } },
      { type: 'session.next.reasoning.delta', data: { sessionID: 'ses_1', delta: 'hmm' } },
      { type: 'session.next.text.delta', data: { sessionID: 'ses_1', delta: 'K' } },
      { type: 'session.next.text.ended', data: { sessionID: 'ses_1', text: 'OK' } },
    ];
    expect(reduceNativeStream(events, 'ses_1')).toEqual({
      textDeltas: 2,
      reasoningDeltas: 1,
      answer: 'OK',
      confirmed: true,
      admitted: false,
      prompted: false,
    });
  });

  it('marks an answer unconfirmed when the ended frame disagrees with the deltas', () => {
    const events = [
      { type: 'session.next.text.delta', data: { sessionID: 's', delta: 'OK' } },
      { type: 'session.next.text.ended', data: { sessionID: 's', text: 'OK but more' } },
    ];
    const reading = reduceNativeStream(events, 's');
    expect(reading.answer).toBe('OK');
    expect(reading.confirmed).toBe(false);
  });

  it('tracks admission and prompting from the session frames', () => {
    const events = [
      { type: 'session.next.prompt.admitted', data: { sessionID: 's' } },
      { type: 'session.next.prompted', data: { sessionID: 's' } },
    ];
    const reading = reduceNativeStream(events, 's');
    expect(reading).toMatchObject({ admitted: true, prompted: true, answer: undefined });
  });

  it('yields no answer when only whitespace streamed', () => {
    const events = [{ type: 'session.next.text.delta', data: { sessionID: 's', delta: '   ' } }];
    expect(reduceNativeStream(events, 's').answer).toBeUndefined();
  });
});

describe('detectOpencodeNativeTurnStream', () => {
  it('reports streamed with the answer assembled from the live delta frames', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest();
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'server.connected', data: {} }),
      ': heartbeat\n\n',
      frame({ type: 'session.next.prompt.admitted', data: { sessionID: 'ses_1', admittedSeq: 1 } }),
      frame({ type: 'session.next.text.delta', data: { sessionID: 'ses_1', textID: 'text-0', delta: 'O' } }),
      frame({ type: 'session.next.text.delta', data: { sessionID: 'ses_1', textID: 'text-0', delta: 'K' } }),
      frame({ type: 'session.next.text.ended', data: { sessionID: 'ses_1', textID: 'text-0', text: 'OK' } }),
    ]));
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading).toEqual({ status: 'streamed', textDeltas: 2, reasoningDeltas: 0, answer: 'OK', confirmed: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('still reports streamed when the kernel never sent a matching ended frame', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest();
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.next.text.delta', data: { sessionID: 'ses_1', delta: 'OK' } }),
    ]));
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading).toEqual({ status: 'streamed', textDeltas: 1, reasoningDeltas: 0, answer: 'OK', confirmed: false });
  });

  it('keeps a turn that streamed no answer as admitted, not streamed', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest();
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.next.prompt.admitted', data: { sessionID: 'ses_1', admittedSeq: 1 } }),
      frame({ type: 'session.next.prompted', data: { sessionID: 'ses_1' } }),
    ]));
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading).toEqual({ status: 'admitted', textDeltas: 0, reasoningDeltas: 0, answer: undefined, confirmed: false });
  });

  it('ignores deltas that belong to a different session', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest('ses_1');
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.next.text.delta', data: { sessionID: 'someone-else', delta: 'secret' } }),
    ]));
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading.status).toBe('unavailable');
    expect(reading.answer).toBeUndefined();
  });

  it('degrades to unavailable when the server never names an address, opening no stream', async () => {
    const child = fakeServeChildFailsToStart();
    const request = vi.fn();
    const openEventStream = vi.fn();
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
    expect(openEventStream).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not spawn when the configured path is blank', async () => {
    const spawn = vi.fn();
    const reading = await detectOpencodeNativeTurnStream('   ', '/vault', { spawn: spawn as never, platform: 'linux', env: {} });
    expect(reading.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('treats a session that names no id as unavailable and opens no stream', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter({ '/api/session': { data: {} } });
    const openEventStream = vi.fn();
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading.status).toBe('unavailable');
    expect(openEventStream).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([url]) => String(url).includes('/prompt'))).toBe(false);
  });

  it('treats a prompt the server did not admit as unavailable', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter({
      '/prompt': { data: {} },
      '/api/session': { data: { id: 'ses_1' } },
    });
    const openEventStream = vi.fn(async () => eventStream([]));
    const reading = await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(reading.status).toBe('unavailable');
  });

  it('interrupts the throwaway session during teardown', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest();
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.next.text.ended', data: { sessionID: 'ses_1', text: 'OK' } }),
    ]));
    await detectOpencodeNativeTurnStream('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    expect(request.mock.calls.some(([url]) => String(url).includes('/interrupt'))).toBe(true);
  });

  it('opens the stream scoped to the working directory it was handed', async () => {
    const child = fakeServeChild(READY);
    const request = turnRequest();
    const openEventStream = vi.fn<(url: string, signal?: AbortSignal) => Promise<AsyncIterable<string>>>(async () => eventStream([]));
    await detectOpencodeNativeTurnStream('opencode', '/a vault/dir', {
      spawn: vi.fn(() => child) as never, request: request as never, openEventStream: openEventStream as never, platform: 'linux', env: {},
    });
    const streamUrl = openEventStream.mock.calls[0][0];
    expect(streamUrl).toContain('/api/event?location%5Bdirectory%5D=%2Fa%20vault%2Fdir');
    const createCall = request.mock.calls.find(([url]) => String(url).endsWith('/api/session'));
    expect(createCall?.[1]).toMatchObject({ method: 'POST', body: { location: { directory: '/a vault/dir' } } });
  });
});
