import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  assistantTextOf,
  detectOpencodeNativeTurnExecution,
} from './OpencodeTurnProbe';

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
  const fn = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    void init;
    for (const [fragment, payload] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (payload instanceof Error) throw payload;
        return typeof payload === 'function' ? (payload as () => unknown)() : payload;
      }
    }
    throw new Error(`unexpected url ${url}`);
  });
  return fn;
}

const READY = 'opencode server listening on http://127.0.0.1:4096';

function sessionRoute(assistantRow: unknown) {
  return requestRouter({
    '/message': { data: [{ type: 'user', text: 'q' }, ...(assistantRow ? [assistantRow] : [])] },
    '/prompt': { data: { id: 'msg_a', admittedSeq: 1 } },
    '/interrupt': {},
    '/api/session': { data: { id: 'ses_1' } },
  });
}

describe('assistantTextOf', () => {
  it('reads the answer text only from an assistant row carrying a non-empty text part', () => {
    expect(assistantTextOf({ type: 'assistant', content: [{ type: 'text', text: 'OK' }] })).toBe('OK');
    expect(assistantTextOf({ type: 'user', content: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
    expect(assistantTextOf({ type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] })).toBeUndefined();
    expect(assistantTextOf({ type: 'assistant', content: [{ type: 'text', text: '   ' }] })).toBeUndefined();
    expect(assistantTextOf({ type: 'assistant' })).toBeUndefined();
    expect(assistantTextOf(undefined)).toBeUndefined();
  });
});

describe('detectOpencodeNativeTurnExecution', () => {
  it('reports executed only when an assistant text part is actually read back', async () => {
    const child = fakeServeChild(READY);
    const spawn = vi.fn(() => child);
    const request = sessionRoute({
      type: 'assistant',
      model: { id: 'alpha', providerID: 'opencode' },
      finish: 'stop',
      tokens: { output: 7 },
      content: [{ type: 'reasoning', text: 'must' }, { type: 'text', text: 'OK' }],
    });
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: spawn as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 3,
    });
    expect(reading).toEqual({ status: 'executed', modelId: 'opencode/alpha', finish: 'stop', outputTokens: 7 });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps a channel that admits but never answers as admitted, not executed', async () => {
    const child = fakeServeChild(READY);
    const request = sessionRoute(undefined);
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 3,
    });
    expect(reading).toEqual({ status: 'admitted', modelId: undefined, finish: undefined, outputTokens: undefined });
  });

  it('does not count a reasoning-only assistant row as an executed answer', async () => {
    const child = fakeServeChild(READY);
    const request = sessionRoute({ type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] });
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('admitted');
  });

  it('degrades to unavailable when the server never names an address', async () => {
    const child = fakeServeChildFailsToStart();
    const request = vi.fn();
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not spawn when the configured path is blank', async () => {
    const spawn = vi.fn();
    const reading = await detectOpencodeNativeTurnExecution('   ', '/vault', { spawn: spawn as never, platform: 'linux', env: {} });
    expect(reading.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('treats a session that names no id as unavailable and never prompts', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter({ '/api/session': { data: {} } });
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
    expect(request.mock.calls.some(([url]) => String(url).includes('/prompt'))).toBe(false);
  });

  it('treats a prompt the server did not admit as unavailable, not admitted', async () => {
    const child = fakeServeChild(READY);
    const request = requestRouter({
      '/prompt': { data: {} },
      '/api/session': { data: { id: 'ses_1' } },
    });
    const reading = await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    expect(reading.status).toBe('unavailable');
  });

  it('interrupts the throwaway turn during teardown', async () => {
    const child = fakeServeChild(READY);
    const request = sessionRoute({ type: 'assistant', model: { id: 'a', providerID: 'p' }, content: [{ type: 'text', text: 'OK' }] });
    await detectOpencodeNativeTurnExecution('opencode', '/vault', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 3,
    });
    expect(request.mock.calls.some(([url]) => String(url).includes('/interrupt'))).toBe(true);
  });

  it('scopes the probe to the working directory it was handed', async () => {
    const child = fakeServeChild(READY);
    const request = sessionRoute(undefined);
    await detectOpencodeNativeTurnExecution('opencode', '/a vault/dir', {
      spawn: vi.fn(() => child) as never, request: request as never, platform: 'linux', env: {}, pollMs: 0, pollAttempts: 2,
    });
    const createCall = request.mock.calls.find(([url]) => String(url).endsWith('/api/session'));
    expect(createCall?.[1]).toMatchObject({ method: 'POST', body: { location: { directory: '/a vault/dir' } } });
  });
});
