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
  McpServerConfig,
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

export interface AcpSessionMeta {
  availableCommands: AvailableCommand[];
  availableModels: ModelOption[];
  availableModes: ModeOption[];
  configOptions: SessionConfigOption[];
  currentModelId: string | null;
  currentModeId: string | null;
}

/** Parse a JSON-RPC update into a strongly typed SessionUpdate */
export function parseSessionUpdate(u: Record<string, unknown> | undefined | null): SessionUpdate | null {
  if (!u || !u.sessionUpdate) return null;
  const c = u.content;
  const su = u.sessionUpdate as string;
  switch (su) {
    case 'agent_message_chunk':
      return { sessionUpdate: 'agent_message_chunk', messageId: u.messageId as string, content: c as { type: string; text: string } };
    case 'agent_thought_chunk':
      return { sessionUpdate: 'agent_thought_chunk', messageId: u.messageId as string, content: c as { type: string; text: string } };
    case 'tool_call':
      return { sessionUpdate: 'tool_call', toolCallId: u.toolCallId as string, title: u.title as string, kind: u.kind as import('../types').ToolKind, status: (u.status as string) ?? 'pending', rawInput: u.rawInput as Record<string, unknown>, locations: u.locations as { path: string }[] };
    case 'tool_call_update':
      return { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId as string, status: u.status as 'pending' | 'in_progress' | 'completed' | 'failed', kind: u.kind as import('../types').ToolKind, title: u.title as string, rawInput: u.rawInput as Record<string, unknown>, rawOutput: u.rawOutput as Record<string, unknown>, content: u.content as import('../types').ToolCallContent[] };
    case 'plan':
      return { sessionUpdate: 'plan', entries: (u.entries ?? []) as { content: string; status: string; priority: string }[] };
    case 'user_message_chunk':
      return { sessionUpdate: 'user_message_chunk', messageId: u.messageId as string, content: c as { type: string; text: string } };
    case 'config_option_update':
      return { sessionUpdate: 'config_option_update', configOptions: (u.configOptions ?? []) as import('../types').SessionConfigOption[] };
    case 'available_commands_update':
      return { sessionUpdate: 'available_commands_update', availableCommands: (u.availableCommands ?? []) as import('../types').AvailableCommand[] };
    case 'usage_update':
      return { sessionUpdate: 'usage_update', used: u.used as number, size: u.size as number, cost: u.cost as { amount: number; currency: string }, totalTokens: u.totalTokens as number, inputTokens: u.inputTokens as number, outputTokens: u.outputTokens as number, thoughtTokens: u.thoughtTokens as number };
    case 'current_mode_update':
      return { sessionUpdate: 'current_mode_update', currentModeId: u.currentModeId as string, availableModes: u.availableModes as import('../types').ModeOption[] };
    case 'current_model_update':
      return { sessionUpdate: 'current_model_update', currentModelId: u.currentModelId as string, availableModels: u.availableModels as import('../types').ModelOption[] };
    case 'session_info_update':
      return { sessionUpdate: 'session_info_update', sessionId: u.sessionId as string, title: u.title as string, cwd: u.cwd as string };
    default: return null;
  }
}

/** Merge command lists, deduplicating by name and ensuring 'compact' is present */
export function mergeAvailableCommands(commands: AvailableCommand[]): AvailableCommand[] {
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

/** Extract model and mode metadata from config options */
export function extractConfigMeta(configOptions: SessionConfigOption[]): Pick<AcpSessionMeta, 'currentModelId' | 'availableModels' | 'currentModeId' | 'availableModes' | 'configOptions'> {
  const meta: Pick<AcpSessionMeta, 'currentModelId' | 'availableModels' | 'currentModeId' | 'availableModes' | 'configOptions'> = {
    configOptions: [...configOptions],
    currentModelId: null,
    availableModels: [],
    currentModeId: null,
    availableModes: [],
  };

  const modelOption = configOptions.find((opt) => opt.id === 'model');
  if (modelOption) {
    meta.currentModelId = modelOption.currentValue;
    meta.availableModels = modelOption.options.map((opt) => ({
      modelId: opt.value,
      name: opt.name,
    }));
  }

  const modeOption = configOptions.find((opt) => opt.id === 'mode');
  if (modeOption) {
    meta.currentModeId = modeOption.currentValue;
    meta.availableModes = modeOption.options.map((opt) => ({
      id: opt.value,
      name: opt.name,
      description: opt.description,
    }));
  }

  return meta;
}

/** Extract session metadata from a server result object */
export function extractSessionSnapshot(result: Record<string, unknown>): AcpSessionMeta {
  const snapshot: AcpSessionMeta = {
    availableCommands: [{ name: 'compact', description: 'compact the session' }],
    availableModels: [],
    availableModes: [],
    configOptions: [],
    currentModelId: null,
    currentModeId: null,
  };

  if (!result || typeof result !== 'object') return snapshot;

  if (Array.isArray(result.availableCommands)) {
    snapshot.availableCommands = mergeAvailableCommands(result.availableCommands as AvailableCommand[]);
  }

  if (Array.isArray(result.configOptions)) {
    const configMeta = extractConfigMeta(result.configOptions as SessionConfigOption[]);
    snapshot.configOptions = configMeta.configOptions;
    snapshot.currentModelId = configMeta.currentModelId;
    snapshot.availableModels = configMeta.availableModels;
    snapshot.currentModeId = configMeta.currentModeId;
    snapshot.availableModes = configMeta.availableModes;
  }

  const models = result.models as { currentModelId?: string; availableModels?: ModelOption[] } | undefined;
  if (models) {
    if (typeof models.currentModelId === 'string') {
      snapshot.currentModelId = models.currentModelId;
    }
    if (Array.isArray(models.availableModels)) {
      snapshot.availableModels = [...models.availableModels];
    }
  }

  const modes = result.modes as { currentModeId?: string; availableModes?: ModeOption[] } | undefined;
  if (modes) {
    if (typeof modes.currentModeId === 'string') {
      snapshot.currentModeId = modes.currentModeId;
    }
    if (Array.isArray(modes.availableModes)) {
      snapshot.availableModes = [...modes.availableModes];
    }
  }

  return snapshot;
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/** Fields common to all JSON-RPC message types received from the server. */
interface JsonRpcIncoming {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: Record<string, unknown>;
}

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

  async createSession(cwd?: string, mcpServers: McpServerConfig[] = []): Promise<string> {
    const r = await this.request('session/new', { cwd: this.resolveCwd(cwd), mcpServers: buildMcpServers(mcpServers) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = (r.sessionId as string | undefined) ?? null;
    return this.sessionId_ ?? '';
  }

  async loadSession(id: string, cwd?: string): Promise<void> {
    const r = await this.request('session/load', { sessionId: id, cwd: this.resolveCwd(cwd) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.request('session/list', { cwd: this.resolveCwd(cwd), limit: 100 }) as Record<string, unknown>;
    return (r.sessions as SessionMeta[]) ?? [];
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.request('session/unstable_fork', { sessionId: id, cwd: this.resolveCwd(cwd) }) as Record<string, unknown>;
    return r.sessionId as string;
  }

  async resumeSession(id: string, cwd?: string): Promise<void> {
    const r = await this.request('session/resume', { sessionId: id, cwd: this.resolveCwd(cwd) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async closeSession(id: string): Promise<void> {
    await this.request('session/close', { sessionId: id }).catch(() => {});
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
    const r = await this.request('session/set_config_option', { sessionId: id, configId, value }) as Record<string, unknown>;
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

  setClientHandlers(handlers: import('./index').ClientHandlers): void {
    this.onClose = handlers.onClose ?? undefined;
    this.onReconnect = handlers.onReconnect ?? undefined;
    this.onPermissionRequest = handlers.onPermissionRequest ?? undefined;
  }

  // ── Private ──

  private resolveCwd(cwd?: string): string {
    return cwd ?? this.cwd ?? process.cwd();
  }

  private applySessionSnapshot(result: Record<string, unknown>): void {
    const snapshot = extractSessionSnapshot(result);
    this.availableCommands = snapshot.availableCommands;
    this.availableModels = snapshot.availableModels;
    this.availableModes = snapshot.availableModes;
    this.configOptions = snapshot.configOptions;
    this.currentModelId = snapshot.currentModelId;
    this.currentModeId = snapshot.currentModeId;
  }

  private applyConfigOptions(configOptions: SessionConfigOption[]): void {
    const meta = extractConfigMeta(configOptions);
    this.configOptions = meta.configOptions;
    this.currentModelId = meta.currentModelId;
    this.availableModels = meta.availableModels;
    this.currentModeId = meta.currentModeId;
    this.availableModes = meta.availableModes;
  }

  private mergeAvailableCommands(commands: AvailableCommand[]): AvailableCommand[] {
    return mergeAvailableCommands(commands);
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
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(line); } catch { return; }
    const msg: JsonRpcIncoming = parsed;

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
        const update = this.parseUpdate(msg.params?.update as Record<string, unknown> | undefined);
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

  private handleServerRequest(msg: JsonRpcIncoming, id: number): void {
    if (msg.method === 'request_permission' && msg.params) {
      const p = msg.params;
      const req: PermissionRequest = {
        sessionId: p.sessionId as string,
        toolCall: p.toolCall as PermissionRequest['toolCall'],
        options: p.options as PermissionOption[],
      };
      const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
      handler(req).then((decision) => {
        const resp: JsonRpcResponse = {
          jsonrpc: '2.0', id,
          result: { sessionId: p.sessionId, decision: { optionId: decision } },
        };
        this.send(resp as unknown as Record<string, unknown>);
      }).catch(() => {});
    }
  }

  private parseUpdate(u: Record<string, unknown> | undefined | null): SessionUpdate | null {
    return parseSessionUpdate(u);
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(req);
    });
  }

  private send(obj: object): void {
    if (!this.process?.stdin?.writable) {
      console.error('[copsidian] ACP send failed: stdin not writable');
      return;
    }
    const json = JSON.stringify(obj) + '\n';
    this.process.stdin.write(json, (err: unknown) => {
      if (err) console.error('[copsidian] ACP write error:', err);
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = 2000 * this.reconnectAttempts; // Exponential backoff
    setTimeout(() => {
      if (!this.connected && this.onReconnect) {
        this.onReconnect().then(() => {
          this.reconnectAttempts = 0;
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

export function buildMcpServers(servers: McpServerConfig[]): AcpMcpServer[] {
  return servers
    .filter((server) => server.enabled && server.name.trim() && server.command.trim())
    .map((server) => ({
      name: server.name.trim(),
      command: server.command.trim(),
      args: server.args.map((arg) => arg.trim()).filter(Boolean),
      env: [],
    }));
}
