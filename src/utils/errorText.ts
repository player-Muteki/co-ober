import { t } from '../i18n/index';
import {
  AcpAbortError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSessionMissingError,
  AcpStreamCapacityError,
  AcpTimeoutError,
} from '../client/AcpErrors';

// A JSON-RPC error that reached us as plain text: the agent (or an older
// transport) wrote the code into the message instead of carrying it as a field.
const CODE_PREFIX = /^\s*(-3[0-9]{4})\s*:\s*([\s\S]*)$/;
const ERRNO = /\b(ENOENT|EACCES|EPERM|ENOTDIR|EISDIR)\b/;

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
// Agents often restate "method not found" inside the message they attach to the
// -32601 code; the translated sentence already says that, so the echo goes.
const METHOD_NOT_FOUND_PREFIX = /^\s*method not found:\s*/i;

// A replacement function, not a string: an agent's own message can contain
// "$&", which a string replacement would splice the match back into.
const fill = (template: string, vars: Record<string, string>): string =>
  Object.entries(vars).reduce((text, [key, value]) => text.replace(`{${key}}`, () => value), template);

function describeExit(e: AcpProcessExitError): string {
  if (e.exitCode !== null) return `code ${e.exitCode}`;
  return e.signal ? `signal ${e.signal}` : 'no exit status';
}

function fromProtocolCode(code: number | undefined, detail: string): string {
  const cleaned = detail.trim();
  if (code === METHOD_NOT_FOUND) {
    const method = cleaned.replace(METHOD_NOT_FOUND_PREFIX, '').trim();
    return fill(t().error.methodNotFound, { detail: method || cleaned });
  }
  if (code === INTERNAL_ERROR) return fill(t().error.internalError, { detail: cleaned });
  return fill(t().error.agentError, { detail: cleaned });
}

function fromErrno(code: string, detail: string): string {
  if (code === 'ENOENT' || code === 'ENOTDIR') return fill(t().error.fileMissing, { detail });
  return fill(t().error.accessDenied, { detail });
}

/**
 * Turn whatever an agent, a child process or the vault threw into a line a user
 * can act on. Nothing is discarded: an error this code does not recognize is
 * kept verbatim behind a label, so a translation never costs the reader the
 * detail they would have needed to report the bug.
 */
export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  if (e instanceof AcpTimeoutError) {
    return fill(t().error.timedOut, { method: e.method, ms: String(e.timeoutMs) });
  }
  if (e instanceof AcpSessionMissingError) return t().error.sessionMissing;
  if (e instanceof AcpProcessExitError) return fill(t().error.processExited, { detail: describeExit(e) });
  // These two already carry a sentence written for a reader, not a machine.
  if (e instanceof AcpStreamCapacityError || e instanceof AcpAbortError) return raw;

  if (e instanceof AcpProtocolError) return fromProtocolCode(e.code, raw);

  const prefixed = CODE_PREFIX.exec(raw);
  if (prefixed) return fromProtocolCode(Number(prefixed[1]), prefixed[2].trim() || raw);

  const errno = ERRNO.exec(raw);
  if (errno) return fromErrno(errno[1], raw);

  return `${t().error.unknown}: ${raw}`;
}
