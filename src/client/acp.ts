import { ACP_LIST_SESSIONS_LIMIT, ACP_RECONNECT_BACKOFF_BASE_MS } from '../constants';
import { getSpawnInfo } from '../utils/commandResolution';
import { AcpSubprocess, type AcpSubprocessLaunchSpec } from './AcpSubprocess';

import { type AcpLogicalMethod, getAcpMethodCandidates } from './AcpMethodNames';
import { AcpProtocolError } from './AcpErrors';
import type {
	SessionUpdate,
	PromptPart,
	SessionConfigOption,
	PermissionLevel,
	PermissionRequest,
	AvailableCommand,
	ModelOption,
	ModeOption,
	SessionSnapshot,
	McpServerConfig,
	AgentCapabilities,
} from '../types';
import type { OpencodeClient } from './index';
import type { SessionMeta } from '../types';
import type { AcpResponse } from '../types';
import { t } from '../i18n/index';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { SessionUpdateNormalizer } from './sessionUpdateNormalizer';
import type { NormalizedUpdate } from '../types';
import { AcpRequestHandler } from './AcpRequestHandler';
import {
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zConfigOptionUpdate,
  zAvailableCommandsUpdate,
  zCurrentModeUpdate,
  zCurrentModelUpdate,
  zSessionInfoUpdate,
  zUsageUpdate,
} from './acpSchemas';
import { z } from 'zod';

export const CLIENT_VERSION = '0.1.23';

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
  const su = u.sessionUpdate as string;
  switch (su) {
    case 'agent_message_chunk': {
      const r = zAgentMessageChunk.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'agent_thought_chunk': {
      const r = zAgentThoughtChunk.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'tool_call': {
      const r = zToolCall.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'tool_call_update': {
      const r = zToolCallUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'plan': {
      const r = zPlan.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'user_message_chunk': {
      const r = zUserMessageChunk.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'config_option_update': {
      const r = zConfigOptionUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'available_commands_update': {
      const r = zAvailableCommandsUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'usage_update': {
      const r = zUsageUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'current_mode_update': {
      const r = zCurrentModeUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'current_model_update': {
      const r = zCurrentModelUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'session_info_update': {
      const r = zSessionInfoUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
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
	private requestHandler: AcpRequestHandler | null = null;
	private agentCapabilities: AgentCapabilities | null = null;
	private activeStreamSessionId: string | null = null;
	private activeAbortController: AbortController | null = null;
	private chunkHandler: ((update: NormalizedUpdate) => void) | null = null;
	private normalizer = new SessionUpdateNormalizer();
	private sessionId_: string | null = null;
	private cmdPath: string;
	private cwd?: string;
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
	private reconnectTimer: number | null = null;

  constructor(cmdPath: string, cwd?: string) {
    this.cmdPath = cmdPath;
    this.cwd = cwd;
  }

  get permissionMode(): PermissionLevel { return 'yolo'; }
  set permissionMode(_v: PermissionLevel) { /* not used at this level */ }

  isConnected(): boolean { return this.connected; }

	async connect(): Promise<void> {
		if (this.connected) return;
		this.isIntentionalDisconnect = false;
		this.clearReconnectTimer();

		const cmd = this.cmdPath.replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1');
		const args = ['acp'];
		const cwd = this.cwd ?? process.cwd();

		const spawnInfo = getSpawnInfo(cmd, args, process.platform, process.env);
		const launchSpec: AcpSubprocessLaunchSpec = {
			command: spawnInfo.command,
			args: spawnInfo.args,
			cwd,
		};
		const subprocess = new AcpSubprocess(launchSpec);
		this.subprocess = subprocess;

		try {
			subprocess.start();
			subprocess.onClose((error) => this.handleSubprocessClose(subprocess, error));
			const input = subprocess.stdout;
			const output = subprocess.stdin;
			if (!input || !output) {
				throw new Error(t().acp.stdinNotWritable);
			}

			const transport = new AcpJsonRpcTransport({ input, output });
			this.transport = transport;
			transport.start();

			// Initialize AcpRequestHandler (manages FS, terminal, permission handlers)
			this.requestHandler = new AcpRequestHandler({
				transport,
				vaultPath: cwd,
				onPermissionRequest: this.onPermissionRequest,
			});

		transport.onNotification('session/update', (params) => {
			const p = params as Record<string, unknown> | undefined;
			const update = this.parseUpdate(p?.update as Record<string, unknown> | undefined);
			if (update) {
				if (update.sessionUpdate === 'usage_update') {
					// Usage updates are frequent in long sessions; only log when debug is enabled.
					if (typeof process.env.DEBUG_CO_OBER !== 'undefined') {
						console.debug('[co-ober] usage_update:', JSON.stringify(update));
					}
				}
				this.applySessionUpdate(update);
				if (this.chunkHandler) {
					const norm = this.normalizer.normalize(update);
					if (norm) this.chunkHandler(norm);
				}
			}
		});

			const response = await this.requestWithFallback('initialize', {
				protocolVersion: 1,
				clientInfo: { name: 'co-ober', version: CLIENT_VERSION },
				clientCapabilities: this.requestHandler.buildClientCapabilities(),
			});
			const initResult = z.object({ agentCapabilities: z.unknown().optional() }).safeParse(response);
			this.agentCapabilities = (initResult.success ? initResult.data.agentCapabilities as AgentCapabilities : null) ?? null;
			this.methodCache.clear();
			this.connected = true;
		} catch (error) {
			this.onClose?.();
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
    this.onClose?.();
    await this.disposeConnection(new Error('Disconnected'), true);
  }

  async createSession(cwd?: string, mcpServers: McpServerConfig[] = []): Promise<string> {
    const r = await this.requestWithFallback('newSession', { cwd: this.resolveCwd(cwd), mcpServers: buildMcpServers(mcpServers) });
    const parsed = z.object({ sessionId: z.string() }).safeParse(r);
    if (!parsed.success) throw new Error('Server did not return a valid session ID');
    this.applySessionSnapshot(r as Record<string, unknown>);
    this.sessionId_ = parsed.data.sessionId;
    return this.sessionId_;
  }

  async loadSession(id: string, cwd?: string, mcpServers: McpServerConfig[] = []): Promise<void> {
    const r = await this.requestWithFallback('loadSession', { sessionId: id, cwd: this.resolveCwd(cwd), mcpServers: buildMcpServers(mcpServers) });
    this.applySessionSnapshot(r as Record<string, unknown>);
    this.sessionId_ = id;
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.requestWithFallback('listSessions', { cwd: this.resolveCwd(cwd), limit: ACP_LIST_SESSIONS_LIMIT });
    const parsed = z.object({ sessions: z.array(z.object({ sessionId: z.string() }).passthrough()).optional() }).safeParse(r);
    return parsed.success ? parsed.data.sessions as SessionMeta[] : [];
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.requestWithFallback('forkSession', { sessionId: id, cwd: this.resolveCwd(cwd) });
    const parsed = z.object({ sessionId: z.string() }).safeParse(r);
    if (!parsed.success) throw new Error('Server did not return a valid session ID for fork');
    return parsed.data.sessionId;
  }

  async resumeSession(id: string, cwd?: string): Promise<void> {
    const r = await this.requestWithFallback('resumeSession', { sessionId: id, cwd: this.resolveCwd(cwd) });
    this.applySessionSnapshot(r as Record<string, unknown>);
    this.sessionId_ = id;
  }

  async closeSession(id: string): Promise<void> {
    try {
      await this.requestWithFallback('closeSession', { sessionId: id });
    } catch (e) {
      console.warn(`[co-ober] failed to close session ${id}:`, e);
    }
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
    const r = await this.requestWithFallback('setConfigOption', { sessionId: id, configId, value });
    const parsed = z.object({ configOptions: z.array(z.any()).optional() }).safeParse(r);
    const configOptions = parsed.success ? parsed.data.configOptions as SessionConfigOption[] ?? [] : [];
    this.applyConfigOptions(configOptions);
    return configOptions;
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: NormalizedUpdate) => void): Promise<AcpResponse> {
    if (this.activeStreamSessionId !== null) {
      return Promise.reject(new Error('A stream is already active'));
    }
    this.normalizer.reset();
    this.activeStreamSessionId = id;
    this.chunkHandler = onChunk;
    this.activeAbortController = new AbortController();
    const signal = this.activeAbortController.signal;

    // Use 0 timeout to disable transport-level timeout for streaming
    // The idle timeout in AgentRuntime handles cancellation
    const zAcpResponse = z.object({
      stopReason: z.enum(['end_turn', 'max_tokens', 'tool_calls', 'interrupted']),
      usage: z.object({
        totalTokens: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        thoughtTokens: z.number().optional(),
        cachedReadTokens: z.number().optional(),
        cachedWriteTokens: z.number().optional(),
      }).optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    });
    return this.requestWithFallback('prompt', { sessionId: id, prompt: parts }, 0, signal)
      .then((res) => {
        const parsed = zAcpResponse.safeParse(res);
        if (!parsed.success) {
          throw new Error('Invalid ACP response format');
        }
        return parsed.data as AcpResponse;
      })
      .finally(() => {
        if (this.activeStreamSessionId === id) {
          this.activeStreamSessionId = null;
          this.chunkHandler = null;
          this.activeAbortController = null;
        }
      });
  }

  cancel(id: string): Promise<void> {
    // Send RPC cancel first, then clean up local state to avoid a race where
    // the stream ends between local cleanup and the RPC, leaving a dangling
    // prompt Promise.
    // wasActive is intentionally unused — we unconditionally clean up
    // to avoid the race described below.
    this.activeStreamSessionId = null;
    this.chunkHandler = null;
    this.activeAbortController?.abort();
    this.activeAbortController = null;

    return this.requestWithFallback('cancel', { sessionId: id }).then(() => {}).catch((e) => {
      console.warn('[co-ober] cancel RPC failed:', e);
    });
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
    if (this.requestHandler && handlers.onPermissionRequest) {
      this.requestHandler.onPermissionRequest = handlers.onPermissionRequest;
    }
  }

  setFsCapabilityMode(mode: import('../types').FsCapabilityMode, maxBytes?: number): void {
    this.requestHandler?.setFsCapabilityMode(mode, maxBytes);
  }

  setTerminalCapabilityMode(mode: import('../types').TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void {
    this.requestHandler?.setTerminalCapabilityMode(mode, timeoutMs, maxOutputBytes);
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

  private applySessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'config_option_update':
        this.applyConfigOptions(update.configOptions);
        break;
      case 'available_commands_update':
        this.availableCommands = mergeAvailableCommands(update.availableCommands);
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

  private parseUpdate(u: Record<string, unknown> | undefined | null): SessionUpdate | null {
    return parseSessionUpdate(u);
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
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async disposeConnection(error?: Error, shutdownSubprocess = false): Promise<void> {
    const transport = this.transport;
    const subprocess = this.subprocess;
    const requestHandler = this.requestHandler;
    this.transport = null;
    this.subprocess = null;
    this.requestHandler = null;
    this.connected = false;

    // Reset method cache so reconnect picks up fresh method names
    this.methodCache.clear();

    // Clean up terminal processes and FS delegate on disconnect
    requestHandler?.dispose();

    // Clear session state so reconnect reloads models/modes
    this.sessionId_ = null;
    this.activeStreamSessionId = null;
    this.chunkHandler = null;
    this.activeAbortController = null;
    this.normalizer.reset();

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
      console.error('[co-ober] process error:', error, 'stderr:', stderrMsg);
    } else {
      console.error('[co-ober] process exited. stderr:', stderrMsg);
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
    const delay = ACP_RECONNECT_BACKOFF_BASE_MS * this.reconnectAttempts;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isIntentionalDisconnect || this.connected || !this.onReconnect) return;
      this.connect().then(() => {
          if (!this.isIntentionalDisconnect) return this.onReconnect?.();
        }).then(() => {
          this.reconnectAttempts = 0;
        }).catch(() => {
        if (!this.isIntentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      });
    }, delay);
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