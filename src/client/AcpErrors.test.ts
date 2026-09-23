import { describe, it, expect } from 'vitest';
import {
  AcpTransportError,
  AcpProtocolError,
  AcpTimeoutError,
  AcpProcessExitError,
  AcpSessionMissingError,
  isSessionMissingError,
  isAuthRequiredError,
} from './AcpErrors';

describe('AcpErrors', () => {
  describe('AcpTransportError', () => {
    it('should have correct name and store the cause', () => {
      const cause = new Error('Network failure');
      const error = new AcpTransportError('Transport failed', cause);

      expect(error.name).toBe('AcpTransportError');
      expect(error.message).toBe('Transport failed');
      expect(error.cause).toBe(cause);
    });

    it('should have correct inheritance chain', () => {
      const error = new AcpTransportError('Transport failed');
      expect(error).toBeInstanceOf(AcpTransportError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('AcpProtocolError', () => {
    it('should store method, code, and data', () => {
      const error = new AcpProtocolError('Protocol failed', 'myMethod', 123, { detail: 'info' });

      expect(error.name).toBe('AcpProtocolError');
      expect(error.message).toBe('Protocol failed');
      expect(error.method).toBe('myMethod');
      expect(error.code).toBe(123);
      expect(error.data).toEqual({ detail: 'info' });
    });

    it('should have correct inheritance chain', () => {
      const error = new AcpProtocolError('Protocol failed', 'myMethod');
      expect(error).toBeInstanceOf(AcpProtocolError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('AcpTimeoutError', () => {
    it('should have correct message format', () => {
      const error = new AcpTimeoutError('slowMethod', 5000);

      expect(error.name).toBe('AcpTimeoutError');
      expect(error.message).toBe("ACP request 'slowMethod' timed out after 5000ms");
      expect(error.method).toBe('slowMethod');
      expect(error.timeoutMs).toBe(5000);
    });

    it('should have correct inheritance chain', () => {
      const error = new AcpTimeoutError('slowMethod', 5000);
      expect(error).toBeInstanceOf(AcpTimeoutError);
      expect(error).toBeInstanceOf(AcpTransportError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('AcpProcessExitError', () => {
    it('should store exitCode and signal with correct message', () => {
      const error = new AcpProcessExitError(1, 'SIGTERM');

      expect(error.name).toBe('AcpProcessExitError');
      expect(error.message).toBe('ACP process exited (code=1, signal=SIGTERM)');
      expect(error.exitCode).toBe(1);
      expect(error.signal).toBe('SIGTERM');
    });

    it('should have correct inheritance chain', () => {
      const error = new AcpProcessExitError(1, 'SIGTERM');
      expect(error).toBeInstanceOf(AcpProcessExitError);
      expect(error).toBeInstanceOf(AcpTransportError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('AcpSessionMissingError', () => {
    it('should store sessionId and cause', () => {
      const cause = new AcpProtocolError('Session not found', 'session/load', -32000);
      const error = new AcpSessionMissingError('ses_1', cause);

      expect(error.name).toBe('AcpSessionMissingError');
      expect(error.sessionId).toBe('ses_1');
      expect(error.cause).toBe(cause);
    });
  });
});

describe('isSessionMissingError', () => {
  it('matches protocol errors whose message says the session is gone', () => {
    expect(isSessionMissingError(new AcpProtocolError('Session not found', 'session/load', -32000))).toBe(true);
    expect(isSessionMissingError(new AcpProtocolError('unknown session ses_abc', 'session/resume', -32000))).toBe(true);
    expect(isSessionMissingError(new AcpProtocolError("the session doesn't exist anymore", 'loadSession'))).toBe(true);
    expect(isSessionMissingError(new AcpProtocolError('Invalid sessionId', 'session/load'))).toBe(true);
  });

  it('matches session-missing hints inside protocol error data', () => {
    const error = new AcpProtocolError('Internal error', 'session/load', -32603, {
      message: 'Session ses_123 not found',
    });
    expect(isSessionMissingError(error)).toBe(true);
  });

  it('unwraps AcpSessionMissingError', () => {
    expect(isSessionMissingError(new AcpSessionMissingError('ses_1'))).toBe(true);
  });

  it('does not match unrelated or transport errors', () => {
    expect(isSessionMissingError(new AcpProtocolError('Method not found', 'session/load', -32601))).toBe(false);
    expect(isSessionMissingError(new Error('boom'))).toBe(false);
    expect(isSessionMissingError(new AcpTimeoutError('session/load', 30000))).toBe(false);
    expect(isSessionMissingError(new AcpTransportError('Session transport closed'))).toBe(false);
    expect(isSessionMissingError(undefined)).toBe(false);
    expect(isSessionMissingError('Session not found')).toBe(false);
  });
});

describe('isAuthRequiredError', () => {
  it('matches the auth_required protocol code and phrasings', () => {
    expect(isAuthRequiredError(new AcpProtocolError('nope', 'session/new', -32001))).toBe(true);
    expect(isAuthRequiredError(new AcpProtocolError('auth_required', 'session/new', -32602))).toBe(true);
    expect(isAuthRequiredError(new AcpProtocolError('Authentication needed', 'session/new'))).toBe(true);
    expect(isAuthRequiredError(new AcpProtocolError('please log in first', 'session/new'))).toBe(true);
    expect(isAuthRequiredError(new AcpProtocolError('not authenticated', 'session/new'))).toBe(true);
  });

  it('matches auth hints inside protocol error data', () => {
    const error = new AcpProtocolError('Internal error', 'session/new', -32603, {
      code: 'auth_required',
    });
    expect(isAuthRequiredError(error)).toBe(true);
  });

  it('does not match unrelated or transport errors', () => {
    expect(isAuthRequiredError(new AcpProtocolError('Session not found', 'session/load', -32000))).toBe(false);
    expect(isAuthRequiredError(new Error('auth_required'))).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
  });
});
