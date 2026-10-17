import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { OpencodeCatalogDeps } from './OpencodeCatalog';
import { PassThrough } from 'stream';
import type { SpawnOptions } from 'child_process';
import {
  parseOpencodeServerUrl,
  mapNativeModels,
  mapNativeCommands,
  mapNativeAgents,
  detectOpencodeNativeCatalog,
  classifyCatalogRoute,
} from './OpencodeCatalog';
import {
  OPENCODE_PASSWORD_ENV,
  OPENCODE_SERVER_PASSWORD_ENV,
  OpencodeServeHttpError,
} from './OpencodeServeAuth';

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
  return vi.fn(async (url: string) => {
    for (const [fragment, payload] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (payload instanceof Error) throw payload;
        return payload;
      }
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('parseOpencodeServerUrl', () => {
  it('reads the loopback address out of the plain-text readiness line', () => {
    expect(parseOpencodeServerUrl('opencode server listening on http://127.0.0.1:4096'))
      .toBe('http://127.0.0.1:4096');
  });

  it('accepts localhost but refuses a non-loopback host', () => {
    expect(parseOpencodeServerUrl('listening on http://localhost:8080')).toBe('http://localhost:8080');
    expect(parseOpencodeServerUrl('listening on http://0.0.0.0:8080')).toBeUndefined();
    expect(parseOpencodeServerUrl('listening on http://example.com:8080')).toBeUndefined();
  });

  it('refuses a credential-bearing or non-http origin rather than contacting it', () => {
    expect(parseOpencodeServerUrl('http://user:pass@127.0.0.1:1')).toBeUndefined();
    expect(parseOpencodeServerUrl('https://127.0.0.1:1')).toBeUndefined();
    expect(parseOpencodeServerUrl('no url here')).toBeUndefined();
  });
});

describe('mapNativeModels', () => {
  it('keeps only enabled rows with a provider and id, naming each by the provider pair', () => {
    const payload = { data: [
      { id: 'alpha', providerID: 'opencode', name: 'Alpha', enabled: true, limit: { context: 1048576 } },
      { id: 'off', providerID: 'opencode', name: 'Off', enabled: false },
      { id: 'noprov', name: 'No Provider', enabled: true },
      { providerID: 'opencode', enabled: true },
    ] };
    const models = mapNativeModels(payload);
    expect(models).toEqual([
      { modelId: 'opencode/alpha', name: 'opencode/Alpha', context: 1048576 },
    ]);
  });

  it('tolerates a missing limit and a non-object payload', () => {
    expect(mapNativeModels({ data: [{ id: 'x', providerID: 'p', enabled: true }] }))
      .toEqual([{ modelId: 'p/x', name: 'p', context: undefined }]);
    expect(mapNativeModels(undefined)).toEqual([]);
    expect(mapNativeModels({ data: 'not-an-array' })).toEqual([]);
  });
});

describe('mapNativeCommands', () => {
  it('lists rows with a string name and carries an optional description', () => {
    const payload = { data: [
      { name: 'init', description: 'guided setup', template: 'long text' },
      { name: 'bare' },
      { template: 'no name' },
    ] };
    expect(mapNativeCommands(payload)).toEqual([
      { name: 'init', description: 'guided setup' },
      { name: 'bare', description: undefined },
    ]);
  });
});

describe('mapNativeAgents', () => {
  it('lists rows with a string id and carries an optional description', () => {
    const payload = { data: [
      { id: 'build', description: 'default', mode: 'primary' },
      { id: 'no-desc' },
      { mode: 'subagent' },
    ] };
    expect(mapNativeAgents(payload)).toEqual([
      { id: 'build', description: 'default' },
      { id: 'no-desc', description: undefined },
    ]);
  });
});

describe('classifyCatalogRoute', () => {
  const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value });
  const rejected = (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason });

  it('reads an answer only from the { data: [...] } dialect', () => {
    expect(classifyCatalogRoute(fulfilled({ data: [] }))).toBe('observed');
    expect(classifyCatalogRoute(fulfilled({}))).toBe('unavailable');
    expect(classifyCatalogRoute(fulfilled('<html>catch-all</html>'))).toBe('unavailable');
    expect(classifyCatalogRoute(fulfilled(null))).toBe('unavailable');
  });

  it('names a refusal the server stated, instead of calling it silence', () => {
    expect(classifyCatalogRoute(rejected(new OpencodeServeHttpError(401, 'responded 401')))).toBe('unauthorized');
    expect(classifyCatalogRoute(rejected(new OpencodeServeHttpError(403, 'responded 403')))).toBe('unauthorized');
  });

  it('leaves a route that simply never answered as unavailable', () => {
    // "Refused" and "did not answer" send the reader to different places: one to the
    // credential, one to the install. A connection failure observed neither.
    expect(classifyCatalogRoute(rejected(new Error('socket hang up')))).toBe('unavailable');
    expect(classifyCatalogRoute(rejected(new OpencodeServeHttpError(404, 'responded 404')))).toBe('unavailable');
    expect(classifyCatalogRoute(rejected(new OpencodeServeHttpError(500, 'responded 500')))).toBe('unavailable');
  });
});

describe('detectOpencodeNativeCatalog', () => {
  it('authenticates the child it spawns with a password it chose itself', async () => {
    // The measured failure this exists for: a v2 kernel answers an unauthenticated read
    // with 401 on every route, and the panel then calls a live, fully-stocked server one
    // that "did not answer". Choosing the credential is what stops that.
    const child = fakeServeChild('server listening on http://127.0.0.1:4096');
    const spawn = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child as never);
    await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn, env: { EXISTING: 'yes' }, platform: 'linux',
      request: requestRouter({ '/api/model': { data: [] }, '/api/command': { data: [] }, '/api/agent': { data: [] } }),
    });
    const servedEnv = spawn.mock.calls[0][2]?.env as Record<string, string>;
    expect(servedEnv.EXISTING).toBe('yes');
    expect(servedEnv[OPENCODE_PASSWORD_ENV]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(servedEnv[OPENCODE_SERVER_PASSWORD_ENV]).toBe(servedEnv[OPENCODE_PASSWORD_ENV]);
  });

  it('reports a refused read as unauthorized rather than as a server that did not answer', async () => {
    const child = fakeServeChild('server listening on http://127.0.0.1:4096');
    const observation = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
      request: vi.fn(async () => { throw new OpencodeServeHttpError(401, 'OpenCode serve responded 401'); }),
    });
    expect(observation.status).toBe('unauthorized');
    expect(observation.routes).toEqual({ models: 'unauthorized', commands: 'unauthorized', agents: 'unauthorized' });
    // A refusal observed nothing, so nothing may be listed from it.
    expect(observation.models).toEqual([]);
    expect(observation.commands).toEqual([]);
    expect(observation.agents).toEqual([]);
  });

  it('still calls an unreachable or malformed route unavailable, not unauthorized', async () => {
    const child = fakeServeChild('server listening on http://127.0.0.1:4096');
    const observation = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
      request: vi.fn(async () => { throw new Error('socket hang up'); }),
    });
    expect(observation.status).toBe('unavailable');
    expect(observation.routes).toEqual({ models: 'unavailable', commands: 'unavailable', agents: 'unavailable' });
  });

  it('keeps the observed routes when a partial read refuses just one of them', async () => {
    const child = fakeServeChild('server listening on http://127.0.0.1:4096');
    const observation = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
      request: vi.fn(async (url: string) => {
        if (url.includes('/api/agent')) throw new OpencodeServeHttpError(403, 'OpenCode serve responded 403');
        if (url.includes('/api/model')) return { data: [{ id: 'a', providerID: 'p', name: 'A', enabled: true, limit: { context: 10 } }] };
        return { data: [] };
      }),
    });
    expect(observation.status).toBe('observed');
    expect(observation.routes).toEqual({ models: 'observed', commands: 'observed', agents: 'unauthorized' });
    // The routes that did answer still report what they actually listed.
    expect(observation.models).toEqual([{ modelId: 'p/a', name: 'p/A', context: 10 }]);
    expect(observation.agents).toEqual([]);
  });

  it('absorbs a delayed spawn error after cancellation until the child closes', async () => {
    const child = fakeServeChild('not ready');
    const controller = new AbortController();
    const pending = detectOpencodeNativeCatalog('opencode', '/vault', {
      signal: controller.signal, spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
    });
    controller.abort();
    await pending;
    expect(() => child.emit('error', new Error('delayed ENOENT'))).not.toThrow();
    child.emit('close', 1);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('does not launch a server for a pre-cancelled read', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();
    const request = vi.fn();
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', { signal: controller.signal, spawn, request });
    expect(result.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels startup and removes the readiness listeners', async () => {
    const child = fakeServeChild('not ready');
    const controller = new AbortController();
    const pending = detectOpencodeNativeCatalog('opencode', '/vault', {
      signal: controller.signal, spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
    });
    controller.abort();
    expect((await pending).status).toBe('unavailable');
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', 0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
  });

  it('never upgrades an aborted read when ignored requests finish late', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let complete!: (value: unknown) => void;
    const late = new Promise<unknown>((resolve) => { complete = resolve; });
    const pending = detectOpencodeNativeCatalog('opencode', '/vault', {
      signal: controller.signal, spawn: vi.fn(() => child as never),
      request: vi.fn(() => { ready(); return late; }), env: {}, platform: 'linux',
    });
    await started;
    controller.abort();
    const result = await pending;
    complete({ data: [] });
    await Promise.resolve();
    expect(result.status).toBe('unavailable');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('records unavailable routes separately from valid empty arrays', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never), env: {}, platform: 'linux',
      request: requestRouter({ '/api/model': { data: [] }, '/api/command': '<html>UI</html>', '/api/agent': new Error('offline') }),
    });
    expect(result).toMatchObject({ status: 'observed', models: [], commands: [], agents: [],
      routes: { models: 'observed', commands: 'unavailable', agents: 'unavailable' } });
  });

  it('captures the launch environment rather than retaining a mutable caller object', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const env = { OPENCODE_DB: '/old.db' };
    const spawn = vi.fn<NonNullable<OpencodeCatalogDeps['spawn']>>(() => child as never);
    const pending = detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn, env, platform: 'linux', request: requestRouter({ '/api/model': { data: [] }, '/api/command': { data: [] }, '/api/agent': { data: [] } }),
    });
    env.OPENCODE_DB = '/new.db';
    await pending;
    expect(spawn.mock.calls[0][2].env?.OPENCODE_DB).toBe('/old.db');
  });

  it('settles at the deadline even when a catalog request ignores abort', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const pending = detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never,
      request: vi.fn(() => new Promise(() => {})), env: {}, platform: 'linux', timeoutMs: 10,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 80); }),
    ]);
    clearTimeout(timer);
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('does not certify HTML or a different JSON dialect as an empty catalog', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const request = requestRouter({
      '/api/model': '<html>web UI</html>',
      '/api/command': { commands: [] },
      '/api/agent': { data: {} },
    });
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never, request: request as never, env: {}, platform: 'linux',
    });
    expect(result.status).toBe('unavailable');
  });

  it('observes the three lists over the discovered loopback address', async () => {
    const child = fakeServeChild('opencode server listening on http://127.0.0.1:4096\n');
    const request = requestRouter({
      '/api/model': { data: [{ id: 'alpha', providerID: 'opencode', name: 'Alpha', enabled: true }] },
      '/api/command': { data: [{ name: 'init', description: 'guided setup' }] },
      '/api/agent': { data: [{ id: 'build', description: 'default' }] },
    });
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never,
      request: request as never,
      platform: 'linux',
      env: {},
    });
    expect(result.status).toBe('observed');
    expect(result.models).toEqual([{ modelId: 'opencode/alpha', name: 'opencode/Alpha', context: undefined }]);
    expect(result.commands).toEqual([{ name: 'init', description: 'guided setup' }]);
    expect(result.agents).toEqual([{ id: 'build', description: 'default' }]);
    // The server is loopback-only and torn down once the read completes.
    expect(request.mock.calls[0][0]).toContain('http://127.0.0.1:4096');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('scopes every read to the workspace directory', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const request = requestRouter({
      '/api/model': { data: [] }, '/api/command': { data: [] }, '/api/agent': { data: [] },
    });
    await detectOpencodeNativeCatalog('opencode', '/a vault/dir', {
      spawn: vi.fn(() => child as never) as never, request: request as never, platform: 'linux', env: {},
    });
    for (const call of request.mock.calls) {
      expect(call[0]).toContain('location%5Bdirectory%5D=%2Fa%20vault%2Fdir');
    }
  });

  it('returns unavailable without spawning or requesting when the path is blank', async () => {
    const spawn = vi.fn();
    const request = vi.fn();
    const result = await detectOpencodeNativeCatalog('   ', '/vault', {
      spawn: spawn as never, request: request as never, platform: 'linux', env: {},
    });
    expect(result.status).toBe('unavailable');
    expect(spawn).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('returns unavailable when the server never announces an address', async () => {
    const child = fakeServeChildFailsToStart();
    const request = vi.fn();
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never, request: request as never, platform: 'linux', env: {},
    });
    expect(result.status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('returns unavailable when every catalog read fails, not an empty-but-confident catalog', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const failure = new Error('boom');
    const request = vi.fn(async () => { throw failure; });
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never, request: request as never, platform: 'linux', env: {},
    });
    expect(result.status).toBe('unavailable');
  });

  it('reports observed on a partial read so a live install is not called empty', async () => {
    const child = fakeServeChild('http://127.0.0.1:4096');
    const request = requestRouter({
      '/api/model': { data: [{ id: 'alpha', providerID: 'opencode', name: 'Alpha', enabled: true }] },
      '/api/command': new Error('command route down'),
      '/api/agent': new Error('agent route down'),
    });
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => child as never) as never, request: request as never, platform: 'linux', env: {},
    });
    expect(result.status).toBe('observed');
    expect(result.models).toHaveLength(1);
    expect(result.commands).toEqual([]);
    expect(result.agents).toEqual([]);
  });

  it('returns unavailable without throwing when the spawn itself fails', async () => {
    const result = await detectOpencodeNativeCatalog('opencode', '/vault', {
      spawn: vi.fn(() => { throw new Error('ENOENT'); }) as never,
      request: vi.fn() as never,
      platform: 'linux',
      env: {},
    });
    expect(result.status).toBe('unavailable');
  });
});
