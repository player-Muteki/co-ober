import { describe, expect, it } from 'vitest';
import {
  OPENCODE_PASSWORD_ENV,
  OPENCODE_SERVER_PASSWORD_ENV,
  OPENCODE_SERVER_USERNAME,
  isOpencodeServeAuthenticationFailure,
  newOpencodeServePassword,
  opencodeServeAuthHeaders,
  opencodeServeEnvironment,
  OpencodeServeHttpError,
} from './OpencodeServeAuth';

describe('newOpencodeServePassword', () => {
  it('mints a distinct 32-byte secret each time', () => {
    const first = newOpencodeServePassword();
    const second = newOpencodeServePassword();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
  });
});

describe('opencodeServeEnvironment', () => {
  it('carries the chosen password under both names OpenCode reads', () => {
    // v2 reads OPENCODE_PASSWORD and falls back to OPENCODE_SERVER_PASSWORD (env.ts:10-11);
    // the 1.x line reads only OPENCODE_SERVER_PASSWORD. One spawn has to satisfy both.
    const env = opencodeServeEnvironment({}, 'secret-value');
    expect(env[OPENCODE_PASSWORD_ENV]).toBe('secret-value');
    expect(env[OPENCODE_SERVER_PASSWORD_ENV]).toBe('secret-value');
  });

  it('overwrites an inherited password rather than letting the host win the lookup', () => {
    // A stale OPENCODE_PASSWORD in the surrounding desktop environment would otherwise be
    // preferred by a v2 server over the one this probe actually presents, and every read
    // would then be refused with a credential the reader never chose.
    const env = opencodeServeEnvironment({ [OPENCODE_PASSWORD_ENV]: 'inherited', KEEP: 'yes' }, 'ours');
    expect(env[OPENCODE_PASSWORD_ENV]).toBe('ours');
    expect(env.KEEP).toBe('yes');
  });
});

describe('opencodeServeAuthHeaders', () => {
  it('presents HTTP Basic credentials as "opencode:<password>"', () => {
    // packages/server/src/auth.ts compares against username "opencode" and the password.
    const header = opencodeServeAuthHeaders('hunter2').authorization;
    expect(header).toBe(`Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:hunter2`).toString('base64')}`);
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8')).toBe('opencode:hunter2');
  });
});

describe('isOpencodeServeAuthenticationFailure', () => {
  it('names the refusals a server states, and only those', () => {
    expect(isOpencodeServeAuthenticationFailure(new OpencodeServeHttpError(401, 'x'))).toBe(true);
    expect(isOpencodeServeAuthenticationFailure(new OpencodeServeHttpError(403, 'x'))).toBe(true);
    // A refused read and a route that never answered send the reader to different places.
    expect(isOpencodeServeAuthenticationFailure(new OpencodeServeHttpError(404, 'x'))).toBe(false);
    expect(isOpencodeServeAuthenticationFailure(new OpencodeServeHttpError(500, 'x'))).toBe(false);
    expect(isOpencodeServeAuthenticationFailure(new Error('socket hang up'))).toBe(false);
  });
});
