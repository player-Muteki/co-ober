import { describe, expect, it, vi } from 'vitest';
import {
  OpencodeDiagnosticsService,
  type DiagnosticResult,
  type OpencodeDiagnosticContext,
} from './OpencodeDiagnosticsService';

const source = { cliPath: 'opencode', cwd: '/vault', env: {} };
const results: DiagnosticResult[] = [{ label: 'Version', ok: true, detail: '1.18.33' }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('OpencodeDiagnosticsService', () => {
  it('cancels promptly without depending on the collector and fences its late result', async () => {
    const service = new OpencodeDiagnosticsService();
    const result = deferred<DiagnosticResult[]>();
    const collect = vi.fn<(context: OpencodeDiagnosticContext) => Promise<DiagnosticResult[]>>(() => result.promise);
    const pending = service.run(source, collect);
    service.cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 30);
      }),
    ]);
    clearTimeout(timer);
    expect(settled).toBe(false);
    expect(collect.mock.calls[0]?.[0].signal.aborted).toBe(true);
    result.resolve(results);
    await Promise.resolve();
    expect(service.getSnapshot()).toEqual({ running: false, results: [], failed: false });
  });
  it('captures the source and stops the next stage if the live environment changes', async () => {
    const service = new OpencodeDiagnosticsService();
    const first = deferred<void>();
    const env = { OPENCODE_DB: '/old.db' };
    const nextStage = vi.fn();
    let context!: OpencodeDiagnosticContext;
    const pending = service.run({ ...source, env }, async (captured) => {
      context = captured;
      await first.promise;
      captured.checkCurrent();
      nextStage();
      return results;
    });
    env.OPENCODE_DB = '/new.db';
    expect(context.source.env.OPENCODE_DB).toBe('/old.db');
    first.resolve();
    expect(await pending).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(nextStage).not.toHaveBeenCalled();
    expect(service.getSnapshot().results).toEqual([]);
  });

  it('withdraws old diagnostic passes on source transition without an automatic run', async () => {
    const service = new OpencodeDiagnosticsService();
    const collect = vi.fn(async () => results);
    expect(await service.run(source, collect)).toBe(true);
    expect(service.getSnapshot().results).toEqual(results);
    service.setSource({ ...source, cliPath: 'other' });
    expect(service.getSnapshot()).toEqual({ running: false, results: [], failed: false });
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('lets a retry win and suppresses the older collector rejection', async () => {
    const service = new OpencodeDiagnosticsService();
    let reject!: (error: Error) => void;
    let oldSignal!: AbortSignal;
    const first = service.run(source, (context) => {
      oldSignal = context.signal;
      return new Promise((_, fail) => {
        reject = fail;
      });
    });
    const latest = [{ label: 'Version', ok: true, detail: 'new' }];
    const second = service.run(source, async () => latest);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    reject(new Error('obsolete collector failed'));
    await Promise.resolve();
    expect(service.getSnapshot()).toEqual({ running: false, results: latest, failed: false });
  });

  it('reports a current collector failure without exposing its error or environment', async () => {
    const service = new OpencodeDiagnosticsService();
    expect(
      await service.run(source, async () => {
        throw new Error('secret credentials');
      }),
    ).toBe(true);
    expect(service.getSnapshot()).toEqual({ running: false, results: [], failed: true });
  });

  it('fences a source mutation even when an uncooperative collector does not check between stages', async () => {
    const service = new OpencodeDiagnosticsService();
    const result = deferred<DiagnosticResult[]>();
    const env = { OPENCODE_DB: '/old.db' };
    const pending = service.run({ ...source, env }, () => result.promise);
    env.OPENCODE_DB = '/new.db';
    result.resolve(results);
    expect(await pending).toBe(false);
    expect(service.getSnapshot()).toEqual({ running: false, results: [], failed: false });
  });

  it('does not invalidate a run when environment keys are reordered', async () => {
    const service = new OpencodeDiagnosticsService();
    const result = deferred<DiagnosticResult[]>();
    const pending = service.run({ ...source, env: { A: '1', B: '2' } }, () => result.promise);
    service.setSource({ ...source, env: { B: '2', A: '1' } });
    result.resolve(results);
    expect(await pending).toBe(true);
    expect(service.getSnapshot().results).toEqual(results);
  });
});
