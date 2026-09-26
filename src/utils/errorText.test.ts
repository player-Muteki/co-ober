import { afterEach, describe, expect, it } from 'vitest';
import { humanizeError } from './errorText';
import {
  AcpAbortError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSessionMissingError,
  AcpStreamCapacityError,
  AcpTimeoutError,
} from '../client/AcpErrors';
import { setLocale, t } from '../i18n/index';

afterEach(() => {
  setLocale('en');
});

describe('humanizeError (0.2.5 stage 3)', () => {
  it('names the method and the window when a request times out', () => {
    const line = humanizeError(new AcpTimeoutError('session/prompt', 300000));
    expect(line).toBe(t().error.timedOut.replace('{method}', 'session/prompt').replace('{ms}', '300000'));
    expect(line).toContain('session/prompt');
    expect(line).not.toContain('timed out after');
  });

  it('says a vanished conversation stopped existing rather than quoting the agent id', () => {
    const line = humanizeError(new AcpSessionMissingError('ses_abc123'));
    expect(line).toBe(t().error.sessionMissing);
    expect(line).not.toContain('ses_abc123');
  });

  it('reports a dead process with the exit status it actually carried', () => {
    expect(humanizeError(new AcpProcessExitError(1, null))).toContain('code 1');
    expect(humanizeError(new AcpProcessExitError(null, 'SIGKILL'))).toContain('signal SIGKILL');
    expect(humanizeError(new AcpProcessExitError(null, null))).toContain('no exit status');
  });

  it('keeps a sentence that was already written for a reader', () => {
    const capacity = new AcpStreamCapacityError(3);
    expect(humanizeError(capacity)).toBe(capacity.message);
    const abort = new AcpAbortError('session/prompt');
    expect(humanizeError(abort)).toBe(abort.message);
  });

  it('translates a protocol error by its code, and drops the agent echo of the code', () => {
    const notFound = new AcpProtocolError('method not found: session/resume', 'session/resume', -32601);
    const line = humanizeError(notFound);
    expect(line).toBe(t().error.methodNotFound.replace('{detail}', 'session/resume'));
    expect(line).not.toContain('method not found:');
  });

  it('reads a code that arrived inside the message text', () => {
    const plain = new Error('-32603: registry unreachable');
    const line = humanizeError(plain);
    expect(line).toBe(t().error.internalError.replace('{detail}', 'registry unreachable'));
    expect(line).not.toContain('-32603');
  });

  it('labels an unmapped protocol code as the agent refusing, keeping the detail', () => {
    const line = humanizeError(new AcpProtocolError('auth required', 'initialize', -32001));
    expect(line).toBe(t().error.agentError.replace('{detail}', 'auth required'));
  });

  it('turns an errno into a file sentence without losing the path', () => {
    const missing = humanizeError(new Error("ENOENT: no such file or directory, open '/vault/a.md'"));
    expect(missing).toContain('/vault/a.md');
    expect(missing).toBe(t().error.fileMissing.replace('{detail}', "ENOENT: no such file or directory, open '/vault/a.md'"));

    const denied = humanizeError(new Error('EACCES: permission denied, write'));
    expect(denied).toBe(t().error.accessDenied.replace('{detail}', 'EACCES: permission denied, write'));
  });

  it('keeps an unrecognized failure verbatim behind a label', () => {
    const line = humanizeError(new Error('weird thing at frame 7'));
    expect(line).toBe(`${t().error.unknown}: weird thing at frame 7`);
  });

  it('accepts a thrown non-Error without throwing itself', () => {
    expect(humanizeError('just a string')).toBe(`${t().error.unknown}: just a string`);
    expect(humanizeError(undefined)).toBe(`${t().error.unknown}: undefined`);
  });

  it('does not splice an agent message that contains a replacement pattern', () => {
    const detail = 'internal: use $& and {detail}';
    const line = humanizeError(new AcpProtocolError(detail, 'x', -32603));
    expect(line).toBe(t().error.internalError.replace('{detail}', () => detail));
  });

  it('answers in the language the reader is using', () => {
    const english = humanizeError(new AcpSessionMissingError('ses_abc'));
    setLocale('zh');
    const chinese = humanizeError(new AcpSessionMissingError('ses_abc'));
    expect(chinese).toBe(t().error.sessionMissing);
    expect(chinese).not.toBe(english);
  });
});
