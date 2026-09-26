import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeSubprocess {
    static instances: FakeSubprocess[] = [];
    stdout = { fake: 'stdout' };
    stdin = { fake: 'stdin' };
    started = false;
    shutdownCalls = 0;
    stderrSnapshot = '';
    exitInfo: { code: number | null; signal: string | null } | null = null;
    closeCb: ((error?: Error) => void) | null = null;

    constructor(public spec: unknown) {
      FakeSubprocess.instances.push(this);
    }

    start(): this {
      this.started = true;
      return this;
    }

    onClose(cb: (error?: Error) => void): void {
      this.closeCb = cb;
    }

    getStderrSnapshot(): string {
      return this.stderrSnapshot;
    }

    shutdown(): Promise<void> {
      this.shutdownCalls++;
      return Promise.resolve();
    }
  }

  class FakeTransport {
    static instances: FakeTransport[] = [];
    notifications = new Map<string, (params: unknown) => void>();
    sentNotifications: Array<{ method: string; params: unknown }> = [];
    requests: Array<{ method: string; params: unknown }> = [];
    serverRequests = new Map<string, (params: unknown) => Promise<unknown>>();
    disposed = false;
    disposeError: Error | null = null;
    deferred!: { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };

    constructor(_opts: unknown) {
      FakeTransport.instances.push(this);
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.deferred = { promise, resolve, reject };
    }

    start(): void {}

    onNotification(method: string, cb: (params: unknown) => void): void {
      this.notifications.set(method, cb);
    }

    onRequest(method: string, cb: (params: unknown) => Promise<unknown>): void {
      this.serverRequests.set(method, cb);
    }

    request(method: string, params?: unknown): Promise<unknown> {
      this.requests.push({ method, params });
      return this.deferred.promise;
    }

    notify(method: string, params?: unknown): void {
      this.sentNotifications.push({ method, params });
    }

    dispose(error?: Error): void {
      this.disposed = true;
      this.disposeError = error ?? null;
    }
  }

  return { FakeSubprocess, FakeTransport };
});

vi.mock('./AcpSubprocess', () => ({ AcpSubprocess: mocks.FakeSubprocess }));
vi.mock('./AcpJsonRpcTransport', () => ({ AcpJsonRpcTransport: mocks.FakeTransport }));

import { AcpClient } from './acp';
import { AcpTimeoutError } from './AcpErrors';
import { ACP_LOAD_SESSION_IDLE_TIMEOUT_MS } from '../constants';
import type { NormalizedUpdate } from '../types';

const { FakeSubprocess, FakeTransport } = mocks;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function agentChunk(title: string): unknown {
  return { update: { sessionUpdate: 'session_info_update', title } };
}

describe('AcpClient generation fencing', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('successful connect bumps the generation once and marks the client connected', async () => {
    const client = new AcpClient('opencode', '/vault');
    const gen0 = client.generation;
    const connecting = client.connect();
    await tick();
    FakeTransport.instances[0].deferred.resolve({ agentCapabilities: { loadSession: true } });
    await connecting;

    expect(client.generation).toBe(gen0 + 1);
    expect(client.isConnected()).toBe(true);
    expect(client.getAgentCapabilities()).toEqual({ loadSession: true });
  });

  it('a connect superseded by disconnect rejects and never marks the client connected', async () => {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();

    await client.disconnect();
    expect(client.isConnected()).toBe(false);
    expect(FakeSubprocess.instances[0].shutdownCalls).toBe(1);

    // The old initialize response now arrives; the stale continuation must abandon.
    FakeTransport.instances[0].deferred.resolve({ agentCapabilities: {} });
    await expect(connecting).rejects.toThrow(/superseded/);
    expect(client.isConnected()).toBe(false);
    expect(FakeTransport.instances[0].disposed).toBe(true);
    expect(FakeSubprocess.instances[0].shutdownCalls).toBe(2);
  });

  it('a failed connect on the current generation disposes state and fires onClose', async () => {
    const client = new AcpClient('opencode', '/vault');
    const onClose = vi.fn();
    client.onClose = onClose;

    const connecting = client.connect();
    await tick();
    FakeTransport.instances[0].deferred.reject(new Error('initialize boom'));

    await expect(connecting).rejects.toThrow('initialize boom');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
    expect(FakeSubprocess.instances[0].shutdownCalls).toBe(1);
  });

  it('drops session/update notifications arriving on a superseded transport', async () => {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();
    FakeTransport.instances[0].deferred.resolve({});
    await connecting;

    const notify = FakeTransport.instances[0].notifications.get('session/update');
    expect(notify).toBeDefined();
    notify!(agentChunk('live'));
    expect(client.getSessionInfo()?.title).toBe('live');

    await client.disconnect();
    notify!(agentChunk('ghost'));
    // The late frame never landed, and what the old agent reported for its
    // session left with the connection instead of waiting to be read back.
    expect(client.getSessionInfo()).toBeNull();
  });

  it('forwards replay updates to loadSession while no prompt stream is active', async () => {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();
    FakeTransport.instances[0].deferred.resolve({});
    await connecting;

    const notify = FakeTransport.instances[0].notifications.get('session/update')!;
    const onReplay = vi.fn();
    const loading = client.loadSession('ses_native', '/vault', [], onReplay);

    notify({ update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'from history' } } });
    expect(onReplay).toHaveBeenCalledWith({
      kind: 'message_chunk', role: 'agent', messageId: 'm1',
      chunkText: 'from history', accumulatedText: 'from history',
    });

    await loading;
    notify({ update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'after load' } } });
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('scheduleReconnect skips when a newer generation took over', async () => {
    vi.useFakeTimers();
    const client = new AcpClient('opencode', '/vault');
    Reflect.set(client, 'onReconnect', vi.fn());

    Reflect.get(client, 'scheduleReconnect').call(client);
    Reflect.set(client, 'kernelGeneration', client.generation + 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSubprocess.instances.length).toBe(0);
  });

  it('scheduleReconnect connects when the generation is unchanged', async () => {
    vi.useFakeTimers();
    const client = new AcpClient('opencode', '/vault');
    Reflect.set(client, 'onReconnect', vi.fn());

    Reflect.get(client, 'scheduleReconnect').call(client);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSubprocess.instances.length).toBe(1);
    // Let the pending initialize fail so the reconnect chain unwinds.
    FakeTransport.instances[0].deferred.reject(new Error('stop after test'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('scheduleReconnect fires onReconnectFailed once the attempt budget is exhausted', async () => {
    vi.useFakeTimers();
    const client = new AcpClient('opencode', '/vault');
    Reflect.set(client, 'onReconnect', vi.fn());
    const onReconnectFailed = vi.fn();
    client.onReconnectFailed = onReconnectFailed;
    Reflect.set(client, 'reconnectAttempts', 3); // max: this attempt cannot reschedule

    Reflect.get(client, 'scheduleReconnect').call(client);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(FakeSubprocess.instances.length).toBe(1);
    FakeTransport.instances[0].deferred.reject(new Error('still down'));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(onReconnectFailed).toHaveBeenCalledTimes(1);
  });

  describe('prompt response schema', () => {
    async function connectedClient(): Promise<{ client: AcpClient; transport: InstanceType<typeof FakeTransport> }> {
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({});
      await connecting;
      const transport = FakeTransport.instances[0];
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
      transport.deferred = { promise, resolve, reject };
      return { client, transport };
    }

    it('accepts the full SDK stopReason union incl. cancelled and refusal', async () => {
      for (const stopReason of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'tool_calls', 'interrupted']) {
        FakeSubprocess.instances.length = 0;
        FakeTransport.instances.length = 0;
        const { client, transport } = await connectedClient();
        const p = client.sendMessage('ses-1', [{ type: 'text', text: 'hi' }], () => {});
        await tick();
        transport.deferred.resolve({ stopReason });
        await expect(p).resolves.toMatchObject({ stopReason });
        await client.disconnect().catch(() => {});
      }
    });

    it('passes an unknown stopReason through instead of failing the whole response', async () => {
      FakeSubprocess.instances.length = 0;
      FakeTransport.instances.length = 0;
      const { client, transport } = await connectedClient();
      const p = client.sendMessage('ses-1', [{ type: 'text', text: 'hi' }], () => {});
      await tick();
      transport.deferred.resolve({ stopReason: 'some_new_reason', usage: { totalTokens: 5, inputTokens: 2, outputTokens: 3 } });
      // Rejecting the response would discard its usage as collateral damage;
      // the controller badges unknown reasons instead.
      await expect(p).resolves.toMatchObject({ stopReason: 'some_new_reason' });
    });

    it('a response missing the stop reason falls back to end_turn instead of discarding usage', async () => {
      FakeSubprocess.instances.length = 0;
      FakeTransport.instances.length = 0;
      const { client, transport } = await connectedClient();
      const p = client.sendMessage('ses-1', [{ type: 'text', text: 'hi' }], () => {});
      await tick();
      transport.deferred.resolve({ usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } });
      // Rejecting the whole response over one missing field also threw away
      // its usage; the catch keeps the turn accountable with a neutral badge.
      await expect(p).resolves.toMatchObject({ stopReason: 'end_turn', usage: { totalTokens: 1 } });
    });
  });

  describe('initialize handshake', () => {
    it('closes with notifications/initialized and tolerates a newer protocolVersion', async () => {
      FakeSubprocess.instances.length = 0;
      FakeTransport.instances.length = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({ protocolVersion: 2, agentCapabilities: {} });
      await connecting;

      expect(client.isConnected()).toBe(true);
      const sent = FakeTransport.instances[0].sentNotifications.map((n) => n.method);
      expect(sent).toContain('notifications/initialized');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('protocolVersion 2'));
      warn.mockRestore();
      await client.disconnect().catch(() => {});
    });
  });

  describe('elicitation/complete notification', () => {
    it('routes the elicitation id to onElicitationComplete and ignores malformed frames', async () => {
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({});
      await connecting;

      const seen: string[] = [];
      client.onElicitationComplete = (id) => seen.push(id);
      const notify = FakeTransport.instances[0].notifications.get('elicitation/complete');
      expect(notify).toBeDefined();

      notify!({ elicitationId: 'e1' });
      notify!({ elicitationId: 42 });
      notify!(undefined);
      expect(seen).toEqual(['e1']);

      await client.disconnect();
    });
  });

  describe('normalizer reset guard', () => {
    it('keeps an active stream accumulation when a session resumes mid-flight', async () => {
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({});
      await connecting;
      const transport = FakeTransport.instances[0];
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      transport.deferred = { promise, resolve, reject };
      const notify = transport.notifications.get('session/update')!;

      const chunks: NormalizedUpdate[] = [];
      const first = client.sendMessage('ses-1', [{ type: 'text', text: 'go' }], (u) => chunks.push(u));
      await tick();
      notify({
        sessionId: 'ses-1',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'A' } },
      });

      const resume = client.resumeSession('ses-2');
      await tick();
      notify({
        sessionId: 'ses-1',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'B' } },
      });

      expect(
        chunks.map((c) => (c.kind === 'message_chunk' ? c.accumulatedText : null)),
      ).toEqual(['A', 'AB']);

      transport.deferred.resolve({ stopReason: 'end_turn' });
      await Promise.all([first, resume]);
      await client.disconnect();
    });
  });

  describe('listSessions pagination', () => {
    async function pagingClient(pages: unknown[]): Promise<{ client: AcpClient; calls: Array<{ params: unknown }> }> {
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({});
      await connecting;
      const transport = FakeTransport.instances[0];
      const calls: Array<{ params: unknown }> = [];
      let page = 0;
      transport.request = (method: string, params?: unknown): Promise<unknown> => {
        transport.requests.push({ method, params });
        calls.push({ params });
        return Promise.resolve(pages[Math.min(page++, pages.length - 1)]);
      };
      return { client, calls };
    }

    it('follows nextCursor across pages', async () => {
      const { client, calls } = await pagingClient([
        { sessions: [{ sessionId: 'a' }], nextCursor: 'c1' },
        { sessions: [{ sessionId: 'b' }], nextCursor: null },
      ]);
      const metas = await client.listSessions('/vault');
      expect(metas.map((m) => m.sessionId)).toEqual(['a', 'b']);
      expect((calls[0].params as Record<string, unknown>).cursor).toBeUndefined();
      expect((calls[1].params as Record<string, unknown>).cursor).toBe('c1');
    });

    it('stops looping when the agent repeats a cursor', async () => {
      const { client, calls } = await pagingClient([{ sessions: [], nextCursor: 'x' }]);
      await client.listSessions('/vault');
      expect(calls).toHaveLength(2);
    });

    it('caps the number of pages even against a cursor that keeps changing', async () => {
      let n = 0;
      const client = new AcpClient('opencode', '/vault');
      const connecting = client.connect();
      await tick();
      FakeTransport.instances[0].deferred.resolve({});
      await connecting;
      const transport = FakeTransport.instances[0];
      let calls = 0;
      transport.request = (method: string, params?: unknown): Promise<unknown> => {
        transport.requests.push({ method, params });
        calls += 1;
        return Promise.resolve({ sessions: [], nextCursor: `c${n++}` });
      };
      await client.listSessions('/vault');
      expect(calls).toBe(10);
    });
  });
});

describe('permission handler wiring', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  const permissionParams = {
    sessionId: 'ses_1',
    toolCall: { toolCallId: 'tc1', title: 'edit file', kind: 'edit', status: 'pending' },
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
    ],
  };

  async function connectedClient() {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();
    const transport = FakeTransport.instances[0];
    transport.deferred.resolve({ agentCapabilities: {} });
    await connecting;
    return { client, transport };
  }

  it('routes permission frames to a handler bound after the first connect', async () => {
    const { client, transport } = await connectedClient();
    const handler = vi.fn(async () => 'allow_once');
    client.setClientHandlers({ onPermissionRequest: handler });

    const onPermission = transport.serverRequests.get('session/request_permission');
    expect(onPermission).toBeDefined();
    await expect(onPermission!(permissionParams)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps the built-in reject fallback when no handler was ever bound', async () => {
    const { transport } = await connectedClient();
    const onPermission = transport.serverRequests.get('session/request_permission')!;
    await expect(onPermission(permissionParams)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    });
  });
});

describe('0.1.40 stage 2 protocol pack', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Connected client whose post-handshake requests hang until resolved. */
  async function connectedPendingClient() {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();
    const transport = FakeTransport.instances[0];
    transport.deferred.resolve({ agentCapabilities: {} });
    await connecting;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    transport.deferred = { promise, resolve, reject };
    return { client, transport };
  }

  it('sends session/cancel as notifications and resolves without a response', async () => {
    const { client, transport } = await connectedPendingClient();
    const requestsBefore = transport.requests.length;

    await expect(client.cancel('ses_1')).resolves.toBeUndefined();

    const methods = transport.sentNotifications.map((n) => n.method);
    expect(methods).toContain('session/cancel');
    expect(methods).toContain('cancel');
    const frame = transport.sentNotifications.find((n) => n.method === 'session/cancel');
    expect(frame?.params).toEqual({ sessionId: 'ses_1' });
    // Nothing awaited a response, so no request went out for the cancel.
    expect(transport.requests).toHaveLength(requestsBefore);
  });

  it('cancel still aborts the local prompt stream and clears its slot', async () => {
    const { client, transport } = await connectedPendingClient();
    const sending = client.sendMessage('ses_1', [{ type: 'text', text: 'hi' }], () => {});
    await tick();
    const streams = Reflect.get(client, 'activeStreams') as Map<string, unknown>;
    expect(streams.has('ses_1')).toBe(true);

    await client.cancel('ses_1');
    expect(streams.has('ses_1')).toBe(false);

    // The hang-up prompt must not keep the test transport pending forever.
    transport.deferred.resolve({ stopReason: 'cancelled' });
    await sending.catch(() => {});
  });

  it('times out a stalled session/load once the idle window passes with no replay', async () => {
    const { client } = await connectedPendingClient();
    vi.useFakeTimers();
    const loading = client.loadSession('ses_big', '/vault', [], () => {});
    let outcome: 'pending' | 'resolved' | unknown = 'pending';
    loading.then(
      () => (outcome = 'resolved'),
      (e: unknown) => (outcome = e),
    );

    await vi.advanceTimersByTimeAsync(ACP_LOAD_SESSION_IDLE_TIMEOUT_MS + 1000);
    expect(outcome).not.toBe('pending');
    expect(outcome).toBeInstanceOf(AcpTimeoutError);
    expect((outcome as Error).message).toMatch(/timed out/);
  });

  it('a replay update refreshes the load deadline', async () => {
    const { client, transport } = await connectedPendingClient();
    vi.useFakeTimers();
    const notify = transport.notifications.get('session/update')!;
    const onReplay = vi.fn();
    const loading = client.loadSession('ses_big', '/vault', [], onReplay);
    let failure: unknown = null;
    loading.catch((e: unknown) => (failure = e));

    await vi.advanceTimersByTimeAsync(25_000);
    notify({
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'chunk' } },
    });
    // 50s total since the request, but only 25s since the replay ticked.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(failure).toBe(null);

    transport.deferred.resolve({ sessionId: 'ses_big' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(loading).resolves.toBeUndefined();
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it('surfaces the real exit code and stderr tail when the agent process closes', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = await connectedPendingClient();
    const subprocess = FakeSubprocess.instances[0];
    subprocess.stderrSnapshot = 'panic: model registry unreachable';
    subprocess.exitInfo = { code: 3, signal: null };

    subprocess.closeCb!(undefined);
    await tick();

    const disposeError = FakeTransport.instances[0].disposeError;
    expect(disposeError).not.toBeNull();
    expect(disposeError!.message).toContain('code 3');
    expect(disposeError!.message).toContain('panic: model registry unreachable');
    errorLog.mockRestore();
    await client.disconnect().catch(() => {});
  });
});

describe('a resume that replays for a long time (0.2.5 stage 2)', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectedPendingClient() {
    const client = new AcpClient('opencode', '/vault');
    const connecting = client.connect();
    await tick();
    const transport = FakeTransport.instances[0];
    transport.deferred.resolve({ agentCapabilities: {} });
    await connecting;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    transport.deferred = { promise, resolve, reject };
    return { client, transport };
  }

  it('judges a stalled session/resume by the idle window, as a load is judged', async () => {
    const { client, transport } = await connectedPendingClient();
    vi.useFakeTimers();
    const requestsBefore = transport.requests.length;

    const resuming = client.resumeSession('ses_big', '/vault', () => {});
    let failure: unknown = null;
    resuming.catch((e: unknown) => (failure = e));

    await vi.advanceTimersByTimeAsync(ACP_LOAD_SESSION_IDLE_TIMEOUT_MS + 1000);
    expect(failure).toBeInstanceOf(AcpTimeoutError);
    expect((failure as Error).message).toMatch(/timed out/);
    // The bounded race is the only difference from a load; the request itself
    // is still the plain resume the agent advertised.
    expect(transport.requests.slice(requestsBefore).map((r) => r.method)).toContain('session/resume');
  });

  it('lets a replay update keep the resume alive past the window it started in', async () => {
    const { client, transport } = await connectedPendingClient();
    vi.useFakeTimers();
    const notify = transport.notifications.get('session/update')!;
    const onReplay = vi.fn();

    const resuming = client.resumeSession('ses_big', '/vault', onReplay);
    let failure: unknown = null;
    resuming.catch((e: unknown) => (failure = e));

    await vi.advanceTimersByTimeAsync(25_000);
    notify({
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'chunk' } },
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(failure).toBe(null);

    transport.deferred.resolve({ sessionId: 'ses_big' });
    await expect(resuming).resolves.toBeUndefined();
    expect(onReplay).toHaveBeenCalledTimes(1);
  });
});

describe('0.2.3 stage 1 negotiation honesty', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  type FakeWire = (typeof FakeTransport)['instances'][number];

  /** What the agent was told this client honours, read off the wire. */
  function advertised(transport: FakeWire): Record<string, unknown> {
    const params = transport.requests[0]?.params as { clientCapabilities?: Record<string, unknown> } | undefined;
    return params?.clientCapabilities ?? {};
  }

  async function connectWith(client: AcpClient, initResult: Record<string, unknown>): Promise<FakeWire> {
    const connecting = client.connect();
    await tick();
    const transport = FakeTransport.instances[FakeTransport.instances.length - 1];
    transport.deferred.resolve(initResult);
    await connecting;
    return transport;
  }

  it('advertises the tier set before connect instead of the defaults', async () => {
    const client = new AcpClient('opencode', '/vault');
    client.setFsCapabilityMode('readonly');
    client.setTerminalCapabilityMode('disabled');

    const transport = await connectWith(client, { protocolVersion: 1, agentCapabilities: {} });

    expect(advertised(transport).fs).toEqual({ readTextFile: true, writeTextFile: false });
    expect(advertised(transport).terminal).toBeUndefined();
    await client.disconnect().catch(() => {});
  });

  it('carries the tier across a reconnect, whose handler is freshly built', async () => {
    const client = new AcpClient('opencode', '/vault');
    await connectWith(client, { protocolVersion: 1, agentCapabilities: {} });
    client.setFsCapabilityMode('readonly');
    await client.disconnect().catch(() => {});

    const transport = await connectWith(client, { protocolVersion: 1, agentCapabilities: {} });

    expect(advertised(transport).fs).toEqual({ readTextFile: true, writeTextFile: false });
    await client.disconnect().catch(() => {});
  });

  it('records the protocol version the agent negotiated and says it out loud', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new AcpClient('opencode', '/vault');

    await connectWith(client, { protocolVersion: 2, agentCapabilities: {} });

    expect(client.agentProtocolVersion).toBe(2);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('protocolVersion 2'))).toBe(true);
    warn.mockRestore();
    await client.disconnect().catch(() => {});
  });

  it('forgets the negotiated version once the connection is gone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new AcpClient('opencode', '/vault');
    await connectWith(client, { protocolVersion: 2, agentCapabilities: {} });
    warn.mockRestore();

    await client.disconnect().catch(() => {});

    expect(client.agentProtocolVersion).toBeNull();
  });

  it('records a v1 handshake without a mismatch warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new AcpClient('opencode', '/vault');

    await connectWith(client, { protocolVersion: 1, agentCapabilities: {} });

    expect(client.agentProtocolVersion).toBe(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('protocolVersion'))).toBe(false);
    warn.mockRestore();
    await client.disconnect().catch(() => {});
  });
});

describe('0.2.4 stage 2 teardown that cannot finish', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still reports the death and retries when the teardown itself throws', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = new AcpClient('opencode', '/vault');
    const onClose = vi.fn();
    client.onClose = onClose;

    const connecting = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeTransport.instances[0].deferred.resolve({});
    await connecting;

    // A transport that refuses to let go must not be allowed to keep the
    // conversation looking alive: Send was still lit on a dead agent.
    FakeTransport.instances[0].dispose = () => {
      throw new Error('dispose hung');
    };
    FakeSubprocess.instances[0].closeCb!(new Error('agent died'));
    await vi.advanceTimersByTimeAsync(0);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(Reflect.get(client, 'reconnectAttempts')).toBe(1);

    errorLog.mockRestore();
    await client.disconnect().catch(() => {});
  });
});