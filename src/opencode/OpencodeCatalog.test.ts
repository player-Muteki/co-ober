import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseOpencodeServerUrl,
  mapNativeModels,
  mapNativeCommands,
  mapNativeAgents,
  detectOpencodeNativeCatalog,
} from './OpencodeCatalog';

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

describe('detectOpencodeNativeCatalog', () => {
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
