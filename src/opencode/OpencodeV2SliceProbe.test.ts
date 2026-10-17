import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  detectOpencodeV2ExecutionSlice,
  parseOpencodeServeBody,
  reduceV2SliceEvents,
  v2AssistantAnswer,
  type OpencodeV2SliceReading,
} from './OpencodeV2SliceProbe';

const READY = 'server listening on http://127.0.0.1:4096';

function fakeServeChild(stdoutLine: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  setImmediate(() => { child.stdout.write(stdoutLine); });
  return child;
}

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function* eventStream(chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

function requestRouter(routes: [RegExp, unknown][]) {
  return vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    for (const [pattern, payload] of routes) {
      if (pattern.test(url)) {
        if (payload instanceof Error) throw payload;
        void init;
        return payload;
      }
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('parseOpencodeServeBody', () => {
  it('decodes a body and tolerates the empty one a delete answers with', () => {
    // Measured: DELETE /api/session/{id}?directory=… answers 204 with no body. Parsing
    // that as JSON throws, which made this probe claim a leftover session it had removed.
    expect(parseOpencodeServeBody('{"data":{"id":"ses_1"}}')).toEqual({ data: { id: 'ses_1' } });
    expect(parseOpencodeServeBody('')).toBeUndefined();
    expect(() => parseOpencodeServeBody('')).not.toThrow();
  });
});

describe('reduceV2SliceEvents', () => {
  const event = (type: string, sessionID: string) => ({ type, data: { sessionID } });

  it('records the lifecycle legs this session actually showed', () => {
    expect(reduceV2SliceEvents([
      event('session.inbox.enqueued', 'ses_1'),
      event('session.execution.started', 'ses_1'),
      event('session.inbox.delivered', 'ses_1'),
      event('session.step.started', 'ses_1'),
      event('session.step.started', 'ses_1'),
      event('session.retry.scheduled', 'ses_1'),
    ], 'ses_1')).toEqual({ enqueued: true, delivered: true, started: true, steps: 2, retries: 1 });
  });

  it('drops another session\'s frames so a foreign run cannot certify this one', () => {
    // The event stream is directory-scoped and carries every session in it; counting a
    // concurrent execution here would let someone else's turn prove this one ran.
    const foreign = reduceV2SliceEvents([
      event('session.execution.started', 'ses_other'),
      event('session.inbox.delivered', 'ses_other'),
    ], 'ses_1');
    expect(foreign).toEqual({ enqueued: false, delivered: false, started: false, steps: 0, retries: 0 });
  });

  it('ignores frames that carry no session or no usable payload', () => {
    expect(reduceV2SliceEvents([
      { type: 'session.execution.started' },
      { type: 'session.execution.started', data: null },
      { type: 'session.execution.started', data: { sessionID: 42 } },
      null,
      'not-an-event',
    ], 'ses_1').started).toBe(false);
  });
});

describe('v2AssistantAnswer', () => {
  it('reads an answer only from an assistant row carrying a non-empty text part', () => {
    expect(v2AssistantAnswer({ type: 'assistant', model: { id: 'a', providerID: 'p' },
      content: [{ type: 'text', text: 'OK' }] })).toEqual({ text: 'OK', modelId: 'p/a' });
    expect(v2AssistantAnswer({ type: 'user', content: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
    expect(v2AssistantAnswer({ type: 'assistant', content: [] })).toBeUndefined();
    expect(v2AssistantAnswer({ type: 'assistant', content: [{ type: 'text', text: '  ' }] })).toBeUndefined();
    expect(v2AssistantAnswer({ type: 'assistant' })).toBeUndefined();
    expect(v2AssistantAnswer(undefined)).toBeUndefined();
  });
});

describe('detectOpencodeV2ExecutionSlice', () => {
  const baseRoutes = (overrides: [RegExp, unknown][] = []): [RegExp, unknown][] => [
    ...overrides,
    [/\/prompt/u, { data: { id: 'msg_1', admittedSeq: 1 } }],
    [/\?directory=/u, {}],
    [/\/interrupt/u, {}],
    [/\/api\/session$/u, { data: { id: 'ses_1' } }],
  ];

  it('reports admitted when the kernel started the run but produced no answer', async () => {
    const child = fakeServeChild(READY);
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_1' } }),
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
    ]));
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [{ type: 'user', text: 'q' }] }]])) as never,
      openEventStream: openEventStream as never,
    });
    expect(reading).toMatchObject({ status: 'admitted', enqueued: true, started: true, answer: undefined, leftover: false });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('reports answered only when an assistant text part was actually read back', async () => {
    const child = fakeServeChild(READY);
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
      frame({ type: 'session.inbox.delivered', data: { sessionID: 'ses_1' } }),
    ]));
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [
        { type: 'assistant', model: { id: 'alpha', providerID: 'p' }, content: [{ type: 'text', text: 'OK' }] },
      ] }]])) as never,
      openEventStream: openEventStream as never,
    });
    expect(reading).toMatchObject({ status: 'answered', delivered: true, answer: 'OK', modelId: 'p/alpha' });
  });

  it('sends the top-level prompt body this kernel generation accepts', async () => {
    // Measured: the 1.x nested `{id, prompt:{text}}` is refused 400 "Missing key at
    // [\"text\"]" on 2.0.32. Encoding the old shape is what made the 0.2.55 probe report a
    // healthy kernel as one that did not answer.
    const child = fakeServeChild(READY);
    const request = requestRouter(baseRoutes([[/\/message/u, { data: [] }]]));
    await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: request as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
    });
    const promptCall = request.mock.calls.find(([url]) => String(url).includes('/prompt'));
    expect(promptCall?.[1]).toMatchObject({ method: 'POST', body: { text: 'Reply with exactly the word OK and nothing else.' } });
    expect(promptCall?.[1]?.body).not.toHaveProperty('prompt');
  });

  it('deletes the throwaway session on the route that exists, and flags a leftover when it cannot', async () => {
    const child = fakeServeChild(READY);
    const deleted: string[] = [];
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') { deleted.push(String(url)); return {}; }
      if (String(url).includes('/message')) return { data: [] };
      if (String(url).includes('/prompt')) return { data: { id: 'msg_1' } };
      if (String(url).includes('/interrupt')) return {};
      return { data: { id: 'ses_1' } };
    });
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: request as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
    });
    expect(deleted).toHaveLength(1);
    // The 1.x `/session/{id}` form answers 405 on this generation; deleting there would
    // silently leave the throwaway behind.
    expect(deleted[0]).toContain('/api/session/ses_1?directory=');
    expect(reading.leftover).toBe(false);
  });

  it('says so when teardown could not delete the throwaway session', async () => {
    const child = fakeServeChild(READY);
    const request = vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') throw new Error('405');
      if (String(url).includes('/message')) return { data: [] };
      if (String(url).includes('/prompt')) return { data: { id: 'msg_1' } };
      if (String(url).includes('/interrupt')) return {};
      return { data: { id: 'ses_1' } };
    });
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: request as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
    });
    expect(reading.leftover).toBe(true);
  });

  it('treats a prompt the kernel refused as unavailable, never as an executed turn', async () => {
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter([
        [/\/prompt/u, { data: {} }],
        [/\/interrupt/u, {}],
        [/\/api\/session$/u, { data: { id: 'ses_1' } }],
      ]) as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
    });
    expect(reading.status).toBe('unavailable');
    expect(reading.started).toBe(false);
  });

  it('does not spawn for a reader who already cancelled', async () => {
    const spawn = vi.fn();
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: spawn as never, platform: 'linux', env: {}, signal: AbortSignal.abort(),
    });
    expect(reading.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('settles a cancelled run without waiting for a request that ignores the signal', async () => {
    const child = fakeServeChild(READY);
    const controller = new AbortController();
    const request = vi.fn(() => new Promise<unknown>(() => {}));
    let result: OpencodeV2SliceReading | undefined;
    const pending = detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, signal: controller.signal,
      request: request as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
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
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
