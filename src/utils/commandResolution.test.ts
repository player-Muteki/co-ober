import { describe, expect, it } from 'vitest';
import { getSpawnInfo, resolveCommandPath } from './commandResolution';

const env = (path: string) => ({ PATH: path, HOME: '/home/tester' });
const exists = (set: string[]) => (p: string) => set.includes(p);

describe('resolveCommandPath', () => {
  it('finds a bare command on the POSIX PATH', () => {
    expect(resolveCommandPath('opencode', 'linux', env('/usr/bin:/bin'), exists(['/bin/opencode']))).toBe('/bin/opencode');
  });

  it('falls back to installer dirs the desktop PATH misses, PATH first', () => {
    expect(resolveCommandPath('opencode', 'linux', env('/usr/bin'), exists(['/home/tester/.opencode/bin/opencode']))).toBe(
      '/home/tester/.opencode/bin/opencode',
    );
    expect(resolveCommandPath('opencode', 'linux', env('/usr/bin'), exists(['/home/tester/.local/bin/opencode']))).toBe(
      '/home/tester/.local/bin/opencode',
    );
    expect(
      resolveCommandPath('opencode', 'linux', env('/usr/bin:/opt/x'), exists(['/opt/x/opencode', '/usr/bin/opencode'])),
    ).toBe('/usr/bin/opencode');
  });

  it('returns null for a missing binary and honours explicit paths', () => {
    expect(resolveCommandPath('nope', 'linux', env('/usr/bin'), exists([]))).toBeNull();
    expect(resolveCommandPath('/opt/x/opencode', 'linux', env(''), exists(['/opt/x/opencode']))).toBe('/opt/x/opencode');
    expect(resolveCommandPath('/opt/x/opencode', 'linux', env(''), exists([]))).toBeNull();
  });

  it('strips surrounding quotes and whitespace before resolving', () => {
    expect(resolveCommandPath('"/opt/x/opencode" ', 'linux', env(''), exists(['/opt/x/opencode']))).toBe('/opt/x/opencode');
  });

  it('rejects empty commands', () => {
    expect(resolveCommandPath('  ', 'linux', env('/usr/bin'), exists(['/usr/bin/x']))).toBeNull();
  });

  it('checks Windows extensions against PATH and explicit paths', () => {
    expect(resolveCommandPath('opencode', 'win32', { PATH: 'C:\\dir', HOME: 'C:\\h' }, exists(['C:\\dir\\opencode.cmd']))).toBe(
      'C:\\dir\\opencode.cmd',
    );
    expect(resolveCommandPath('C:\\tools\\opencode', 'win32', env(''), exists(['C:\\tools\\opencode.exe']))).toBe(
      'C:\\tools\\opencode.exe',
    );
    expect(resolveCommandPath('opencode.bat', 'win32', { PATH: 'C:\\dir', HOME: 'C:\\h' }, exists(['C:\\dir\\opencode.bat']))).toBe(
      'C:\\dir\\opencode.bat',
    );
  });
});

describe('getSpawnInfo with POSIX resolution', () => {
  it('upgrades a bare resolvable command and keeps args untouched', () => {
    const info = getSpawnInfo(process.execPath, ['acp'], 'linux', process.env);
    expect(info).toEqual({ command: process.execPath, args: ['acp'] });
  });

  it('passes an unresolvable command through so spawn surfaces the real error', () => {
    const info = getSpawnInfo('co-ober-definitely-not-here-xyz', ['acp'], 'linux', { PATH: '', HOME: '/nonexistent-home' });
    expect(info.command).toBe('co-ober-definitely-not-here-xyz');
  });
});
