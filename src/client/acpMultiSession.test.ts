import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeSubprocess {
    static instances: FakeSubprocess[] = [];
    stdout = { fake: 'stdout' };
    stdin = { fake: 'stdin' };
    shutdownCalls = 0;

    constructor(_spec: unknown) {
      FakeSubprocess.instances.push(this);
    }

    start(): this { return this; }
    onClose(_cb: (error?: Error) => void): void {}
    getStderrSnapshot(): string { return ''; }
    shutdown(): Promise<void> { this.shutdownCalls++; return Promise.resolve(); }
  }

  type PendingRequest = {
    method: string;
    params: unknown;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };

  class FakeTransport {
    static instances: FakeTransport[] = [];
    notifications = new Map<string, (params: unknown) => void>();
    sentNotifications: Array<{ method: string; params: unknown }> = [];
    requests: PendingRequest[] = [];
    disposed = false;

    constructor(_opts: unknown) {
      FakeTransport.instances.push(this);
    }

    start(): void {}

    onNotification(method: string, cb: (params: unknown) => void): void {
      this.notifications.set(method, cb);
    }

    onRequest(_method: string, _cb: (params: unknown) => Promise<unknown>): void {}

    request(method: string, params?: unknown): Promise<unknown> {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
      this.requests.push({ method, params, resolve, reject });
      return promise;
    }

    notify(method: string, params?: unknown): void {
      this.sentNotifications.push({ method, params });
    }

    dispose(): void { this.disposed = true; }

    pending(methodFragment: string): PendingRequest {
      const found = this.requests.find((r) => r.method.includes(methodFragment));
      if (!found) throw new Error(`no request matching '${methodFragment}'`);
      return found;
    }
  }

  return { FakeSubprocess, FakeTransport };
});

vi.mock('./AcpSubprocess', () => ({ AcpSubprocess: mocks.FakeSubprocess }));
vi.mock('./AcpJsonRpcTransport', () => ({ AcpJsonRpcTransport: mocks.FakeTransport }));

import { AcpClient } from './acp';
import { AgentRuntime } from './agent';
import { AcpStreamCapacityError } from './AcpErrors';
import { MAX_CONCURRENT_STREAMS, MAX_SESSION_NORMALIZERS } from '../constants';
import type { NormalizedUpdate } from '../types';

const { FakeSubprocess, FakeTransport } = mocks;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function agentMsg(messageId: string, text: string): unknown {
  return { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } };
}

async function connected(): Promise<{ client: AcpClient; transport: InstanceType<typeof FakeTransport>; notify: (p: unknown) => void }> {
  const client = new AcpClient('opencode', '/vault');
  const connecting = client.connect();
  await tick();
  const transport = FakeTransport.instances[FakeTransport.instances.length - 1];
  transport.pending('initialize').resolve({});
  await connecting;
  const notify = (p: unknown) => {
    transport.notifications.get('session/update')!(p);
  };
  return { client, transport, notify };
}

describe('AcpClient per-session streams', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  it('accumulates colliding messageIds independently across concurrent sessions', async () => {
    const { client, notify } = await connected();
    const a: NormalizedUpdate[] = [];
    const b: NormalizedUpdate[] = [];
    const pa = client.sendMessage('sA', [], (u) => a.push(u));
    const pb = client.sendMessage('sB', [], (u) => b.push(u));

    notify({ sessionId: 'sA', update: agentMsg('m1', 'A1') });
    notify({ sessionId: 'sB', update: agentMsg('m1', 'B1') });
    notify({ sessionId: 'sA', update: agentMsg('m1', ' + A2') });

    const last = (list: NormalizedUpdate[]) => list[list.length - 1] as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    expect(last(a).accumulatedText).toBe('A1 + A2');
    expect(last(b).accumulatedText).toBe('B1');

    const transport = FakeTransport.instances[0];
    const prompts = transport.requests.filter((r) => r.method.includes('prompt'));
    prompts[0].resolve({ stopReason: 'end_turn' });
    prompts[1].resolve({ stopReason: 'end_turn' });
    await Promise.all([pa, pb]);
  });

  it("a new turn on one session resets only that session's accumulation", async () => {
    const { client, notify } = await connected();
    const transport = FakeTransport.instances[0];
    const prompts = () => transport.requests.filter((r) => r.method.includes('prompt'));
    const a: NormalizedUpdate[] = [];
    const b: NormalizedUpdate[] = [];
    const pa = client.sendMessage('sA', [], (u) => a.push(u));
    const pb = client.sendMessage('sB', [], (u) => b.push(u));

    notify({ sessionId: 'sA', update: agentMsg('m1', 'first') });
    prompts()[0].resolve({ stopReason: 'end_turn' });
    await pa;

    notify({ sessionId: 'sB', update: agentMsg('m1', ' still-busy') });
    const pa2 = client.sendMessage('sA', [], (u) => a.push(u));
    notify({ sessionId: 'sA', update: agentMsg('m1', 'second') });

    const last = (list: NormalizedUpdate[]) => list[list.length - 1] as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    expect(last(a).accumulatedText).toBe('second');
    expect(last(b).accumulatedText).toBe(' still-busy');

    prompts()[2].resolve({ stopReason: 'end_turn' });
    await pa2;
    prompts()[1].resolve({ stopReason: 'end_turn' });
    await pb;
  });

  it('drops frames without a sessionId while two streams are live and warns once', async () => {
    const { client, notify } = await connected();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = vi.fn();
    const b = vi.fn();
    const pa = client.sendMessage('sA', [], a);
    const pb = client.sendMessage('sB', [], b);

    notify({ update: agentMsg('m1', 'ambiguous') });
    notify({ update: agentMsg('m1', 'ambiguous again') });
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('without sessionId'))).toHaveLength(1);

    const transport = FakeTransport.instances[0];
    const prompts = transport.requests.filter((r) => r.method.includes('prompt'));
    prompts[0].resolve({ stopReason: 'end_turn' });
    prompts[1].resolve({ stopReason: 'end_turn' });
    await Promise.all([pa, pb]);
    warn.mockRestore();
  });
});

describe('AcpClient per-session metadata', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  function modelOptions(modelId: string): unknown[] {
    return [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelId, options: [{ value: modelId, name: modelId }] }];
  }

  it("a background loadSession does not clobber the displayed session's metadata", async () => {
    const { client, transport } = await connected();
    const creating = client.createSession();
    transport.pending('session/new').resolve({ sessionId: 'sA', configOptions: modelOptions('model-x') });
    await creating;
    expect(client.getSessionSnapshot().currentModelId).toBe('model-x');

    const loading = client.loadSession('sB');
    transport.pending('session/load').resolve({ configOptions: modelOptions('model-y') });
    await loading;

    expect(client.getSessionSnapshotFor('sA').currentModelId).toBe('model-x');
    expect(client.getSessionSnapshot().currentModelId).toBe('model-y');
    expect(client.isSessionLoaded('sA')).toBe(true);
    expect(client.isSessionLoaded('sB')).toBe(true);
  });

  it("sid-tagged updates land in the owning session's slot only", async () => {
    const { client, transport, notify } = await connected();
    const creating = client.createSession();
    transport.pending('session/new').resolve({ sessionId: 'sA', configOptions: modelOptions('model-x') });
    await creating;

    notify({ sessionId: 'sB', update: { sessionUpdate: 'current_model_update', currentModelId: 'model-z', availableModels: [] } });
    expect(client.getSessionSnapshot().currentModelId).toBe('model-x');
    expect(client.getSessionSnapshotFor('sB').currentModelId).toBe('model-z');
  });
});

describe('AcpClient stream capacity', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  it('rejects the fifth concurrent stream and admits a send once one cancels', async () => {
    const { client, transport } = await connected();
    const streams: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
      streams.push(client.sendMessage(`s${i}`, [], () => {}));
    }
    expect(client.activeStreamCount()).toBe(MAX_CONCURRENT_STREAMS);

    await expect(client.sendMessage('overflow', [], () => {})).rejects.toBeInstanceOf(AcpStreamCapacityError);

    await client.cancel('s0');
    expect(client.activeStreamCount()).toBe(MAX_CONCURRENT_STREAMS - 1);
    const fifth = client.sendMessage('s9', [], () => {});
    expect(client.activeStreamCount()).toBe(MAX_CONCURRENT_STREAMS);
    streams.shift()?.catch(() => {});
    for (const r of transport.requests.filter((req) => req.method.includes('prompt'))) {
      r.resolve({ stopReason: 'end_turn' });
    }
    await Promise.all(streams.slice(1).concat(fifth));
  });
});

describe('AcpClient normalizer lifecycle', () => {
  beforeEach(() => {
    FakeSubprocess.instances.length = 0;
    FakeTransport.instances.length = 0;
  });

  it('LRU-evicts idle per-session normalizers past the cap', async () => {
    const { client, notify } = await connected();
    for (let i = 0; i < MAX_SESSION_NORMALIZERS + 8; i++) {
      notify({ sessionId: `ses-${i}`, update: agentMsg('m1', 'x') });
    }
    const normalizers = Reflect.get(client, 'normalizers') as Map<string, unknown>;
    expect(normalizers.size).toBeLessThanOrEqual(MAX_SESSION_NORMALIZERS);
    // Newest entries survive; the oldest idle ones are evicted.
    expect(normalizers.has(`ses-${MAX_SESSION_NORMALIZERS + 7}`)).toBe(true);
    expect(normalizers.has('ses-0')).toBe(false);
  });

  it('clears normalizers and loaded-session tracking when the connection goes away', async () => {
    const { client, transport, notify } = await connected();
    const creating = client.createSession();
    transport.pending('session/new').resolve({ sessionId: 'sA' });
    await creating;
    notify({ sessionId: 'sA', update: agentMsg('m1', 'x') });
    expect((Reflect.get(client, 'normalizers') as Map<string, unknown>).size).toBe(1);
    expect(client.isSessionLoaded('sA')).toBe(true);

    await client.disconnect();
    expect((Reflect.get(client, 'normalizers') as Map<string, unknown>).size).toBe(0);
    expect(client.isSessionLoaded('sA')).toBe(false);
  });

  it('closeSession drops the loaded-session marker', async () => {
    const { client, transport } = await connected();
    const creating = client.createSession();
    transport.pending('session/new').resolve({ sessionId: 'sA' });
    await creating;
    expect(client.isSessionLoaded('sA')).toBe(true);

    const closing = client.closeSession('sA');
    transport.pending('session/close').resolve({});
    await closing;
    expect(client.isSessionLoaded('sA')).toBe(false);
  });
});

describe('AgentRuntime per-session passthroughs', () => {
  it('delegates getSessionSnapshotFor, isSessionLoaded and activeStreamCount', () => {
    const snapshot = {
      configOptions: [], availableCommands: [], availableModels: [], availableModes: [],
      currentModelId: 'm', currentModeId: null,
    };
    const acp = {
      getSessionSnapshotFor: vi.fn(() => snapshot),
      isSessionLoaded: vi.fn(() => true),
      activeStreamCount: vi.fn(() => 2),
    };
    const runtime = new AgentRuntime(acp as unknown as AcpClient);
    expect(runtime.getSessionSnapshotFor('sX')).toBe(snapshot);
    expect(acp.getSessionSnapshotFor).toHaveBeenCalledWith('sX');
    expect(runtime.isSessionLoaded('sX')).toBe(true);
    expect(runtime.activeStreamCount()).toBe(2);
  });
});
