import { existsSync } from 'fs';
import { AcpSubprocess, type AcpSubprocessLaunchSpec } from './AcpSubprocess';
import { delimiter, extname } from 'path';
import { type AcpLogicalMethod, getAcpMethodCandidates } from './AcpMethodNames';
import { AcpProtocolError } from './AcpErrors';
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
	AgentCapabilities,
	FsCapabilityMode,
} from '../types';
import type { OpencodeClient } from './index';
import type { SessionMeta } from '../types';
import type { AcpResponse } from '../types';
import { t } from '../i18n/index';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { SessionUpdateNormalizer } from './sessionUpdateNormalizer';
import type { NormalizedUpdate } from '../types';
import { FsDelegate } from './fsDelegate';

export const CLIENT_VERSION = '0.0.30';

export interface AcpSessionMeta {
  availableCommands: AvailableCommand[];
  availableModels: ModelOption[];
  availableModes: ModeOption[];
  configOptions: SessionConfigOption[];
  currentModelId: string | null;
  currentModeId: string | null;
  sessionInfo?: {
    sessionId?: string;
    title?: string;
    cwd?: string;
  };
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
      return { sessionUpdate: 'tool_call_update', toolCallId: u.toolCallId as string, status: u.status as 'pending' | 'in_progress' | 'completed' | 'failed', kind: u.kind as import('../types').ToolKind, title: u.title as string, rawInput: u.rawInput as Record<string, unknown>, rawOutput: u.rawOutput as Record<string, unknown>, content: (u.content as Record<string, unknown>[])?.map((c) => c.type === 'terminal' ? { type: 'terminal', terminalId: c.terminalId } : c) as import('../types').ToolCallContent[] };
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

  if (result.sessionInfo) {
    snapshot.sessionInfo = result.sessionInfo as { sessionId?: string; title?: string; cwd?: string };
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

  if (result.sessionInfo) {
    snapshot.sessionInfo = result.sessionInfo as { sessionId?: string; title?: string; cwd?: string };
  }

  return snapshot;
}

export type AcpMcpServer =
  | { type: 'stdio'; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: 'sse'; name: string; url: string; headers: Array<{ name: string; value: string }> };

export class AcpClient implements OpencodeClient {
	private subprocess: AcpSubprocess | null = null;
	private connected = false;
	private transport: AcpJsonRpcTransport | null = null;
	private agentCapabilities: AgentCapabilities | null = null;
	private activeStreamSessionId: string | null = null;
	private activeAbortController: AbortController | null = null;
	private chunkHandler: ((update: NormalizedUpdate) => void) | null = null;
	private normalizer = new SessionUpdateNormalizer();
	private sessionId_: string | null = null;
	private cmdPath: string;
	private cwd?: string;
	private fsDelegate: FsDelegate | null = null;
	private fsCapabilityMode: FsCapabilityMode = 'enabled';
	private availableCommands: AvailableCommand[] = [{ name: 'compact', description: 'compact the session' }];
	private availableModels: ModelOption[] = [];
	private availableModes: ModeOption[] = [];
	private configOptions: SessionConfigOption[] = [];
	private currentModelId: string | null = null;
	private currentModeId: string | null = null;
	private sessionInfo: { sessionId?: string; title?: string; cwd?: string } | null = null;
	onClose?: () => void;
	onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
	onReconnect?: () => Promise<void>;
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 3;
	private isIntentionalDisconnect = false;
	private methodCache = new Map<AcpLogicalMethod, string>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cmdPath: string, cwd?: string) {
    this.cmdPath = cmdPath;
    this.cwd = cwd;
  }

  get permissionMode(): string { return 'yolo'; }
  set permissionMode(_v: string) { /* not used at this level */ }

  isConnected(): boolean { return this.connected; }

	async connect(): Promise<void> {
		if (this.connected) return;
		this.isIntentionalDisconnect = false;
		this.clearReconnectTimer();

		const cmd = this.cmdPath.replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1');
		const args = ['acp'];
		const cwd = this.cwd ?? process.cwd();

		const spawnInfo = this.getSpawnInfo(cmd, args);
		const launchSpec: AcpSubprocessLaunchSpec = {
			command: spawnInfo.command,
			args: spawnInfo.args,
			cwd,
		};
		const subprocess = new AcpSubprocess(launchSpec);
		this.subprocess = subprocess;

		try {
			subprocess.start();
			const input = subprocess.stdout;
			const output = subprocess.stdin;
			if (!input || !output) {
				throw new Error(t().acp.stdinNotWritable);
			}

			const transport = new AcpJsonRpcTransport({ input, output });
			this.transport = transport;
			transport.start();

			// Initialize FsDelegate for vault boundary checks
			this.fsDelegate = new FsDelegate({
				vaultPath: cwd,
				maxBytes: 8000, // Will be updated when settings are applied
			});

			transport.onNotification('session/update', (params) => {
				const p = params as Record<string, unknown> | undefined;
				const update = this.parseUpdate(p?.update as Record<string, unknown> | undefined);
				if (update) {
					this.applySessionUpdate(update);
					if (this.chunkHandler) {
						const norm = this.normalizer.normalize(update);
						if (norm) this.chunkHandler(norm);
					}
				}
			});

			transport.onRequest('request_permission', (params) => {
				return this.handleServerRequestPermission(params as Record<string, unknown>);
			});

			// Register fs/read_text_file handler
			transport.onRequest('fs/read_text_file', (params) => {
				return this.handleReadTextFile(params as Record<string, unknown>);
			});

			subprocess.onClose((error) => this.handleSubprocessClose(subprocess, error));

			const clientCapabilities: Record<string, unknown> = {};
			if (this.fsCapabilityMode === 'enabled') {
				clientCapabilities.fs = { readTextFile: true, writeTextFile: false };
			}

			const response = await this.request('initialize', {
				protocolVersion: 1,
				clientInfo: { name: 'copsidian', version: CLIENT_VERSION },
				clientCapabilities,
			}) as Record<string, unknown>;
			this.agentCapabilities = (response.agentCapabilities as AgentCapabilities) ?? null;
			this.connected = true;
		} catch (error) {
			await this.disposeConnection(error instanceof Error ? error : new Error(String(error)), true);
			throw error;
		}
	}

  getAgentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }

  async disconnect(): Promise<void> {
    this.isIntentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    await this.disposeConnection(new Error('Disconnected'), true);
  }

  async createSession(cwd?: string, mcpServers: McpServerConfig[] = []): Promise<string> {
    const r = await this.requestWithFallback('newSession', { cwd: this.resolveCwd(cwd), mcpServers: buildMcpServers(mcpServers) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = (r.sessionId as string | undefined) ?? null;
    return this.sessionId_ ?? '';
  }

  async loadSession(id: string, cwd?: string, mcpServers: McpServerConfig[] = []): Promise<void> {
    const r = await this.requestWithFallback('loadSession', { sessionId: id, cwd: this.resolveCwd(cwd), mcpServers: buildMcpServers(mcpServers) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.requestWithFallback('listSessions', { cwd: this.resolveCwd(cwd), limit: 100 }) as Record<string, unknown>;
    return (r.sessions as SessionMeta[]) ?? [];
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.requestWithFallback('forkSession', { sessionId: id, cwd: this.resolveCwd(cwd) }) as Record<string, unknown>;
    return r.sessionId as string;
  }

  async resumeSession(id: string, cwd?: string): Promise<void> {
    const r = await this.requestWithFallback('resumeSession', { sessionId: id, cwd: this.resolveCwd(cwd) }) as Record<string, unknown>;
    this.applySessionSnapshot(r);
    this.sessionId_ = id;
  }

  async closeSession(id: string): Promise<void> {
    await this.requestWithFallback('closeSession', { sessionId: id }).catch(() => {});
  }

  async setMode(id: string, modeId: string): Promise<void> {
    await this.requestWithFallback('setMode', { sessionId: id, modeId }).then(() => {});
    this.currentModeId = modeId;
  }

  async setModel(id: string, modelId: string): Promise<void> {
    await this.requestWithFallback('setModel', { sessionId: id, modelId }).then(() => {});
    this.currentModelId = modelId;
  }

  async setConfigOption(id: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const r = await this.requestWithFallback('setConfigOption', { sessionId: id, configId, value }) as Record<string, unknown>;
    const configOptions = (r?.configOptions as SessionConfigOption[]) ?? [];
    this.applyConfigOptions(configOptions);
    return configOptions;
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: NormalizedUpdate) => void): Promise<AcpResponse> {
    this.normalizer.reset();
    this.activeStreamSessionId = id;
    this.chunkHandler = onChunk;
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    return (this.requestWithFallback('prompt', { sessionId: id, prompt: parts }, undefined, signal) as Promise<AcpResponse>)
      .finally(() => {
        if (this.activeStreamSessionId === id) {
          this.activeStreamSessionId = null;
          this.chunkHandler = null;
          this.activeAbortController = null;
        }
      });
  }

  cancel(id: string): Promise<void> {
    if (this.activeStreamSessionId === id) {
      this.activeStreamSessionId = null;
      this.chunkHandler = null;
      if (this.activeAbortController) {
        this.activeAbortController.abort();
        this.activeAbortController = null;
      }
    }
    return this.requestWithFallback('cancel', { sessionId: id }).then(() => {}).catch(() => {});
  }

  compact(id: string): Promise<void> {
    return this.requestWithFallback('compact', { sessionId: id }).then(() => {}).catch(() => {});
  }

  async requestPermission(req: PermissionRequest): Promise<string> {
    const reject = req.options.find((o) => o.kind === 'reject_once');
    return reject?.optionId ?? req.options[0]?.optionId ?? 'reject_once';
  }

  getAvailableAgents(): Promise<ModeOption[]> { return Promise.resolve([...this.availableModes]); }
  getAvailableModels(): Promise<ModelOption[]> { return Promise.resolve([...this.availableModels]); }
  getAvailableCommands(): Promise<AvailableCommand[]> { return Promise.resolve([...this.availableCommands]); }
  getSessionInfo(): { sessionId?: string; title?: string; cwd?: string } | null {
    return this.sessionInfo;
  }
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

  abort(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

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
    this.sessionInfo = snapshot.sessionInfo ?? null;
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
      case 'session_info_update':
        this.sessionInfo = {
          ...this.sessionInfo,
          ...(typeof update.sessionId === 'string' ? { sessionId: update.sessionId } : {}),
          ...(typeof update.title === 'string' ? { title: update.title } : {}),
          ...(typeof update.cwd === 'string' ? { cwd: update.cwd } : {}),
        };
        break;
    }
  }

	private handleServerRequestPermission(params: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const req: PermissionRequest = {
				sessionId: params.sessionId as string,
				toolCall: params.toolCall as PermissionRequest['toolCall'],
				options: params.options as PermissionOption[],
			};

			const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
			handler(req).then((decision: string) => {
				resolve({ sessionId: params.sessionId, decision: { optionId: decision } });
			}).catch((error: unknown) => {
				console.error('[copsidian] permission request failed:', error);
				// Fallback to default handler on failure
				this.requestPermission(req).then((decision: string) => {
					resolve({ sessionId: params.sessionId, decision: { optionId: decision } });
				}).catch(reject);
			});
		});
	}

	private handleReadTextFile(params: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve) => {
			if (this.fsCapabilityMode !== 'enabled' || !this.fsDelegate) {
				resolve({ content: '', error: 'File system access is disabled' });
				return;
			}

			const filePath = params.path as string;
			if (!filePath) {
				resolve({ content: '', error: 'Missing required parameter: path' });
				return;
			}

			const result = this.fsDelegate.readTextFile(filePath);
			resolve(result);
		});
	}

	setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void {
		this.fsCapabilityMode = mode;
		if (this.fsDelegate && maxBytes !== undefined) {
			this.fsDelegate = new FsDelegate({
				vaultPath: this.cwd ?? process.cwd(),
				maxBytes,
			});
		}
	}

  private parseUpdate(u: Record<string, unknown> | undefined | null): SessionUpdate | null {
    return parseSessionUpdate(u);
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.transport) return Promise.reject(new Error(t().acp.stdinNotWritable));
    return this.transport.request(method, params);
  }

  private async requestWithFallback(logicalMethod: AcpLogicalMethod, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (!this.transport) throw new Error(t().acp.stdinNotWritable);

    const cachedMethod = this.methodCache.get(logicalMethod);
    if (cachedMethod) {
      return this.transport.request(cachedMethod, params, timeoutMs, signal);
    }

    const candidates = getAcpMethodCandidates(logicalMethod);
    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        const result = await this.transport.request(candidate, params, timeoutMs, signal);
        this.methodCache.set(logicalMethod, candidate);
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof AcpProtocolError && err.code === -32601) {
          continue; // Try next candidate
        }
        throw err; // Other errors: throw immediately
      }
    }

    throw lastError;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async disposeConnection(error?: Error, shutdownSubprocess = false): Promise<void> {
    const transport = this.transport;
    const subprocess = this.subprocess;
    this.transport = null;
    this.subprocess = null;
    this.connected = false;

    transport?.dispose(error);
    if (shutdownSubprocess) {
      await subprocess?.shutdown();
    }
  }

  private handleSubprocessClose(subprocess: AcpSubprocess, error?: Error): void {
    if (this.subprocess !== subprocess) return;

    const stderrMsg = subprocess.getStderrSnapshot() || '';
    const closeError = error ?? new Error(t().acp.processExited.replace('{code}', t().acp.unknownCode));
    if (error) {
      console.error('[copsidian] process error:', error, 'stderr:', stderrMsg);
    } else {
      console.error('[copsidian] process exited. stderr:', stderrMsg);
    }

    void this.disposeConnection(closeError).then(() => {
      this.onClose?.();
      if (!this.isIntentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    });
  }

  async reconnect(): Promise<void> {
    await this.disconnect().catch(() => {});
    this.isIntentionalDisconnect = false;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalDisconnect || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = 2000 * this.reconnectAttempts; // Exponential backoff
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isIntentionalDisconnect || this.connected || !this.onReconnect) return;
      this.connect().then(() => this.onReconnect?.()).then(() => {
          this.reconnectAttempts = 0;
        }).catch(() => {
        if (!this.isIntentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      });
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
    .filter((server) => server.enabled && server.name.trim())
    .map((server) => {
      if (server.type === 'stdio') {
        const cmd = server.command;
        if (!cmd || !cmd.trim()) return null;
        return {
          type: 'stdio',
          name: server.name.trim(),
          command: cmd.trim(),
          args: (server.args ?? []).map((arg) => arg.trim()).filter(Boolean),
          env: server.env ?? [],
        } satisfies AcpMcpServer;
      } else {
        const url = server.url;
        if (!url || !url.trim()) return null;
        return {
          type: server.type,
          name: server.name.trim(),
          url: url.trim(),
          headers: server.headers ?? [],
        } satisfies AcpMcpServer;
      }
    })
    .filter((server): server is AcpMcpServer => server !== null);
}
