import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeSubprocess {
    static instances: FakeSubprocess[] = [];
    stdout = { fake: 'stdout' };
    stdin = { fake: 'stdin' };
    started = false;
    shutdownCalls = 0;
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
      return '';
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

    dispose(): void {
      this.disposed = true;
    }
  }

  return { FakeSubprocess, FakeTransport };
});

vi.mock('./AcpSubprocess', () => ({ AcpSubprocess: mocks.FakeSubprocess }));
vi.mock('./AcpJsonRpcTransport', () => ({ AcpJsonRpcTransport: mocks.FakeTransport }));

import { AcpClient } from './acp';
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
    expect(client.getSessionInfo()?.title).toBe('live');
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
