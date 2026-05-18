import { spawn, type ChildProcess } from 'child_process';
import type {
  SessionUpdate,
  PromptPart,
  SessionConfigOption,
  PermissionRequest,
  PermissionOption,
  AvailableCommand,
  ModelOption,
  ModeOption,
} from '../types';
import type { OpencodeClient } from './index';
import type { SessionMeta } from '../types';
import type { AcpResponse } from '../types';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type RpcEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class AcpClient implements OpencodeClient {
  private process: ChildProcess | null = null;
  private connected = false;
  private nextId = 0;
  private pending = new Map<number, RpcEntry>();
  private buffer = '';
  private chunkHandler: ((update: SessionUpdate) => void) | null = null;
  private decoder = new TextDecoder();
  private sessionId_: string | null = null;
  private cmdPath: string;

  constructor(cmdPath: string) {
    this.cmdPath = cmdPath;
  }

  get permissionMode(): string { return 'yolo'; }
  set permissionMode(_v: string) { /* not used at this level */ }

  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    this.process = spawn(this.cmdPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    this.process.stdin!.on('error', (e: unknown) => console.error('[copsidian] stdin:', e));
    this.process.stdout!.on('data', (d: Uint8Array) => this.onStdout(d));
    this.process.on('close', () => { this.connected = false; });
    this.process.on('error', (e: unknown) => { this.connected = false; console.error('[copsidian] process:', e); });

    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'copsidian', version: '0.1.0' },
      capabilities: {},
    });
    this.connected = true;
    console.log('[copsidian] ACP connected');
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) { resolve(); return; }
      this.process.on('close', () => resolve());
      this.process.kill();
    });
  }

  async createSession(cwd?: string): Promise<string> {
    const r = await this.request('session/new', { cwd }) as any;
    this.sessionId_ = r.sessionId ?? null;
    return this.sessionId_ ?? '';
  }

  async loadSession(id: string, cwd?: string): Promise<void> {
    await this.request('session/load', { sessionId: id, cwd: cwd ?? undefined }) as void;
    this.sessionId_ = id;
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.request('session/list', { cwd, limit: 100 }) as any;
    return (r.sessions as SessionMeta[]) ?? [];
  }

  async closeSession(id: string): Promise<void> {
    await this.request('session/close', { sessionId: id }).catch(() => {});
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.request('session/unstable_fork', { sessionId: id, cwd }) as any;
    return r.sessionId;
  }

  async resumeSession(id: string, cwd?: string): Promise<void> {
    await this.request('session/resume', { sessionId: id, cwd }).then(() => {});
    this.sessionId_ = id;
  }

  async setMode(id: string, modeId: string): Promise<void> {
    await this.request('session/set_mode', { sessionId: id, modeId }).then(() => {});
  }

  async setConfigOption(id: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const r = await this.request('session/set_config_option', { sessionId: id, configId, value }) as any;
    return (r?.configOptions as SessionConfigOption[]) ?? [];
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: SessionUpdate) => void): Promise<AcpResponse> {
    this.chunkHandler = onChunk;
    return this.request('session/prompt', { sessionId: id, prompt: parts }) as Promise<AcpResponse>;
  }

  cancel(id: string): Promise<void> {
    return this.request('session/cancel', { sessionId: id }).then(() => {}).catch(() => {});
  }

  async requestPermission(req: PermissionRequest): Promise<string> {
    // Auto-approve safe tools
    if (['read', 'search'].includes(req.toolCall.kind)) return 'always';
    return 'once';
  }

  getAvailableAgents(): Promise<ModeOption[]> { return Promise.resolve([]); }
  getAvailableModels(): Promise<ModelOption[]> { return Promise.resolve([]); }
  getAvailableCommands(): Promise<AvailableCommand[]> {
    return Promise.resolve([{ name: 'compact', description: 'compact the session' }]);
  }

  getCurrentSessionId(): string | undefined { return this.sessionId_ ?? undefined; }

  // ── Private ──

  private onStdout(data: Uint8Array): void {
    this.buffer += this.decoder.decode(data, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id && msg.result !== undefined) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (entry) entry.resolve(msg.result);
    } else if (msg.id && msg.error) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (entry) entry.reject(new Error(msg.error.message));
    } else if (msg.method && !msg.id) {
      // Notification
      if (msg.method === 'session/update') {
        const update = this.parseUpdate((msg.params as any)?.update);
        if (update && this.chunkHandler) this.chunkHandler(update);
      }
    } else if (msg.method && msg.id) {
      // Server-initiated request
      this.handleServerRequest(msg, msg.id);
    }
  }

  private handleServerRequest(msg: any, id: number): void {
    if (msg.method === 'request_permission') {
      const p = msg.params as { sessionId: string; toolCall: any; options: PermissionOption[] };
      this.requestPermission({ sessionId: p.sessionId, toolCall: p.toolCall, options: p.options }).then((decision) => {
        if (this.process?.stdin?.writable) {
          const resp: JsonRpcResponse = {
            jsonrpc: '2.0', id,
            result: { sessionId: p.sessionId, decision: { optionId: decision } },
          };
          this.process.stdin.write(JSON.stringify(resp) + '\n');
        }
      }).catch(() => {});
    }
  }

  private parseUpdate(u: any): SessionUpdate | null {
    if (!u || !u.sessionUpdate) return null;
    const c = u.content;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return { sessionUpdate: 'agent_message_chunk', messageId: u.messageId, content: c };
      case 'agent_thought_chunk':
        return { sessionUpdate: 'agent_thought_chunk', messageId: u.messageId, content: c };
      case 'tool_call':
        return { sessionUpdate: 'tool_call', toolCallId: u.toolCallId, title: u.title, kind: u.kind, status: 'pending', rawInput: u.rawInput ?? {}, locations: u.locations ?? [] };
      case 'tool_call_update':
        return { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId, status: u.status, kind: u.kind, title: u.title, rawInput: u.rawInput, rawOutput: u.rawOutput, content: u.content };
      case 'plan':
        return { sessionUpdate: 'plan', entries: u.entries ?? [] };
      case 'user_message_chunk':
        return { sessionUpdate: 'user_message_chunk', messageId: u.messageId, content: c };
      case 'config_option_update':
        return { sessionUpdate: 'config_option_update', configOptions: u.configOptions ?? [] };
      case 'available_commands_update':
        return { sessionUpdate: 'available_commands_update', availableCommands: u.availableCommands ?? [] };
      case 'usage_update':
        return { sessionUpdate: 'usage_update', used: u.used, size: u.size, cost: u.cost };
      default: return null;
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(req);
    });
  }

  private send(obj: any): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify(obj) + '\n');
  }
}
