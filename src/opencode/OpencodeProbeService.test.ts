import { describe, expect, it, vi } from 'vitest';
import { OpencodeProbeService, type OpencodeProbeReader } from './OpencodeProbeService';

interface Reading { status: 'executed' | 'admitted' | 'unavailable'; answer: string }

const executed: Reading = { status: 'executed', answer: 'first' };
const admitted: Reading = { status: 'admitted', answer: 'second' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const source = { cliPath: 'opencode', cwd: '/vault', env: {} };

describe('OpencodeProbeService', () => {
  it('does no work until the reader presses its button and publishes what the probe observed', async () => {
    const read = vi.fn<OpencodeProbeReader<Reading>>().mockResolvedValue(executed);
    const service = new OpencodeProbeService(read);
    service.setSource(source);
    expect(read).not.toHaveBeenCalled();
    expect(service.getSnapshot()).toEqual({ running: false, reading: null, stale: false });
    expect(await service.run(source)).toBe(true);
    expect(service.getSnapshot()).toEqual({ running: false, reading: executed, stale: false });
  });

  it('hands the reader the captured source, its own signal, and no environment it can mutate', async () => {
    const read = vi.fn<OpencodeProbeReader<Reading>>().mockResolvedValue(executed);
    const service = new OpencodeProbeService(read);
    const env = { OPENCODE_DB: '/old.db' };
    await service.run({ cliPath: 'opencode', cwd: '/vault', env });
    env.OPENCODE_DB = '/new.db';
    expect(read.mock.calls[0][0]).toBe('opencode');
    expect(read.mock.calls[0][1]).toBe('/vault');
    expect(read.mock.calls[0][2]?.env.OPENCODE_DB).toBe('/old.db');
    expect(read.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('settles on cancel without waiting for a reader that ignores its signal', async () => {
    // The probe spends a real model turn. A reader that never settles must not be able to
    // hold the panel hostage after the reader walked away.
    const hanging = deferred<Reading>();
    const service = new OpencodeProbeService(() => hanging.promise);
    const pending = service.run(source);
    const signal = service.getSnapshot();
    expect(signal.running).toBe(true);
    service.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending,
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('still pending'), 40); }),
    ]);
    clearTimeout(timer);
    expect(settled).toBe(false);
    expect(service.getSnapshot()).toEqual({ running: false, reading: null, stale: false });
    hanging.resolve(executed);
    // The late answer belongs to a run that was already given up on; it must not appear.
    await Promise.resolve();
    expect(service.getSnapshot().reading).toBeNull();
  });

  it('aborts the signal it handed the reader, so the probe can stop its own server', async () => {
    const read = vi.fn<OpencodeProbeReader<Reading>>(() => deferred<Reading>().promise);
    const service = new OpencodeProbeService(read);
    const pending = service.run(source);
    const signal = read.mock.calls[0][2]?.signal;
    service.cancel();
    expect(signal?.aborted).toBe(true);
    await pending;
  });

  it('keeps the reading a reader already saw, marked stale, when the source changes', async () => {
    const read = vi.fn<OpencodeProbeReader<Reading>>().mockResolvedValue(executed);
    const service = new OpencodeProbeService(read);
    await service.run(source);
    service.setSource({ cliPath: 'new-opencode', cwd: '/vault', env: {} });
    // The reader saw this row, so blanking it would be its own lie; the mark is what says
    // it no longer describes the install standing on screen.
    expect(service.getSnapshot()).toEqual({ running: false, reading: executed, stale: true });
    expect(read).toHaveBeenCalledTimes(1);
    await service.run({ cliPath: 'new-opencode', cwd: '/vault', env: {} });
    expect(service.getSnapshot()).toEqual({ running: false, reading: executed, stale: false });
  });

  it('does not mark a stale reading for a probe that has never run', async () => {
    const service = new OpencodeProbeService(vi.fn<OpencodeProbeReader<Reading>>().mockResolvedValue(executed));
    service.setSource(source);
    service.setSource({ cliPath: 'new-opencode', cwd: '/vault', env: {} });
    expect(service.getSnapshot()).toEqual({ running: false, reading: null, stale: false });
  });

  it('never publishes a reading captured from a source that moved during the run', async () => {
    const result = deferred<Reading>();
    const read = vi.fn<OpencodeProbeReader<Reading>>(() => result.promise);
    const service = new OpencodeProbeService(read);
    const env = { OPENCODE_DB: '/old.db' };
    const pending = service.run({ cliPath: 'opencode', cwd: '/vault', env });
    env.OPENCODE_DB = '/new.db';
    result.resolve(executed);
    expect(await pending).toBe(false);
    expect(service.getSnapshot().reading).toBeNull();
  });

  it('cancels an old source and rejects its late reading when the CLI path changes', async () => {
    const old = deferred<Reading>();
    const read = vi.fn<OpencodeProbeReader<Reading>>(() => old.promise);
    const service = new OpencodeProbeService(read);
    const pending = service.run({ cliPath: 'old', cwd: '/vault', env: {} });
    const signal = read.mock.calls[0][2]?.signal;
    service.setSource({ cliPath: 'new', cwd: '/vault', env: {} });
    expect(signal?.aborted).toBe(true);
    old.resolve(executed);
    expect(await pending).toBe(false);
    expect(service.getSnapshot()).toMatchObject({ running: false, reading: null });
  });

  it('lets the newest probe win even when the older one answers last', async () => {
    const old = deferred<Reading>();
    const fresh = deferred<Reading>();
    const read = vi.fn<OpencodeProbeReader<Reading>>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const service = new OpencodeProbeService(read);
    const first = service.run(source);
    const second = service.run(source);
    fresh.resolve(admitted);
    expect(await second).toBe(true);
    old.resolve(executed);
    expect(await first).toBe(false);
    expect(service.getSnapshot().reading).toEqual(admitted);
  });

  it('does not cancel a run merely because environment keys were reordered', async () => {
    const result = deferred<Reading>();
    const service = new OpencodeProbeService(() => result.promise);
    const pending = service.run({ cliPath: 'opencode', cwd: '/vault', env: { A: '1', B: '2' } });
    service.setSource({ cliPath: 'opencode', cwd: '/vault', env: { B: '2', A: '1' } });
    expect(service.getSnapshot().running).toBe(true);
    result.resolve(executed);
    expect(await pending).toBe(true);
  });

  it('clears running and reports a thrown reader without throwing itself', async () => {
    const service = new OpencodeProbeService(async () => {
      throw new Error('reader failed');
    });
    await service.run(source);
    // A probe that blew up has observed nothing, so there is still no reading to show.
    expect(service.getSnapshot()).toEqual({ running: false, reading: null, stale: false });
  });
});
