import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  classifyForkCopy,
  detectOpencodeNativeCheckpointFork,
  forkRouteShape,
  type ForkRow,
  type OpencodeForkObservation,
} from './OpencodeForkProbe';
import { OpencodeServeHttpError } from './OpencodeServeAuth';

/** A serve child that prints its readiness line and stays alive until killed. */
function fakeServeChild(stdoutLine: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => { child.stdout.write(stdoutLine); });
  return child;
}

const READY = 'opencode server listening on http://127.0.0.1:4096';

/**
 * Route by predicate over the full url, so the parent readback (`ses_1`) and the
 * child readback (`ses_child`) — which share the `/message` suffix — stay distinct,
 * and the legacy fork (`/session/ses_1/fork`) is not confused with the v2 route.
 */
function requestRouter(routes: Array<[RegExp, unknown]>) {
  return vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    void init;
    for (const [pattern, payload] of routes) {
      if (pattern.test(url)) {
        if (payload instanceof Error) throw payload;
        return typeof payload === 'function' ? (payload as (u: string) => unknown)(url) : payload;
      }
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const PARENT_TWO_USERS = { data: [{ id: 'msg_u2', type: 'user' }, { id: 'msg_u1', type: 'user' }] };

function forkHarness(childReadback: unknown) {
  const child = fakeServeChild(READY);
  const request = requestRouter([
    [/\/api\/session\/ses_1\/message/u, PARENT_TWO_USERS],
    [/\/api\/session\/ses_child\/message/u, () => childReadback],
    [/\/session\/ses_1\/fork/u, { id: 'ses_child' }],
    [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
    [/\/interrupt/u, {}],
    [/\/session\/ses_child\?directory/u, true],
    [/\/session\/ses_1\?directory/u, true],
    [/\/api\/session$/u, { data: { id: 'ses_1' } }],
  ]);
  const requestRaw = vi.fn(async () => ({ status: 200, contentType: 'text/html; charset=utf-8', payload: undefined }));
  return { child, request, requestRaw };
}

function runFork(childReadback: unknown) {
  const h = forkHarness(childReadback);
  return {
    ...h,
    reading: detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => h.child) as never,
      request: h.request as never,
      requestRaw: h.requestRaw as never,
      platform: 'linux',
      env: {},
      pollMs: 0,
      pollAttempts: 3,
    }),
  };
}

describe('forkRouteShape', () => {
  it('calls the web UI catch-all html, not a json fork route', () => {
    expect(forkRouteShape(200, 'text/html; charset=utf-8', undefined)).toBe('html');
  });
  it('accepts json only when a child session id is actually named', () => {
    expect(forkRouteShape(200, 'application/json', { data: { id: 'ses_2' } })).toBe('json');
    expect(forkRouteShape(200, 'application/json', { data: {} })).toBe('error');
    expect(forkRouteShape(500, 'application/json', { data: { id: 'ses_2' } })).toBe('error');
  });
});

describe('classifyForkCopy', () => {
  const parent: ForkRow[] = [
    { id: 'msg_u1', type: 'user' },
    { id: 'msg_a1', type: 'assistant' },
    { id: 'msg_u2', type: 'user' },
  ];
  it('says an empty child is empty, never a truncation', () => {
    expect(classifyForkCopy(parent, [], 'msg_a1')).toBe('child-empty');
  });
  it('claims anchored only when the child is exactly the source prefix through the anchor', () => {
    expect(classifyForkCopy(parent, parent.slice(0, 2), 'msg_a1')).toBe('anchored');
  });
  it('names a full copy as ignoring the anchor', () => {
    expect(classifyForkCopy(parent, parent, 'msg_a1')).toBe('copied-whole');
  });
  it('calls anything else unexpected rather than rounding it into a known shape', () => {
    expect(classifyForkCopy(parent, [{ id: 'msg_u2', type: 'user' }], 'msg_a1')).toBe('unexpected');
    expect(classifyForkCopy(parent, parent.slice(0, 1), 'msg_missing')).toBe('unexpected');
  });
});

describe('detectOpencodeNativeCheckpointFork', () => {
  it('reports the measured reality: a forked child with no history rows is child-empty', async () => {
    const h = runFork({ data: [] });
    const reading = await h.reading;
    expect(reading).toEqual({ status: 'child-empty', parentRows: 2, childRows: 0, apiForkRoute: 'html', leftover: false });
    expect(h.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('claims anchored only when the child readback is the prefix through the anchor', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter([
      [/\/api\/session\/ses_1\/message/u, { data: [{ id: 'msg_u2', type: 'user' }, { id: 'msg_a1', type: 'assistant' }, { id: 'msg_u1', type: 'user' }] }],
      [/\/api\/session\/ses_child\/message/u, { data: [{ id: 'msg_a1', type: 'assistant' }, { id: 'msg_u1', type: 'user' }] }],
      [/\/session\/ses_1\/fork/u, { id: 'ses_child' }],
      [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
      [/\/interrupt/u, {}],
      [/\/session\/ses_child\?directory/u, true],
      [/\/session\/ses_1\?directory/u, true],
      [/\/api\/session$/u, { data: { id: 'ses_1' } }],
    ]);
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never,
      request: request as never,
      requestRaw: vi.fn(async () => ({ status: 200, contentType: 'application/json', payload: { data: { id: 'ses_9' } } })) as never,
      platform: 'linux',
      env: {},
      pollMs: 0,
      pollAttempts: 3,
    });
    // The child holds u1+u2 while the anchor (first user row) sits at u1 alone —
    // that is a copy through more than the anchor, so it must not be called anchored.
    expect(reading).toEqual({ status: 'unexpected', parentRows: 3, childRows: 2, apiForkRoute: 'json', leftover: false });
  });

  it('classifies a true truncated copy as anchored', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter([
      [/\/api\/session\/ses_1\/message/u, { data: [{ id: 'msg_u2', type: 'user' }, { id: 'msg_a1', type: 'assistant' }, { id: 'msg_u1', type: 'user' }] }],
      [/\/api\/session\/ses_child\/message/u, { data: [{ id: 'msg_u1', type: 'user' }] }],
      [/\/session\/ses_1\/fork/u, { id: 'ses_child' }],
      [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
      [/\/interrupt/u, {}],
      [/\/session\/ses_child\?directory/u, true],
      [/\/session\/ses_1\?directory/u, true],
      [/\/api\/session$/u, { data: { id: 'ses_1' } }],
    ]);
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never,
      request: request as never,
      requestRaw: vi.fn(async () => ({ status: 200, contentType: 'application/json', payload: { data: { id: 'nope' } } })) as never,
      platform: 'linux',
      env: {},
      pollMs: 0,
      pollAttempts: 3,
    });
    expect(reading).toEqual({ status: 'anchored', parentRows: 3, childRows: 1, apiForkRoute: 'json', leftover: false });
  });

  it('anchors at the first user row and carries it into the legacy fork request', async () => {
    const h = runFork({ data: [] });
    await h.reading;
    const forkCall = h.request.mock.calls.find(([url]) => String(url).includes('/session/ses_1/fork'));
    expect(String(forkCall?.[0])).toContain('directory=%2Fvault');
    expect((forkCall?.[1] as { body?: unknown })?.body).toEqual({ messageID: 'msg_u1' });
  });

  it('deletes the forked child and the throwaway source during teardown', async () => {
    const h = runFork({ data: [] });
    await h.reading;
    const urls = h.request.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes('/session/ses_child?directory'))).toBe(true);
    expect(urls.some((u) => u.includes('/session/ses_1?directory'))).toBe(true);
  });

  it('treats a transcript that never shows two rows as unavailable, not as an empty fork', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter([
      [/\/api\/session\/ses_1\/message/u, { data: [{ id: 'msg_u1', type: 'user' }] }],
      [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
      [/\/interrupt/u, {}],
      [/\/session\/ses_1\?directory/u, true],
      [/\/api\/session$/u, { data: { id: 'ses_1' } }],
    ]);
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
    expect(request.mock.calls.some(([url]) => String(url).includes('/fork'))).toBe(false);
  });

  it('does not spawn when the configured path is blank', async () => {
    const spawn = vi.fn();
    const reading = await detectOpencodeNativeCheckpointFork('   ', '/vault', { spawn: spawn as never, platform: 'linux', env: {} });
    expect(reading.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('degrades to unavailable when the server never names an address', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.kill = vi.fn();
    setImmediate(() => { child.emit('close', 1); });
    const request = vi.fn();
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('treats a fork that names no child as unavailable', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter([
      [/\/api\/session\/ses_1\/message/u, PARENT_TWO_USERS],
      [/\/session\/ses_1\/fork/u, {}],
      [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
      [/\/interrupt/u, {}],
      [/\/session\/ses_1\?directory/u, true],
      [/\/api\/session$/u, { data: { id: 'ses_1' } }],
    ]);
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
  });

  it('names a kernel with no fork route as unsupported, not as "could not fork"', async () => {
    // Measured on 2.0.32: the legacy `POST /session/{id}/fork?directory=…` answers 405
    // and `/api/session/{id}/fork` answers a JSON 404. Both routes this probe speaks are
    // gone, which is a different finding from a kernel that could not be reached — and it
    // says nothing at all about whether checkpoint fork is buildable.
    const child = fakeServeChild(READY);
    const request = vi.fn(async (url: string) => {
      if (String(url).includes('/prompt')) throw new OpencodeServeHttpError(400, 'responded 400');
      if (String(url).includes('/interrupt')) return {};
      return { data: { id: 'ses_1' } };
    });
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child as never), request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unsupported');
  });

  it('deletes both throwaways on the route this generation has, and says when it cannot', async () => {
    // Measured: 2.0.32 moved the delete from DELETE /session/{id}?directory= (now 405) to
    // DELETE /api/session/{id}?directory= (204). A teardown that only knew the old form
    // left both throwaway sessions in the kernel's history, with the 405 swallowed.
    const child = fakeServeChild(READY);
    const deleted: string[] = [];
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') { deleted.push(String(url)); return {}; }
      return requestRouter([
        [/\/api\/session\/ses_1\/message/u, PARENT_TWO_USERS],
        [/\/session\/ses_1\/fork/u, { id: 'ses_child' }],
        [/\/api\/session\/ses_child\/message/u, { data: [] }],
        [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
        [/\/interrupt/u, {}],
        [/\/api\/session$/u, { data: { id: 'ses_1' } }],
      ])(url, init);
    });
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child as never), request: request as never, requestRaw: vi.fn(async () => ({ status: 200, contentType: 'application/json', payload: { data: { id: 'ses_x' } } })) as never,
      platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(deleted).toHaveLength(2);
    expect(deleted.every((url) => url.includes('/api/session/'))).toBe(true);
    expect(reading.leftover).toBe(false);
  });

  it('reports a leftover throwaway rather than leaving it behind in silence', async () => {
    const child = fakeServeChild(READY);
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') throw new Error('405');
      return requestRouter([
        [/\/api\/session\/ses_1\/message/u, PARENT_TWO_USERS],
        [/\/session\/ses_1\/fork/u, { id: 'ses_child' }],
        [/\/api\/session\/ses_child\/message/u, { data: [] }],
        [/\/prompt/u, { data: { id: 'msg_x', admittedSeq: 1 } }],
        [/\/interrupt/u, {}],
        [/\/api\/session$/u, { data: { id: 'ses_1' } }],
      ])(url, init);
    });
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child as never), request: request as never, requestRaw: vi.fn(async () => ({ status: 200, contentType: 'application/json', payload: { data: { id: 'ses_x' } } })) as never,
      platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.leftover).toBe(true);
  });

  it('does not spawn a server for a reader who already cancelled', async () => {
    // This probe forks real sessions. Starting a server after the reader gave up does
    // work that cannot be taken back, and forks nobody asked for.
    const spawn = vi.fn();
    const reading = await detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: spawn as never, platform: 'linux', env: {}, signal: AbortSignal.abort(),
    });
    expect(reading.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('settles a cancelled probe without waiting for a request helper that ignores the signal', async () => {
    const child = fakeServeChild(READY);
    const controller = new AbortController();
    // A helper that never settles stands in for a request the abort could not reach.
    const request = vi.fn(() => new Promise<unknown>(() => {}));
    let result: OpencodeForkObservation | undefined;
    const pending = detectOpencodeNativeCheckpointFork('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, signal: controller.signal,
    }).then((reading) => { result = reading; return reading; });
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then(() => 'settled'),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 40); }),
    ]);
    clearTimeout(timer);
    expect(settled).toBe('settled');
    expect(result?.status).toBe('unavailable');
    // The server the reader started must not outlive the reader's interest in it.
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
