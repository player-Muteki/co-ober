import { describe, expect, it, vi } from 'vitest';
import { deleteOpencodeServeSession } from './OpencodeServeSession';
import { OpencodeServeHttpError } from './OpencodeServeAuth';

type Request = Parameters<typeof deleteOpencodeServeSession>[0];

const ok = vi.fn<Request>(async () => ({}));
const routeAbsent = vi.fn<Request>(async (url: string) => {
  if (url.includes('/api/session/')) throw new OpencodeServeHttpError(405, 'responded 405');
  return {};
});
const serverError = vi.fn<Request>(async () => { throw new OpencodeServeHttpError(500, 'responded 500'); });
const socketDead = vi.fn<Request>(async () => { throw new Error('socket hang up'); });

describe('deleteOpencodeServeSession', () => {
  it('uses the route this generation has first, and stops when one succeeds', async () => {
    expect(await deleteOpencodeServeSession(ok, 'http://127.0.0.1:1', '/vault', 'ses_1')).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    // Measured: 2.x moved the delete to /api/session/{id}; 1.x used /session/{id}.
    expect(ok.mock.calls[0][0]).toBe('http://127.0.0.1:1/api/session/ses_1?directory=%2Fvault');
    expect(ok.mock.calls[0][1]).toEqual({ method: 'DELETE' });
  });

  it('falls back to the 1.x route when this server has no 2.x one', async () => {
    // A 405 is a route that does not exist, not a failure — so it moves on rather than
    // ending the search and reporting a leftover the reader would chase wrongly.
    expect(await deleteOpencodeServeSession(routeAbsent, 'http://127.0.0.1:1', '/vault', 'ses_1')).toBe(true);
    expect(routeAbsent).toHaveBeenCalledTimes(2);
    expect(routeAbsent.mock.calls[1][0]).toBe('http://127.0.0.1:1/session/ses_1?directory=%2Fvault');
  });

  it('reports a leftover when the server refuses rather than answering 404/405', async () => {
    // "The server refused to delete this" and "this server has no such route" send the
    // reader to different places, so a 500 must not be walked past as a missing route.
    expect(await deleteOpencodeServeSession(serverError, 'http://127.0.0.1:1', '/vault', 'ses_1')).toBe(false);
    expect(serverError).toHaveBeenCalledTimes(1);
  });

  it('reports a leftover, without re-asking, when the connection itself is gone', async () => {
    // A dead socket is not a missing route, so the search stops: trying the second route
    // against a server that is not answering would only cost time and teach nothing.
    expect(await deleteOpencodeServeSession(socketDead, 'http://127.0.0.1:1', '/vault', 'ses_1')).toBe(false);
    expect(socketDead).toHaveBeenCalledTimes(1);
  });

  it('encodes a directory containing spaces and separators', async () => {
    await deleteOpencodeServeSession(ok, 'http://127.0.0.1:1', '/a vault/dir', 'ses_1');
    expect(ok.mock.calls.at(-1)?.[0]).toBe('http://127.0.0.1:1/api/session/ses_1?directory=%2Fa%20vault%2Fdir');
  });
});
