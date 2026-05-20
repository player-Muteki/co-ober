import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, extname } from 'path';
import type {
  SessionUpdate,
  PromptPart,
  SessionConfigOption,
  PermissionRequest,
  PermissionOption,
  AvailableCommand,
  ModelOption,
  ModeOption,
  SessionSnapshot,
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
  private cwd?: string;
  private availableCommands: AvailableCommand[] = [{ name: 'compact', description: 'compact the session' }];
  private availableModels: ModelOption[] = [];
  private availableModes: ModeOption[] = [];
  private configOptions: SessionConfigOption[] = [];
  private currentModelId: string | null = null;
  private currentModeId: string | null = null;
  onClose?: () => void;
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
  onReconnect?: () => Promise<void>;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private isIntentionalDisconnect = false;

  constructor(cmdPath: string, cwd?: string) {
    this.cmdPath = cmdPath;
    this.cwd = cwd;
  }

  get permissionMode(): string { return 'yolo'; }
  set permissionMode(_v: string) { /* not used at this level */ }

  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    const cmd = this.cmdPath.replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1');
    const args = ['acp'];
    const cwd = this.cwd ?? process.cwd();

    const spawnInfo = this.getSpawnInfo(cmd, args);
    this.process = spawn(spawnInfo.command, spawnInfo.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.process.stdin!.on('error', (e: unknown) => console.error('[copsidian] stdin:', e));
    this.process.stdout!.on('data', (d: Uint8Array) => this.onStdout(d));
    this.process.stderr?.on('data', (d: Uint8Array) => {
      console.error('[copsidian] stderr:', this.decoder.decode(d));
    });
    this.process.on('close', (code) => {
      this.connected = false;
      console.error('[copsidian] process exited with code:', code);
      this.onClose?.();

      // Auto-reconnect if not intentional disconnect
      if (!this.isIntentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    });
    this.process.on('error', (e: unknown) => {
      this.connected = false;
      console.error('[copsidian] process:', e);
      this.onClose?.();
    });

    await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'copsidian', version: '0.2.0' },
      clientCapabilities: {},
    });
    this.connected = true;
    console.log('[copsidian] ACP connected');
  }

  async disconnect(): Promise<void> {
    this.isIntentionalDisconnect = true;
    this.reconnectAttempts = 0;
    return new Promise((resolve) => {
      if (!this.process) { resolve(); return; }
      this.process.on('close', () => resolve());
      this.process.kill();
    });
  }

  async createSession(cwd?: string): Promise<string> {
    const r = await this.request('session/new', { cwd: this.resolveCwd(cwd), mcpServers: [] }) as any;
    this.applySessionSnapshot(r);
    this.sessionId_ = r.sessionId ?? null;
    return this.sessionId_ ?? '';
  }

  async loadSession(id: string, cwd?: string): Promise<void> {
    const r = await this.request('session/load', { sessionId: id, cwd: this.resolveCwd(cwd) }) as any;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.request('session/list', { cwd: this.resolveCwd(cwd), limit: 100 }) as any;
    return (r.sessions as SessionMeta[]) ?? [];
  }

  async closeSession(id: string): Promise<void> {
    await this.request('session/close', { sessionId: id }).catch(() => {});
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.request('session/unstable_fork', { sessionId: id, cwd: this.resolveCwd(cwd) }) as any;
    return r.sessionId;
  }

  async resumeSession(id: string, cwd?: string): Promise<void> {
    const r = await this.request('session/resume', { sessionId: id, cwd: this.resolveCwd(cwd) }) as any;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async setMode(id: string, modeId: string): Promise<void> {
    await this.request('session/set_mode', { sessionId: id, modeId }).then(() => {});
    this.currentModeId = modeId;
  }

  async setModel(id: string, modelId: string): Promise<void> {
    await this.request('session/set_model', { sessionId: id, modelId }).then(() => {});
    this.currentModelId = modelId;
  }

  async setConfigOption(id: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const r = await this.request('session/set_config_option', { sessionId: id, configId, value }) as any;
    const configOptions = (r?.configOptions as SessionConfigOption[]) ?? [];
    this.applyConfigOptions(configOptions);
    return configOptions;
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: SessionUpdate) => void): Promise<AcpResponse> {
    this.chunkHandler = onChunk;
    return this.request('session/prompt', { sessionId: id, prompt: parts }) as Promise<AcpResponse>;
  }

  cancel(id: string): Promise<void> {
    return this.request('session/cancel', { sessionId: id }).then(() => {}).catch(() => {});
  }

  compact(id: string): Promise<void> {
    return this.request('session/compact', { sessionId: id }).then(() => {}).catch(() => {});
  }

  async requestPermission(req: PermissionRequest): Promise<string> {
    const allow = req.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
    return allow?.optionId ?? req.options[0]?.optionId ?? 'allow_once';
  }

  getAvailableAgents(): Promise<ModeOption[]> { return Promise.resolve([...this.availableModes]); }
  getAvailableModels(): Promise<ModelOption[]> { return Promise.resolve([...this.availableModels]); }
  getAvailableCommands(): Promise<AvailableCommand[]> { return Promise.resolve([...this.availableCommands]); }
  getSessionSnapshot(): SessionSnapshot {
    return {
      configOptions: [...this.configOptions],
      availableCommands: [...this.availableCommands],
      availableModels: [...this.availableModels],
      availableModes: [...this.availableModes],
      currentModelId: this.currentModelId,
      currentModeId: this.currentModeId,
    };
  }

  getCurrentSessionId(): string | undefined { return this.sessionId_ ?? undefined; }

  // ── Private ──

  private resolveCwd(cwd?: string): string {
    return cwd ?? this.cwd ?? process.cwd();
  }

  private applySessionSnapshot(result: any): void {
    if (!result || typeof result !== 'object') return;

    if (Array.isArray(result.availableCommands)) {
      this.availableCommands = this.mergeAvailableCommands(result.availableCommands as AvailableCommand[]);
    }

    if (Array.isArray(result.configOptions)) {
      this.applyConfigOptions(result.configOptions as SessionConfigOption[]);
    }

    const models = result.models as { currentModelId?: string; availableModels?: ModelOption[] } | undefined;
    if (models) {
      if (typeof models.currentModelId === 'string') {
        this.currentModelId = models.currentModelId;
      }
      if (Array.isArray(models.availableModels)) {
        this.availableModels = [...models.availableModels];
      }
    }

    const modes = result.modes as { currentModeId?: string; availableModes?: ModeOption[] } | undefined;
    if (modes) {
      if (typeof modes.currentModeId === 'string') {
        this.currentModeId = modes.currentModeId;
      }
      if (Array.isArray(modes.availableModes)) {
        this.availableModes = [...modes.availableModes];
      }
    }
  }

  private applyConfigOptions(configOptions: SessionConfigOption[]): void {
    this.configOptions = [...configOptions];

    const modelOption = configOptions.find((opt) => opt.id === 'model');
    if (modelOption) {
      this.currentModelId = modelOption.currentValue;
      this.availableModels = modelOption.options.map((opt) => ({
        modelId: opt.value,
        name: opt.name,
      }));
    }

    const modeOption = configOptions.find((opt) => opt.id === 'mode');
    if (modeOption) {
      this.currentModeId = modeOption.currentValue;
      this.availableModes = modeOption.options.map((opt) => ({
        id: opt.value,
        name: opt.name,
        description: opt.description,
      }));
    }
  }

  private mergeAvailableCommands(commands: AvailableCommand[]): AvailableCommand[] {
    const merged: AvailableCommand[] = [];
    const seen = new Set<string>();

    for (const command of commands) {
      const name = command.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push({ ...command });
    }

    if (!seen.has('compact')) {
      merged.push({ name: 'compact', description: 'compact the session' });
    }

    return merged;
  }

  private applySessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'config_option_update':
        this.applyConfigOptions(update.configOptions);
        break;
      case 'available_commands_update':
        this.availableCommands = this.mergeAvailableCommands(update.availableCommands);
        break;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') {
          this.currentModeId = update.currentModeId;
        }
        if (update.availableModes) {
          this.availableModes = [...update.availableModes];
        }
        break;
      case 'current_model_update':
        if (typeof update.currentModelId === 'string') {
          this.currentModelId = update.currentModelId;
        }
        if (update.availableModels) {
          this.availableModels = [...update.availableModels];
        }
        break;
    }
  }

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
        if (update) {
          this.applySessionUpdate(update);
          if (this.chunkHandler) this.chunkHandler(update);
        }
      }
    } else if (msg.method && msg.id) {
      // Server-initiated request
      this.handleServerRequest(msg, msg.id);
    }
  }

  private handleServerRequest(msg: any, id: number): void {
    if (msg.method === 'request_permission') {
      const p = msg.params as { sessionId: string; toolCall: any; options: PermissionOption[] };
      const req: PermissionRequest = { sessionId: p.sessionId, toolCall: p.toolCall, options: p.options };
      const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
      handler(req).then((decision) => {
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
        return { sessionUpdate: 'tool_call', toolCallId: u.toolCallId, title: u.title, kind: u.kind, status: u.status ?? 'pending', rawInput: u.rawInput, locations: u.locations };
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
        return { sessionUpdate: 'usage_update', used: u.used, size: u.size, cost: u.cost, totalTokens: u.totalTokens, inputTokens: u.inputTokens, outputTokens: u.outputTokens, thoughtTokens: u.thoughtTokens };
      case 'current_mode_update':
        return { sessionUpdate: 'current_mode_update', currentModeId: u.currentModeId, availableModes: u.availableModes };
      case 'current_model_update':
        return { sessionUpdate: 'current_model_update', currentModelId: u.currentModelId, availableModels: u.availableModels };
      case 'session_info_update':
        return { sessionUpdate: 'session_info_update', sessionId: u.sessionId, title: u.title, cwd: u.cwd };
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

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = 2000 * this.reconnectAttempts; // Exponential backoff
    console.log(`[copsidian] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    setTimeout(() => {
      if (!this.connected && this.onReconnect) {
        this.onReconnect().then(() => {
          this.reconnectAttempts = 0;
          console.log('[copsidian] Auto-reconnect successful');
        }).catch(() => {
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        });
      }
    }, delay);
  }

  private getSpawnInfo(cmd: string, args: string[]): { command: string; args: string[] } {
    if (process.platform !== 'win32') return { command: cmd, args };

    const resolved = this.resolveWindowsCommand(cmd);
    if (resolved.useCmdShell) {
      const commandLine = [this.quoteCmdArg(resolved.command), ...args.map((arg) => this.quoteCmdArg(arg))].join(' ');
      const comspec = process.env.ComSpec ?? 'cmd.exe';
      return { command: comspec, args: ['/d', '/s', '/c', commandLine] };
    }

    return { command: resolved.command, args };
  }

  private resolveWindowsCommand(cmd: string): { command: string; useCmdShell: boolean } {
    const ext = extname(cmd).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') return { command: cmd, useCmdShell: true };
    if (ext) return { command: cmd, useCmdShell: false };

    if (cmd.includes('\\') || cmd.includes('/')) {
      const exe = `${cmd}.exe`;
      if (existsSync(exe)) return { command: exe, useCmdShell: false };
      const cmdExt = `${cmd}.cmd`;
      if (existsSync(cmdExt)) return { command: cmdExt, useCmdShell: true };
      const batExt = `${cmd}.bat`;
      if (existsSync(batExt)) return { command: batExt, useCmdShell: true };
      return { command: cmd, useCmdShell: false };
    }

    const pathExts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT')
      .split(';')
      .map((value) => value.toLowerCase());
    const pathDirs = (process.env.PATH ?? '').split(delimiter);

    for (const dir of pathDirs) {
      for (const extPart of pathExts) {
        const candidate = `${dir}\\${cmd}${extPart}`;
        if (existsSync(candidate)) {
          const useCmdShell = extPart === '.cmd' || extPart === '.bat';
          return { command: candidate, useCmdShell };
        }
      }
    }

    return { command: cmd, useCmdShell: false };
  }

  private quoteCmdArg(value: string): string {
    if (!value) return '""';
    if (!/[\s"]/g.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
  }
}
