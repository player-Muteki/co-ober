import { randomBytes } from 'node:crypto';

/**
 * Authentication for the brief `opencode serve` this plugin spawns to read the native
 * catalog and run its opt-in probes.
 *
 * The contract below is read from the running install and from OpenCode's own source at
 * v2.0.32, not inferred. `packages/server/src/auth.ts` builds the server config with the
 * username `"opencode"` and a password that is `Option.none()` only when nothing supplied
 * one; `packages/cli/src/server-process.ts:86-92` then *requires* a password in every
 * non-service mode (`if (!password) … "Missing server password"`), and
 * `packages/cli/src/env.ts:10-11` reads `OPENCODE_PASSWORD` with `OPENCODE_SERVER_PASSWORD`
 * as the documented fallback.
 *
 * The 1.x line is the reason the fallback name is the one we set. Its
 * `packages/cli/src/commands/handlers/serve.ts` takes the daemon password only from
 * `OPENCODE_SERVER_PASSWORD`, and 1.19.0 prints `Warning: OPENCODE_SERVER_PASSWORD is not
 * set; server is unsecured.` when it is absent. Both names are written so one spawn
 * authenticates on either line, and so an inherited `OPENCODE_PASSWORD` from the
 * surrounding desktop environment cannot win the fallback race and lock out the read that
 * this plugin is about to perform.
 *
 * The password is chosen here, never scraped from the server's stdout: `server-process.ts:203`
 * prints `server password <value>` only when the caller did NOT supply one, so supplying it
 * keeps the credential off the wire, out of logs and out of the panel. It is never persisted,
 * displayed, or compared against anything the reader can see.
 */

export const OPENCODE_SERVER_PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';
export const OPENCODE_PASSWORD_ENV = 'OPENCODE_PASSWORD';
export const OPENCODE_SERVER_USERNAME = 'opencode';

/** A 32-byte base64url secret, the same width OpenCode generates for itself. */
export function newOpencodeServePassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The environment for a `serve` child that only this plugin's own requests may read.
 * Both password names carry the same value so the server adopts ours whichever line it is,
 * and any value inherited from the host is overwritten rather than inherited.
 */
export function opencodeServeEnvironment(env: NodeJS.ProcessEnv, password: string): NodeJS.ProcessEnv {
  return { ...env, [OPENCODE_PASSWORD_ENV]: password, [OPENCODE_SERVER_PASSWORD_ENV]: password };
}

/** HTTP Basic credentials in the shape `packages/server/src/auth.ts` compares against. */
export function opencodeServeAuthHeaders(password: string): Record<string, string> {
  const credentials = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64');
  return { authorization: `Basic ${credentials}` };
}

/**
 * A refused request, carrying the status so a caller can tell a refusal it can name from
 * a route that simply never answered. An `Error` with a formatted status string forced
 * every refusal into one undifferentiated failure.
 */
export class OpencodeServeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OpencodeServeHttpError';
  }
}

/** True for the statuses that mean "the server read the request and refused it". */
export function isOpencodeServeAuthenticationFailure(error: unknown): boolean {
  return error instanceof OpencodeServeHttpError && (error.status === 401 || error.status === 403);
}

/**
 * True for a refusal about the *shape* of the request rather than the reader's right to
 * make it. On 2.0.32 the 1.x nested prompt body is refused with
 * `400 {"_tag":"InvalidRequestError","message":"Missing key at [\"text\"]"}`, the 1.x
 * delete answers 405, and the 1.x fork route answers 405/404 — a live, healthy kernel
 * saying "that is not a route I have" rather than "I did not answer".
 */
export function isOpencodeServeProtocolRefusal(error: unknown): boolean {
  return error instanceof OpencodeServeHttpError && (error.status === 400 || error.status === 404 || error.status === 405 || error.status === 422);
}
