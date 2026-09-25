export class AcpTransportError extends Error {
  constructor(message: string, public override readonly cause?: Error) {
    super(message);
    this.name = 'AcpTransportError';
  }
}

export class AcpProtocolError extends Error {
  constructor(
    message: string,
    public readonly method: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpProtocolError';
  }
}

export class AcpTimeoutError extends AcpTransportError {
  constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(`ACP request '${method}' timed out after ${timeoutMs}ms`);
    this.name = 'AcpTimeoutError';
  }
}

export class AcpProcessExitError extends AcpTransportError {
  constructor(public readonly exitCode: number | null, public readonly signal: string | null) {
    super(`ACP process exited (code=${exitCode}, signal=${signal})`);
    this.name = 'AcpProcessExitError';
  }
}

export class AcpAbortError extends AcpTransportError {
  constructor(public readonly method: string) {
    super(`ACP request '${method}' was aborted`);
    this.name = 'AcpAbortError';
  }
}

/** Raised when the agent reports that a session id no longer exists (e.g. after an agent restart). */
export class AcpSessionMissingError extends Error {
  constructor(
    public readonly sessionId: string,
    public override readonly cause?: unknown,
  ) {
    super(`ACP session '${sessionId}' no longer exists on the agent side`);
    this.name = 'AcpSessionMissingError';
  }
}

const SESSION_MISSING_PATTERN =
  /session[^.\n]{0,40}\b(not found|does not exist|doesn't exist|unknown|missing|expired|invalid)\b|\b(unknown|invalid|missing|expired) session\w*/i;

/** Classify an ACP error as "the session is gone" (vs. transport or protocol failure). */
export function isSessionMissingError(err: unknown): boolean {
  if (err instanceof AcpSessionMissingError) return true;
  if (!(err instanceof Error)) return false;
  if (err instanceof AcpTransportError) return false;
  if (SESSION_MISSING_PATTERN.test(err.message)) return true;
  if (err instanceof AcpProtocolError && err.data !== undefined) {
    try {
      return SESSION_MISSING_PATTERN.test(JSON.stringify(err.data));
    } catch {
      return false;
    }
  }
  return false;
}

const AUTH_REQUIRED_PATTERN =
  /\bauth(?:entication)?[\s_]+(?:required|needed)\b|\bnot authenticated\b|please (?:log ?in|sign ?in|authenticate)/i;

/** Classify a protocol error as "the agent wants authenticate() first" (ACP auth_required). */
export function isAuthRequiredError(err: unknown): boolean {
  if (!(err instanceof AcpProtocolError)) return false;
  if (err.code === -32001) return true;
  if (AUTH_REQUIRED_PATTERN.test(err.message)) return true;
  if (err.data !== undefined) {
    try {
      return AUTH_REQUIRED_PATTERN.test(JSON.stringify(err.data));
    } catch {
      return false;
    }
  }
  return false;
}

/** Classify a connect failure as "the binary could not be spawned" (ENOENT). */
export function isMissingBinaryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
  return /\bENOENT\b/.test(err.message);
}
