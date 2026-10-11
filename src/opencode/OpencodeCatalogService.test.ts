import { describe, expect, it, vi } from 'vitest';
import type { detectOpencodeNativeCatalog, OpencodeCatalogObservation } from './OpencodeCatalog';
import { OpencodeCatalogService } from './OpencodeCatalogService';

const observed: OpencodeCatalogObservation = {
  status: 'observed',
  models: [{ modelId: 'p/a', name: 'Alpha', context: undefined }],
  commands: [],
  agents: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OpencodeCatalogService', () => {
  it('does no work until explicit refresh and publishes a read-only observation', async () => {
    const read = vi.fn<typeof detectOpencodeNativeCatalog>().mockResolvedValue(observed);
    const service = new OpencodeCatalogService(read);
    service.setSource({ cliPath: 'opencode', cwd: '/vault', env: {} });
    expect(read).not.toHaveBeenCalled();
    expect(service.getSnapshot().observation).toBeNull();
    expect(await service.refresh({ cliPath: 'opencode', cwd: '/vault', env: {} })).toBe(true);
    expect(service.getSnapshot()).toEqual({ loading: false, observation: observed, stale: false, unavailable: false });
  });

  it('keeps the previous roster, marked stale, until the new source is explicitly refreshed', async () => {
    const read = vi.fn<typeof detectOpencodeNativeCatalog>().mockResolvedValue(observed);
    const service = new OpencodeCatalogService(read);
    await service.refresh({ cliPath: 'old', cwd: '/vault', env: {} });
    service.setSource({ cliPath: 'new', cwd: '/other', env: {} });
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot()).toMatchObject({ observation: observed, stale: true });
    await service.refresh({ cliPath: 'new', cwd: '/other', env: {} });
    expect(service.getSnapshot().stale).toBe(false);
  });

  it('preserves the previous roster when refresh is unreachable instead of certifying emptiness', async () => {
    const read = vi
      .fn<typeof detectOpencodeNativeCatalog>()
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce({ status: 'unavailable', models: [], commands: [], agents: [] });
    const service = new OpencodeCatalogService(read);
    const source = { cliPath: 'opencode', cwd: '/vault', env: {} };
    await service.refresh(source);
    await service.refresh(source);
    expect(service.getSnapshot()).toEqual({ loading: false, observation: observed, stale: true, unavailable: true });
  });

  it('lets the newest refresh win even when the older request returns last', async () => {
    const old = deferred<OpencodeCatalogObservation>();
    const fresh = deferred<OpencodeCatalogObservation>();
    const read = vi
      .fn<typeof detectOpencodeNativeCatalog>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const service = new OpencodeCatalogService(read);
    const source = { cliPath: 'opencode', cwd: '/vault', env: {} };
    const first = service.refresh(source);
    const second = service.refresh(source);
    const latest: OpencodeCatalogObservation = {
      status: 'observed',
      models: [],
      commands: [{ name: 'init', description: undefined }],
      agents: [],
    };
    fresh.resolve(latest);
    expect(await second).toBe(true);
    old.resolve(observed);
    expect(await first).toBe(false);
    expect(service.getSnapshot().observation).toEqual(latest);
  });

  it('does not cancel a read merely because environment keys were reordered', async () => {
    const result = deferred<OpencodeCatalogObservation>();
    const service = new OpencodeCatalogService(() => result.promise);
    const pending = service.refresh({ cliPath: 'opencode', cwd: '/vault', env: { A: '1', B: '2' } });
    service.setSource({ cliPath: 'opencode', cwd: '/vault', env: { B: '2', A: '1' } });
    expect(service.getSnapshot().loading).toBe(true);
    result.resolve(observed);
    expect(await pending).toBe(true);
  });

  it('clears loading and reports a reader failure without throwing', async () => {
    const service = new OpencodeCatalogService(async () => {
      throw new Error('reader failed');
    });
    await service.refresh({ cliPath: 'opencode', cwd: '/vault', env: {} });
    expect(service.getSnapshot()).toEqual({ loading: false, observation: null, stale: false, unavailable: true });
  });

  it('cancel settles without waiting for an uncooperative reader', async () => {
    const result = deferred<OpencodeCatalogObservation>();
    const service = new OpencodeCatalogService(() => result.promise);
    const pending = service.refresh({ cliPath: 'opencode', cwd: '/vault', env: {} });
    service.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still pending'), 40);
      }),
    ]);
    clearTimeout(timer);
    result.resolve(observed);
    expect(settled).toBe(false);
  });

  it('fences an environment change made while the read is in flight', async () => {
    const result = deferred<OpencodeCatalogObservation>();
    const env = { OPENCODE_DB: '/old.db' };
    const read = vi.fn<typeof detectOpencodeNativeCatalog>(() => result.promise);
    const service = new OpencodeCatalogService(read);
    const pending = service.refresh({ cliPath: 'opencode', cwd: '/vault', env });
    env.OPENCODE_DB = '/new.db';
    expect(read.mock.calls[0][2]?.env?.OPENCODE_DB).toBe('/old.db');
    result.resolve(observed);
    expect(await pending).toBe(false);
    expect(service.getSnapshot().observation).toBeNull();
  });

  it('cancels an old source and never publishes its late catalog', async () => {
    const old = deferred<OpencodeCatalogObservation>();
    const read = vi.fn<typeof detectOpencodeNativeCatalog>(() => old.promise);
    const service = new OpencodeCatalogService(read);
    const pending = service.refresh({ cliPath: 'old', cwd: '/vault', env: { OPENCODE_DB: '/old.db' } });
    const signal = read.mock.calls[0][2]?.signal;
    service.setSource({ cliPath: 'new', cwd: '/vault', env: { OPENCODE_DB: '/new.db' } });
    expect(signal?.aborted).toBe(true);
    old.resolve(observed);
    expect(await pending).toBe(false);
    expect(service.getSnapshot()).toMatchObject({ loading: false, observation: null });
  });
});
