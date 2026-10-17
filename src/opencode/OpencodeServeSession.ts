import { OpencodeServeHttpError } from './OpencodeServeAuth';

/**
 * Removing the throwaway session a probe created.
 *
 * Measured across two kernel generations: 1.x deletes through
 * `DELETE /session/{id}?directory=…`, while 2.x moved it to
 * `DELETE /api/session/{id}?directory=…` and answers **405** to the old form. A probe that
 * only knew one of them either leaked a session on the other generation or reported a
 * leftover it had actually cleaned up. Both routes are tried, newest first, and the caller
 * is told which happened rather than being handed a swallowed error.
 *
 * A `405` is a route that does not exist, not a failure — so it moves on to the next
 * candidate instead of ending the search. Anything else is treated as a real failure and
 * reported, because "the server refused to delete this" and "this server has no such
 * route" send the reader to different places.
 */
export type OpencodeServeRequest = (
  url: string,
  init?: { method?: string; body?: unknown },
  signal?: AbortSignal,
) => Promise<unknown>;

export async function deleteOpencodeServeSession(
  request: OpencodeServeRequest,
  origin: string,
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const encoded = encodeURIComponent(sessionId);
  const query = `directory=${encodeURIComponent(cwd)}`;
  for (const route of [`/api/session/${encoded}?${query}`, `/session/${encoded}?${query}`]) {
    try {
      await request(`${origin}${route}`, { method: 'DELETE' }, signal);
      return true;
    } catch (error) {
      if (error instanceof OpencodeServeHttpError && (error.status === 404 || error.status === 405)) continue;
      if (isRouteAbsent(error)) continue;
      return false;
    }
  }
  return false;
}

function isRouteAbsent(error: unknown): boolean {
  return error instanceof OpencodeServeHttpError ? false : error instanceof Error && /responded 40[45]/u.test(error.message);
}
