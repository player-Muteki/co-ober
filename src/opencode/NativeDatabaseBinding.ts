import * as path from 'path';

/** Only durable, absolute file paths can identify a native conversation's source. */
export function isNativeDatabasePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    (path.posix.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value))
  );
}

/** Windows spelling is case/separator insensitive; POSIX spelling is not. No disk writes. */
export function sameNativeDatabase(a: string, b: string): boolean {
  const identity = (value: string): string =>
    /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
  return identity(a) === identity(b);
}

export class NativeDatabaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeDatabaseMismatchError';
  }
}
