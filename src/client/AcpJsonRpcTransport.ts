import { createInterface, type Interface } from 'readline';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
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

  get isClosed(): boolean { return this.disposed; }

  start(): void {
    if (this.readline || this.disposed) return;
    this.readline = createInterface({
      input: this.streams.input,
      crlfDelay: Infinity,
    });
    this.readline.on('line', (line) => this.handleLine(line));
    this.readline.on('close', () => {
      if (!this.disposed) this.dispose(new Error('JSON-RPC input closed'));
    });
  }

  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Transport closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      if (effectiveTimeout > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Request ${method} timed out after ${effectiveTimeout}ms`));
        }, effectiveTimeout);
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.send(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) { handlers = new Set(); this.notificationHandlers.set(method, handlers); }
    handlers.add(handler);
    return () => { handlers.delete(handler); };
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => { this.requestHandlers.delete(method); };
  }

  rejectPending(error: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(error);
    }
    this.pending.clear();
  }

  dispose(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readline?.close();
    this.readline = null;
    this.rejectPending(error ?? new Error('Transport closed'));
  }

  private send(msg: Record<string, unknown>): void {
    try {
      this.streams.output.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      console.error('[copsidian] send error:', e);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line); } catch { return; }

    const id = typeof parsed.id === 'number' ? parsed.id : undefined;
    const hasResult = parsed.result !== undefined;
    const hasError = parsed.error !== undefined;
    const hasMethod = typeof parsed.method === 'string';

    if (id !== undefined && hasResult) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (entry) {
        if (entry.timeout) clearTimeout(entry.timeout);
        entry.resolve(parsed.result);
      }
    } else if (id !== undefined && hasError) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      if (entry) {
        if (entry.timeout) clearTimeout(entry.timeout);
        entry.reject(new Error((parsed.error as { message: string })?.message ?? 'Unknown error'));
      }
    } else if (hasMethod && id === undefined) {
      const handlers = this.notificationHandlers.get(parsed.method as string);
      if (handlers) {
        for (const handler of handlers) {
          try { handler((parsed as { params?: unknown }).params); } catch { /* ignore */ }
        }
      }
    } else if (hasMethod && id !== undefined) {
      const handler = this.requestHandlers.get(parsed.method as string);
      if (handler) {
        handler((parsed as { params?: unknown }).params)
          .then((result) => this.send({ jsonrpc: '2.0', id, result }))
          .catch((err) => this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } }));
      }
    }
  }
}
