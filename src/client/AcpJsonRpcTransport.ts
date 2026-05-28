import { createInterface, type Interface } from 'readline';
import { AcpTransportError, AcpTimeoutError, AcpProtocolError, AcpAbortError } from './AcpErrors';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
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
      let timeout: NodeJS.Timeout | null = null;
      let abortHandler: (() => void) | null = null;

      if (effectiveTimeout > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTimeoutError(method, effectiveTimeout));
        }, effectiveTimeout);
      }

      if (signal) {
        if (signal.aborted) {
          if (timeout) clearTimeout(timeout);
          reject(new AcpAbortError(method));
          return;
        }
        abortHandler = () => {
          if (timeout) clearTimeout(timeout);
          this.pending.delete(id);
          // Don't send cancel request when aborting - the abort itself handles cancellation
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
      if (entry.timeout) clearTimeout(entry.timeout);
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
      console.error('[copsidian] send error:', e);
      this.dispose(e instanceof Error ? e : new AcpTransportError('JSON-RPC output write failed'));
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const id = typeof parsed.id === 'number' ? parsed.id : undefined;
    const hasResult = parsed.result !== undefined;
    const hasError = parsed.error !== undefined;
    const hasMethod = typeof parsed.method === 'string';

    if (id !== undefined && hasResult) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (entry) {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.abortHandler) entry.abortHandler();
        entry.resolve(parsed.result);
      }
    } else if (id !== undefined && hasError) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (entry) {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry.abortHandler) entry.abortHandler();
        const errObj = parsed.error as { code?: number; message?: string; data?: unknown };
        entry.reject(
          new AcpProtocolError(errObj?.message ?? 'Unknown error', entry.method, errObj?.code, errObj?.data),
        );
      }
    } else if (hasMethod && id === undefined) {
      const handlers = this.notificationHandlers.get(parsed.method as string);
      if (handlers) {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler((parsed as { params?: unknown }).params)).catch((error: unknown) =>
              console.error('[copsidian] notification handler failed:', error),
            );
          } catch (error) {
            console.error('[copsidian] notification handler failed:', error);
          }
        }
      }
    } else if (hasMethod && id !== undefined) {
      const handler = this.requestHandlers.get(parsed.method as string);
      if (handler) {
        handler((parsed as { params?: unknown }).params)
          .then((result) => this.send({ jsonrpc: '2.0', id, result }))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
          });
      }
    }
  }
}
