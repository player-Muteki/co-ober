import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseOpencodeVersion,
  opencodeNativeGeneration,
  detectOpencodeVersion,
} from './OpencodeVersion';

function fakeChild(stdoutData: string, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stdout.end(stdoutData);
    child.stderr.end('');
    setImmediate(() => child.emit('close', exitCode));
  });
  return child;
}

describe('parseOpencodeVersion', () => {
  it('reads the dotted number out of a banner rather than trusting the line', () => {
    expect(parseOpencodeVersion('opencode v1.5.3')).toBe('1.5.3');
    expect(parseOpencodeVersion('1.5.3-internal')).toBe('1.5.3');
    expect(parseOpencodeVersion('2.0')).toBe('2.0');
    expect(parseOpencodeVersion('OpenCode: no number')).toBeUndefined();
  });
});

describe('opencodeNativeGeneration', () => {
  it('names only majors 1 and 2 and rounds nothing else up', () => {
    expect(opencodeNativeGeneration('1.5.3')).toBe(1);
    expect(opencodeNativeGeneration('2.0.0')).toBe(2);
    expect(opencodeNativeGeneration('0.4.1')).toBeUndefined();
    expect(opencodeNativeGeneration('3.1.0')).toBeUndefined();
    expect(opencodeNativeGeneration(undefined)).toBeUndefined();
  });
});

describe('detectOpencodeVersion', () => {
  it('does not launch a version process for a cancelled operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();
    const reading = await detectOpencodeVersion('opencode', { signal: controller.signal, spawn, env: {}, platform: 'linux' });
    expect(reading.failed).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });


  it('cancels a hanging process promptly and cleans its output listeners', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const controller = new AbortController();
    const pending = detectOpencodeVersion('opencode', {
      signal: controller.signal, spawn: vi.fn(() => child) as never, env: {}, platform: 'linux', timeoutMs: 100,
    });
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([pending, new Promise<string>((resolve) => { timer = setTimeout(() => resolve('pending'), 30); })]);
    clearTimeout(timer);
    expect(result).toMatchObject({ failed: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(() => child.emit('error', new Error('late spawn error'))).not.toThrow();
    child.emit('close', null);
    expect(child.listenerCount('error')).toBe(0);
  });


  it('captures the launch environment rather than retaining the mutable caller object', async () => {
    const child = fakeChild('1.18.33');
    const spawn = vi.fn<NonNullable<import('./OpencodeVersion').OpencodeVersionDeps['spawn']>>(() => child as never);
    const env = { OPENCODE_DB: '/old.db' };
    const pending = detectOpencodeVersion('opencode', { spawn: spawn as never, env, platform: 'linux' });
    env.OPENCODE_DB = '/new.db';
    expect(spawn.mock.calls[0]?.[2].env?.OPENCODE_DB).toBe('/old.db');
    expect((await pending).version).toBe('1.18.33');
  });

  it('settles a deadline even if kill throws and the child never closes', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => { throw new Error('signal failed'); });
    const reading = await detectOpencodeVersion('opencode', { spawn: vi.fn(() => child) as never, env: {}, platform: 'linux', timeoutMs: 5 });
    expect(reading.failed).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.listenerCount('data')).toBe(0);
    child.emit('close', null);
  });

  it('fails promptly on excess output instead of waiting for close', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const pending = detectOpencodeVersion('opencode', { spawn: vi.fn(() => child) as never, env: {}, platform: 'linux' });
    child.stdout.write('1.18.33' + 'x'.repeat(4000));
    expect((await pending).failed).toBe(true);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    child.emit('close', 0);
  });
  it('records the version the CLI actually reported', async () => {
    const reading = await detectOpencodeVersion('opencode', {
      spawn: vi.fn(() => fakeChild('opencode v1.5.3\n')) as never,
      platform: 'linux',
      env: {},
    });
    expect(reading.failed).toBe(false);
    expect(reading.version).toBe('1.5.3');
    expect(reading.generation).toBe(1);
    expect(reading.raw).toBe('opencode v1.5.3');
  });

  it('classifies a v2 install', async () => {
    const reading = await detectOpencodeVersion('opencode', {
      spawn: vi.fn(() => fakeChild('2.4.1')) as never,
      platform: 'linux',
      env: {},
    });
    expect(reading.generation).toBe(2);
  });

  it('will not invent a generation for a major it has no wire for', async () => {
    const reading = await detectOpencodeVersion('opencode', {
      spawn: vi.fn(() => fakeChild('0.9.9')) as never,
      platform: 'linux',
      env: {},
    });
    expect(reading.version).toBe('0.9.9');
    expect(reading.generation).toBeUndefined();
    expect(reading.failed).toBe(false);
  });

  it('reports a non-zero exit as unreadable, not a version of zero', async () => {
    const reading = await detectOpencodeVersion('opencode', {
      spawn: vi.fn(() => fakeChild('', 1)) as never,
      platform: 'linux',
      env: {},
    });
    expect(reading.failed).toBe(true);
    expect(reading.version).toBeUndefined();
    expect(reading.generation).toBeUndefined();
  });

  it('returns a failed reading without spawning when the path is blank', async () => {
    const spawn = vi.fn();
    const reading = await detectOpencodeVersion('   ', { spawn: spawn as never, platform: 'linux', env: {} });
    expect(reading.failed).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the raw text when the CLI ran but named no version', async () => {
    const reading = await detectOpencodeVersion('opencode', {
      spawn: vi.fn(() => fakeChild('no number here')) as never,
      platform: 'linux',
      env: {},
    });
    expect(reading.failed).toBe(false);
    expect(reading.version).toBeUndefined();
    expect(reading.raw).toBe('no number here');
  });
});
