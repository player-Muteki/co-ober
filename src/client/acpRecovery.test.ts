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
    requests: Array<{ method: string; params: unknown }> = [];
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

    onRequest(_method: string, _cb: unknown): void {}

    request(method: string, params?: unknown): Promise<unknown> {
      this.requests.push({ method, params });
      return this.deferred.promise;
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
});
