import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  detectOpencodeV2ExecutionSlice,
  ownFrameChars,
  parseOpencodeServeBody,
  reduceV2SliceEvents,
  v2AssistantAnswer,
  v2TerminalOutcome,
  sliceStatus,
  type OpencodeV2SliceReading,
} from './OpencodeV2SliceProbe';
import { parseSseDataFrames, reduceNativeStream } from './OpencodeStreamProbe';

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

describe('sliceStatus', () => {
  const base = { answer: undefined, outcome: undefined, started: true, errorType: undefined };

  it('puts an answer ahead of every other observation', () => {
    // A run can end in a terminal and still carry its answer; the answer is the fact the
    // reader came for, so it must not be outranked by the bookkeeping around it.
    expect(sliceStatus({ ...base, answer: 'OK', outcome: 'succeeded', errorType: 'aborted' })).toBe('answered');
  });

  it('keeps an interrupt apart from a failure', () => {
    // The kernel names them apart (`outcome: "interrupted"` vs a provider error type) and
    // the remedies differ: one of these happened because the reader asked.
    expect(sliceStatus({ ...base, outcome: 'interrupted' })).toBe('interrupted');
    expect(sliceStatus({ ...base, outcome: 'interrupted', errorType: 'aborted' })).toBe('interrupted');
    expect(sliceStatus({ ...base, errorType: 'aborted' })).toBe('failed');
  });

  it('calls a named failure failed the moment it is named, without waiting for a terminal', () => {
    // Measured: a failing provider retries with a backoff that grows every attempt and
    // produced no terminal inside the probe window. Waiting for one would report a run
    // that is visibly failing as merely in flight.
    expect(sliceStatus({ ...base, errorType: 'provider.internal' })).toBe('failed');
    expect(sliceStatus({ ...base, outcome: 'failed' })).toBe('failed');
  });

  it('does not call a successful terminal with no text an answer', () => {
    expect(sliceStatus({ ...base, outcome: 'succeeded' })).toBe('admitted');
    expect(sliceStatus({ ...base })).toBe('admitted');
    expect(sliceStatus({ ...base, started: false })).toBe('unavailable');
  });
});

describe('ownFrameChars', () => {
  it('charges only this session\'s frames against its read budget', () => {
    // Measured: `GET /api/event?location[directory]=…` is multiplexed. Two concurrent
    // sessions on one server both stream down the same connection, so a budget counted
    // per connection lets a neighbour's traffic truncate this session's own answer.
    const mine = frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'O' } });
    const theirs = frame({ type: 'session.text.delta', data: { sessionID: 'ses_2', ordinal: 0, delta: 'K' } });
    expect(ownFrameChars(mine, 'ses_1')).toBeGreaterThan(0);
    expect(ownFrameChars(theirs, 'ses_1')).toBe(0);
    expect(ownFrameChars(`${mine}${theirs}${mine}`, 'ses_1')).toBe(2 * ownFrameChars(mine, 'ses_1'));
  });

  it('charges nothing for frames that name no session', () => {
    // The directory-scoped stream's hydration noise carries no sessionID at all.
    expect(ownFrameChars(frame({ type: 'provider.updated', data: { id: 'p' } }), 'ses_1')).toBe(0);
    expect(ownFrameChars(': heartbeat\n\n', 'ses_1')).toBe(0);
  });
});

describe('multiplexed stream', () => {
  it('keeps two concurrent sessions apart on one shared connection', () => {
    // The gap analysis' acceptance criterion "多个标签不串流", measured rather than
    // asserted: this is the frame layout the running kernel produced with two sessions
    // prompted at once against a single directory-scoped stream.
    const interleaved = [
      frame({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_A' } }),
      frame({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_B' } }),
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_A' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_A', ordinal: 0, delta: 'MA' } }),
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_B' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_B', ordinal: 0, delta: 'OT' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_A', ordinal: 0, delta: 'RKER' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_B', ordinal: 0, delta: 'HER' } }),
      frame({ type: 'session.text.ended', data: { sessionID: 'ses_A', ordinal: 0, text: 'MARKER' } }),
      frame({ type: 'session.text.ended', data: { sessionID: 'ses_B', ordinal: 0, text: 'OTHER' } }),
      frame({ type: 'session.execution.succeeded', data: { sessionID: 'ses_A' } }),
      frame({ type: 'session.execution.succeeded', data: { sessionID: 'ses_B' } }),
    ].join('');
    const events = parseSseDataFrames(interleaved);
    const a = reduceV2SliceEvents(events, 'ses_A');
    const b = reduceV2SliceEvents(events, 'ses_B');
    // Neither session's answer may contain the other's words.
    expect(a.assembled).toBe('MARKER');
    expect(b.assembled).toBe('OTHER');
    expect(a.assembled).not.toContain('OTHER');
    expect(b.assembled).not.toContain('MARKER');
    // And the lifecycle each one reported is its own: A was enqueued but never saw a
    // delivery frame, while B did — a neighbour's delivery must not be read as this one's.
    expect(a.enqueued).toBe(true);
    expect(a.delivered).toBe(false);
    expect(b.enqueued).toBe(true);
    expect(b.started).toBe(true);
    expect(a.terminal).toBe('session.execution.succeeded');
  });

  it('is not truncated by a neighbouring session flooding the shared connection', async () => {
    // The defect the multiplexed measurement exposed. `GET /api/event` is directory-scoped,
    // so a busy conversation elsewhere in the same vault shares the connection. Counting
    // its bytes against this probe's read budget let a neighbour exhaust the cap first and
    // cut this session's own answer in half — a reading that silently lost its evidence.
    const neighbour = Array.from({ length: 5000 }, (_, i) =>
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_other', ordinal: 0, delta: `noise-${i} `.repeat(24) } }));
    const mine = [
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'SUR' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'VIVED' } }),
      frame({ type: 'session.text.ended', data: { sessionID: 'ses_1', ordinal: 0, text: 'SURVIVED' } }),
    ].join('');
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 40,
      request: requestRouter([
        [/\/message/u, { data: [] }],
        [/\/prompt/u, { data: { id: 'msg_1', admittedSeq: 1 } }],
        [/\?directory=/u, {}],
        [/\/interrupt/u, {}],
        [/\/api\/session$/u, { data: { id: 'ses_1' } }],
      ]) as never,
      openEventStream: vi.fn(async () => eventStream([...neighbour, mine])) as never,
    });
    expect(reading.streamed).toBe(true);
    expect(reading.answer).toBe('SURVIVED');
  });

  it('gives the same guarantee on the 1.x reducer, whose stream is shared the same way', () => {
    // The older stream probe reads the same directory-scoped endpoint, so its filter is
    // the same guarantee and needs the same pin.
    const interleaved = [
      `data: ${JSON.stringify({ type: 'session.next.text.delta', data: { sessionID: 'ses_A', delta: 'ALPHA' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'session.next.text.delta', data: { sessionID: 'ses_B', delta: 'BRAVO' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'session.next.text.ended', data: { sessionID: 'ses_A', text: 'ALPHA' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'session.next.text.ended', data: { sessionID: 'ses_B', text: 'BRAVO' } })}\n\n`,
    ].join('');
    const events = parseSseDataFrames(interleaved);
    expect(reduceNativeStream(events, 'ses_A')).toMatchObject({ answer: 'ALPHA', confirmed: true });
    expect(reduceNativeStream(events, 'ses_B')).toMatchObject({ answer: 'BRAVO', confirmed: true });
  });
});

describe('parseOpencodeServeBody', () => {
  it('decodes a body and tolerates the empty one a delete answers with', () => {
    // Measured: DELETE /api/session/{id}?directory=… answers 204 with no body. Parsing
    // that as JSON throws, which made this probe claim a leftover session it had removed.
    expect(parseOpencodeServeBody('{"data":{"id":"ses_1"}}')).toEqual({ data: { id: 'ses_1' } });
    expect(parseOpencodeServeBody('')).toBeUndefined();
    expect(() => parseOpencodeServeBody('')).not.toThrow();
  });
});

describe('v2TerminalOutcome', () => {
  it('reads the terminal the kernel recorded on its own transcript, verbatim', () => {
    // Measured: a successful run appends a row of `type: "idle"` carrying an `outcome`.
    // The field is read as-is so an outcome this build has never seen still reaches the
    // reader instead of being rounded into "succeeded".
    expect(v2TerminalOutcome({ type: 'idle', outcome: 'succeeded' })).toBe('succeeded');
    expect(v2TerminalOutcome({ type: 'idle', outcome: 'provider.transport' })).toBe('provider.transport');
    expect(v2TerminalOutcome({ type: 'idle' })).toBeUndefined();
    expect(v2TerminalOutcome({ type: 'assistant', outcome: 'succeeded' })).toBeUndefined();
    expect(v2TerminalOutcome(undefined)).toBeUndefined();
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

  it('assembles the answer from the answer channel and keeps a non-answer ordinal out', () => {
    // Measured: the v2 streaming channel is session.text.*, keyed by assistantMessageID
    // and an `ordinal` that separates parts of the same step. Splicing a later ordinal
    // into the answer would fabricate words the model never put there in that channel.
    const seen = reduceV2SliceEvents([
      { type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'O' } },
      { type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'K' } },
      { type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 1, delta: 'REASONING' } },
      { type: 'session.text.ended', data: { sessionID: 'ses_1', ordinal: 0, text: 'OK' } },
    ], 'ses_1');
    expect(seen.assembled).toBe('OK');
    expect(seen.endedText).toBe('OK');
  });

  it('records the terminal event by its own name without inventing the ones it never saw', () => {
    expect(reduceV2SliceEvents([
      { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } },
    ], 'ses_1').terminal).toBe('session.execution.succeeded');
    // Only `succeeded` was ever observed on this install. An unseen terminal name is
    // recorded verbatim rather than being mapped onto a meaning we have not measured.
    expect(reduceV2SliceEvents([
      { type: 'session.execution.something-new', data: { sessionID: 'ses_1' } },
    ], 'ses_1').terminal).toBe('session.execution.something-new');
  });

  it('reads the error a failed terminal carries inline', () => {
    // Measured: after 10 retries the kernel emits `session.execution.failed` carrying the
    // error itself, where `session.execution.interrupted` carries a `reason` instead.
    // Reading whichever one is present is what lets a terminal failure be named at all.
    const seen = reduceV2SliceEvents([
      { type: 'session.execution.failed', data: { sessionID: 'ses_1', error: { type: 'provider.internal', message: 'always refused', status: 500 } } },
    ], 'ses_1');
    expect(seen.terminal).toBe('session.execution.failed');
    expect(seen.errorType).toBe('provider.internal');
    expect(seen.errorMessage).toBe('always refused');
  });

  it('reads the model and step facts the terminal frame carries', () => {
    const seen = reduceV2SliceEvents([
      { type: 'session.step.started', data: { sessionID: 'ses_1', model: { id: 'alpha', providerID: 'p' } } },
      { type: 'session.step.ended', data: { sessionID: 'ses_1', finish: 'stop', cost: 0, tokens: { output: 7 } } },
    ], 'ses_1');
    expect(seen.modelId).toBe('p/alpha');
    expect(seen.finish).toBe('stop');
    expect(seen.cost).toBe(0);
    expect(seen.outputTokens).toBe(7);
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

  it('reports answered with the streamed answer and whether the kernel agreed', async () => {
    const child = fakeServeChild(READY);
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'O' } }),
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'K' } }),
      frame({ type: 'session.text.ended', data: { sessionID: 'ses_1', ordinal: 0, text: 'OK' } }),
      frame({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }),
    ]));
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [{ type: 'idle', outcome: 'succeeded' }] }]])) as never,
      openEventStream: openEventStream as never,
    });
    expect(reading).toMatchObject({
      status: 'answered', answer: 'OK', streamed: true, confirmed: true,
      outcome: 'succeeded', leftover: false,
    });
  });

  it('says the kernel disagreed when its ended frame differs from the delta assembly', async () => {
    // The two are independent reads of one run. Smoothing over a disagreement would let a
    // panel launder "I saw fragments" into "the kernel confirmed them" — the refusal
    // 0.2.56 made for the 1.x stream probe.
    const child = fakeServeChild(READY);
    const openEventStream = vi.fn(async () => eventStream([
      frame({ type: 'session.text.delta', data: { sessionID: 'ses_1', ordinal: 0, delta: 'O' } }),
      frame({ type: 'session.text.ended', data: { sessionID: 'ses_1', ordinal: 0, text: 'OK!' } }),
    ]));
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [{ type: 'idle', outcome: 'succeeded' }] }]])) as never,
      openEventStream: openEventStream as never,
    });
    expect(reading).toMatchObject({ streamed: true, confirmed: false });
  });

  it('reports failed when the kernel recorded a terminal that is not a success', async () => {
    // `OPENCODE_SIMULATE` parks a run in a named provider.transport retry; that terminal
    // is a failure the reader must be able to see, not a silent absence of an answer.
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [
        { type: 'idle', outcome: 'provider.transport' },
        { type: 'assistant', model: { id: 'a', providerID: 'p' }, content: [], retry: { attempt: 3 } },
      ] }]])) as never,
      openEventStream: vi.fn(async () => eventStream([
        frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
        frame({ type: 'session.retry.scheduled', data: { sessionID: 'ses_1' } }),
      ])) as never,
    });
    expect(reading.status).toBe('failed');
    expect(reading.outcome).toBe('provider.transport');
    expect(reading.answer).toBeUndefined();
  });

  it('does not turn a successful terminal with no text into an answer', async () => {
    // A run that finished without saying anything is neither an answer nor a failure.
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [
        { type: 'idle', outcome: 'succeeded' },
        { type: 'assistant', model: { id: 'a', providerID: 'p' }, content: [] },
      ] }]])) as never,
      openEventStream: vi.fn(async () => eventStream([
        frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
      ])) as never,
    });
    expect(reading.status).toBe('admitted');
    expect(reading.outcome).toBe('succeeded');
    expect(reading.answer).toBeUndefined();
  });

  it('reports a mid-run disconnect without discarding the legs it had already proven', async () => {
    // The run was enqueued, delivered and started; then the server stopped answering.
    // Before this, that throw escaped `run()` and the whole reading was replaced with the
    // never-started default — so the panel claimed setup never completed, and the three
    // legs this run had already proven disappeared with it.
    const child = fakeServeChild(READY);
    let reads = 0;
    const request = vi.fn(async (url: string) => {
      if (String(url).includes('/message')) {
        reads++;
        if (reads > 1) throw new Error('socket hang up');
        return { data: [] };
      }
      return requestRouter([
        [/\/prompt/u, { data: { id: 'msg_1', admittedSeq: 1 } }],
        [/\?directory=/u, {}],
        [/\/interrupt/u, {}],
        [/\/api\/session$/u, { data: { id: 'ses_1' } }],
      ])(url);
    });
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 40,
      request: request as never,
      openEventStream: vi.fn(async () => eventStream([
        frame({ type: 'session.inbox.enqueued', data: { sessionID: 'ses_1' } }),
        frame({ type: 'session.inbox.delivered', data: { sessionID: 'ses_1', inboxID: 'i1' } }),
        frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
      ])) as never,
    });
    expect(reading.status).toBe('disconnected');
    // The legs observed before the drop are facts; a lost connection does not un-earn them.
    expect(reading.enqueued).toBe(true);
    expect(reading.delivered).toBe(true);
    expect(reading.started).toBe(true);
  });

  it('still reports an unreachable kernel as unavailable, never as disconnected', async () => {
    // The fix must not turn every failure into "the link dropped": a server that never
    // came up observed no run at all, and that sentence must stay the one that fits.
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 40,
      request: vi.fn(async () => { throw new Error('socket hang up'); }) as never,
      openEventStream: vi.fn(async () => eventStream([])) as never,
    });
    expect(reading.status).toBe('unavailable');
    expect(reading.started).toBe(false);
  });

  it('reports interrupted when the kernel ended the run and said who asked', async () => {
    // Measured on 2.0.32: an interrupt inside a run yields
    // `session.execution.interrupted {reason:"user"}`, a `session.step.failed` carrying
    // `{type:"aborted"}`, and an idle row whose outcome is "interrupted".
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [
        { type: 'idle', outcome: 'interrupted' },
        { type: 'assistant', content: [], finish: 'error', error: { type: 'aborted', message: 'Step interrupted' } },
      ] }]])) as never,
      openEventStream: vi.fn(async () => eventStream([
        frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
        frame({ type: 'session.step.failed', data: { sessionID: 'ses_1', error: { type: 'aborted', message: 'Step interrupted' } } }),
        frame({ type: 'session.execution.interrupted', data: { sessionID: 'ses_1', reason: 'user' } }),
      ])) as never,
    });
    expect(reading.status).toBe('interrupted');
    expect(reading.terminal).toBe('session.execution.interrupted');
    expect(reading.reason).toBe('user');
    expect(reading.outcome).toBe('interrupted');
  });

  it('reports the named failure the kernel raised, before any terminal arrives', async () => {
    const child = fakeServeChild(READY);
    const reading = await detectOpencodeV2ExecutionSlice('opencode', '/vault', {
      spawn: vi.fn(() => child as never), platform: 'linux', env: {}, settleMs: 20,
      request: requestRouter(baseRoutes([[/\/message/u, { data: [
        { type: 'assistant', model: { id: 'a', providerID: 'p' }, content: [], retry: { attempt: 3 } },
      ] }]])) as never,
      openEventStream: vi.fn(async () => eventStream([
        frame({ type: 'session.execution.started', data: { sessionID: 'ses_1' } }),
        frame({ type: 'session.retry.scheduled', data: { sessionID: 'ses_1', error: { type: 'provider.internal', message: 'fake upstream refused', status: 500 } } }),
        frame({ type: 'session.retry.scheduled', data: { sessionID: 'ses_1', error: { type: 'provider.internal', message: 'later attempt', status: 500 } } }),
      ])) as never,
    });
    expect(reading.status).toBe('failed');
    // The FIRST named failure, not the last: a reader shown the eighth retry's error has
    // lost the one that started the trouble.
    expect(reading.errorType).toBe('provider.internal');
    expect(reading.errorMessage).toBe('fake upstream refused');
    expect(reading.retries).toBe(2);
    expect(reading.terminal).toBeUndefined();
  });

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
