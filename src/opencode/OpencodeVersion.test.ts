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
