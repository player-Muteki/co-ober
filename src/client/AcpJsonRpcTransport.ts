import { createInterface, type Interface } from 'readline';
import { AcpTransportError, AcpTimeoutError, AcpProtocolError, AcpAbortError } from './AcpErrors';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number | null;
  abortHandler: (() => void) | null;
}

type NotificationHandler = (params: unknown) => void | Promise<void>;
type RequestHandler = (params: unknown) => Promise<unknown>;

export interface JsonRpcMessageStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export class AcpJsonRpcTransport {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readline: Interface | null = null;
  private nextId = 1;
  private disposed = false;
  /** Unrouted methods already warned about on *this* connection only. */
  private readonly warnedUnknownNotifications = new Set<string>();
  /**
   * A notification nobody registered for is a frame that never reaches the
   * transcript at all — the client may report each one as drift.
   */
  onUnknownNotification?: (method: string) => void;

  constructor(
    private readonly streams: JsonRpcMessageStreams,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get isClosed(): boolean {
    return this.disposed;
  }

  start(): void {
    if (this.readline || this.disposed) return;
    this.readline = createInterface({
      input: this.streams.input,
      crlfDelay: Infinity,
    });
    this.readline.on('line', (line) => this.handleLine(line));
    // A stream error (EPIPE from the agent dying mid-read) would otherwise
    // leave pending requests hanging until their timeouts.
    (this.readline as unknown as NodeJS.EventEmitter).on('error', (err: unknown) => {
      this.dispose(err instanceof Error ? err : new AcpTransportError('JSON-RPC input errored'));
    });
    this.readline.on('close', () => {
      if (!this.disposed) this.dispose(new AcpTransportError('JSON-RPC input closed'));
    });
  }

  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new AcpTransportError('Transport closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timeout: number | null = null;
      let abortHandler: (() => void) | null = null;

      if (effectiveTimeout > 0) {
        timeout = window.setTimeout(() => {
          this.pending.delete(id);
          // Without the detach, every timed-out request leaves an abort
          // listener on a long-lived signal (and a dangling abortHandler
          // reference) for the life of the connection.
          if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
          reject(new AcpTimeoutError(method, effectiveTimeout));
        }, effectiveTimeout);
      }

      if (signal) {
        if (signal.aborted) {
          if (timeout) window.clearTimeout(timeout);
          reject(new AcpAbortError(method));
          return;
        }
        abortHandler = () => {
          if (timeout) window.clearTimeout(timeout);
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(new AcpAbortError(method));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timeout, abortHandler });
      this.send(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      this.requestHandlers.delete(method);
    };
  }

  rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timeout) window.clearTimeout(entry.timeout);
      if (entry.abortHandler) entry.abortHandler();
      entry.reject(error);
    }
    this.pending.clear();
  }

  dispose(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readline?.close();
    this.readline = null;
    this.rejectPending(error ?? new AcpTransportError('Transport closed'));
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.streams.output.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      console.error('[co-ober] send error:', e);
      this.dispose(e instanceof Error ? e : new AcpTransportError('JSON-RPC output write failed'));
    }
  }

  private malformedLines = 0;

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A corrupted frame would silently hang the matching request until the
      // timeout; surface the first few anomalies so the cause is visible.
      this.malformedLines++;
      if (this.malformedLines <= 5) {
        console.warn('[co-ober] non-JSON stdout line dropped:', line.slice(0, 200));
      }
      return;
    }

    // JSON-RPC batch frames: iterating the array is the only way the second
    // and later messages get answered instead of silently dropped.
    if (Array.isArray(parsed)) {
      for (const item of parsed) this.dispatchMessage(item);
      return;
    }
    this.dispatchMessage(parsed);
  }

  private dispatchMessage(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;

    // JSON-RPC ids are number OR string: a string-id server request that
    // falls through to the notification branch is never answered, and the
    // agent blocks waiting for its reply.
    const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : undefined;
    // `result: null` and `error: null` are valid responses; an undefined
    // check would drop them and hang the matching request until the timeout.
    const hasResult = 'result' in msg;
    const hasError = 'error' in msg;
    const hasMethod = typeof msg.method === 'string';

    if (id !== undefined && hasResult) {
      const entry = this.pending.get(typeof id === 'number' ? id : Number(id));
      this.pending.delete(typeof id === 'number' ? id : Number(id));
      if (entry) {
        if (entry.timeout) window.clearTimeout(entry.timeout);
        if (entry.abortHandler) entry.abortHandler();
        entry.resolve(msg.result);
      }
    } else if (id !== undefined && hasError) {
      const entry = this.pending.get(typeof id === 'number' ? id : Number(id));
      this.pending.delete(typeof id === 'number' ? id : Number(id));
      if (entry) {
        if (entry.timeout) window.clearTimeout(entry.timeout);
        if (entry.abortHandler) entry.abortHandler();
        const errObj = msg.error as { code?: number; message?: string; data?: unknown };
        // Some agents carry the only human-readable text in error.data;
        // without it the message stays "Unknown error" for both the console
        // and any consumer that reads Error.message.
        const dataText = typeof errObj?.data === 'string' ? errObj.data : undefined;
        entry.reject(
          new AcpProtocolError(errObj?.message ?? dataText ?? 'Unknown error', entry.method, errObj?.code, errObj?.data),
        );
      }
    } else if (hasMethod && id === undefined) {
      const method = msg.method as string;
      const handlers = this.notificationHandlers.get(method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler((msg as { params?: unknown }).params)).catch((error: unknown) =>
              console.error('[co-ober] notification handler failed:', error),
            );
          } catch (error) {
            console.error('[co-ober] notification handler failed:', error);
          }
        }
      } else if (!method.startsWith('$/')) {
        // $/-prefixed messages are ignorable by JSON-RPC/LSP convention;
        // anything else we silently drop is protocol drift and should be visible.
        if (!this.warnedUnknownNotifications.has(method)) {
          this.warnedUnknownNotifications.add(method);
          console.warn(`[co-ober] dropping unknown notification: ${method}`);
        }
        this.onUnknownNotification?.(method);
      }
    } else if (hasMethod && id !== undefined) {
      const handler = this.requestHandlers.get(msg.method as string);
      if (handler) {
        // A handler that throws before it ever returns a promise would leave
        // this id unanswered, and an unanswered request is the agent waiting
        // forever. Anything that cannot be started is still a failed request.
        let started: Promise<unknown>;
        try {
          started = Promise.resolve(handler((msg as { params?: unknown }).params));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
          return;
        }
        started
          .then((result) => this.send({ jsonrpc: '2.0', id, result }))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
          });
      } else {
        // A server→client request we cannot answer still needs a response,
        // otherwise the agent blocks forever waiting for it.
        this.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${msg.method as string}` },
        });
      }
    }
  }
}
