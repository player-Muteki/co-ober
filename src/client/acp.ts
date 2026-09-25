import { ACP_LIST_SESSIONS_LIMIT, ACP_RECONNECT_BACKOFF_BASE_MS } from '../constants';
import { getSpawnInfo } from '../utils/commandResolution';
import { AcpSubprocess, type AcpSubprocessLaunchSpec } from './AcpSubprocess';

import { type AcpLogicalMethod, getAcpMethodCandidates } from './AcpMethodNames';
import { AcpProtocolError, AcpSessionMissingError, isSessionMissingError, isAuthRequiredError } from './AcpErrors';
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
import type { VaultWriteIo } from './fsDelegate';
import {
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zPlanUpdate,
  zConfigOptionUpdate,
  zAvailableCommandsUpdate,
  zCurrentModeUpdate,
  zCurrentModelUpdate,
  zSessionInfoUpdate,
  zUsageUpdate,
  zNoticeUpdate,
  zNotice,
  zCompactionUpdate,
  zStateUpdate,
} from './acpSchemas';
import { z } from 'zod';

export const CLIENT_VERSION = '0.1.35';

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

/** Kinds already reported as unknown; each logs once per client lifetime. */
const warnedUnknownUpdateKinds = new Set<string>();

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
    case 'plan_update': {
      // v2: coerce the item-based envelope onto the v1 plan shape; reserved
      // non-items content variants stay unrendered.
      const r = zPlanUpdate.safeParse(u);
      if (!r.success || r.data.plan.type !== 'items' || !Array.isArray(r.data.plan.entries)) return null;
      return { sessionUpdate: 'plan', entries: r.data.plan.entries };
    }
    case 'notice_update': {
      const r = zNoticeUpdate.safeParse(u);
      return r.success && r.data.message ? r.data : null;
    }
    case 'notice': {
      // Official v2-alpha spelling; fold severity/title/description onto the
      // internal notice_update shape so every consumer keeps one representation.
      const r = zNotice.safeParse(u);
      if (!r.success) return null;
      const message = [r.data.title, r.data.description].filter(Boolean).join(' — ');
      if (!message) return null;
      return { sessionUpdate: 'notice_update', level: r.data.severity, message };
    }
    case 'compaction_update': {
      const r = zCompactionUpdate.safeParse(u);
      return r.success ? r.data : null;
    }
    case 'compaction_summary_chunk':
      // Known v2 frame feeding a summary the transcript does not paint; drop
      // it here so it stays out of the unknown-kind warning, emitting nothing.
      return null;
    case 'state_update': {
      const r = zStateUpdate.safeParse(u);
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
    default:
      // Agents emit kinds outside the ACP contract (e.g. opencode's
      // module_chunk); dropping them silently hides protocol drift.
      if (!warnedUnknownUpdateKinds.has(su)) {
        warnedUnknownUpdateKinds.add(su);
        console.warn(`[co-ober] dropping unknown session update kind: ${su}`);
      }
      return null;
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
    merged.push({ name: 'compact', description: t().slash.compact });
  }

  return merged;
}

/** Extract model and mode metadata from config options */
export function extractConfigMeta(
  configOptions: SessionConfigOption[],
): Pick<AcpSessionMeta, 'currentModelId' | 'availableModels' | 'currentModeId' | 'availableModes' | 'configOptions'> {
  const meta: Pick<
    AcpSessionMeta,
    'currentModelId' | 'availableModels' | 'currentModeId' | 'availableModes' | 'configOptions'
  > = {
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
    availableCommands: [{ name: 'compact', description: t().slash.compact }],
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

const CAPABILITY_GROUP_KEYS = ['sessionCapabilities', 'promptCapabilities', 'mcpCapabilities'] as const;

function normalizeCapabilityValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  // OpenCode signals support with an empty object, e.g. sessionCapabilities.fork = {}.
  if (value && typeof value === 'object' && !Array.isArray(value)) return true;
  return undefined;
}

/**
 * Normalize agent capabilities from the initialize response so UI gating can
 * rely on plain booleans: some agents mark support with `{}` instead of `true`.
 */
export function normalizeAgentCapabilities(raw: unknown): AgentCapabilities | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if ((CAPABILITY_GROUP_KEYS as readonly string[]).includes(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const group: Record<string, boolean> = {};
      for (const [capKey, capValue] of Object.entries(value as Record<string, unknown>)) {
        const bool = normalizeCapabilityValue(capValue);
        if (bool !== undefined) group[capKey] = bool;
      }
      if (Object.keys(group).length > 0) out[key] = group;
      continue;
    }
    if (key === 'authMethods') {
      if (Array.isArray(value)) out.authMethods = value;
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
      out[key] = value;
    }
  }
  return out as AgentCapabilities;
}

export type AuthMethod = NonNullable<AgentCapabilities['authMethods']>[number];

/** Coerce a raw authMethods list from the agent into safe {id, name, description} entries. */
export function normalizeAuthMethods(raw: unknown): AuthMethod[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthMethod[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const src = item as Record<string, unknown>;
    if (typeof src.id !== 'string' || !src.id) continue;
    const name = typeof src.name === 'string' && src.name ? src.name : src.id;
    const description = typeof src.description === 'string' && src.description ? src.description : undefined;
    out.push({ id: src.id, name, ...(description ? { description } : {}) });
  }
  return out;
}

export class AcpClient implements OpencodeClient {
  private subprocess: AcpSubprocess | null = null;
  private connected = false;
  private transport: AcpJsonRpcTransport | null = null;
  private requestHandler: AcpRequestHandler | null = null;
  private agentCapabilities: AgentCapabilities | null = null;
  private authMethods: AuthMethod[] = [];
  private authAttempted = false;
  private activeStreams = new Map<string, { handler: (update: NormalizedUpdate) => void; abort: AbortController }>();
  private replayHandler: ((update: NormalizedUpdate) => void) | null = null;
  private replaySessionId: string | null = null;
  private normalizer = new SessionUpdateNormalizer();
  private sessionId_: string | null = null;
  private cmdPath: string;
  private cwd?: string;
  private vaultIo?: VaultWriteIo;
  private availableCommands: AvailableCommand[] = [{ name: 'compact', description: t().slash.compact }];
  private availableModels: ModelOption[] = [];
  private availableModes: ModeOption[] = [];
  private configOptions: SessionConfigOption[] = [];
  private currentModelId: string | null = null;
  private currentModeId: string | null = null;
  private sessionInfo: { sessionId?: string; title?: string; cwd?: string } | null = null;
  onClose?: () => void;
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
  onPermissionUnreadable?: (summary: string) => void;
  onReconnect?: () => Promise<void>;
  onReconnectFailed?: () => void;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private isIntentionalDisconnect = false;
  private methodCache = new Map<AcpLogicalMethod, string>();
  private reconnectTimer: number | null = null;
  /**
   * Incremented every time a subprocess connection is created or disposed.
   * Async continuations capture the current generation and abort themselves
   * when it no longer matches, so a superseded connect can never mutate or
   * tear down the newer connection's state.
   */
  private kernelGeneration = 0;
  /**
   * Generation of a connect() whose handshake has not finished yet. While set,
   * a subprocess close for that connection belongs to the in-flight connect and
   * its catch owns teardown — handling it here too would schedule a reconnect
   * that resurrects a subprocess whose launch already failed (ENOENT retry storms).
   */
  private connectingGeneration: number | null = null;

  constructor(cmdPath: string, cwd?: string, vaultIo?: VaultWriteIo) {
    this.cmdPath = cmdPath;
    this.cwd = cwd;
    this.vaultIo = vaultIo;
  }

  // Real state kept on the client: main.ts / toolbar assign the active
  // permission tier here so onPermissionRequest can branch on 'safe'.
  permissionMode: PermissionLevel = 'yolo';

  isConnected(): boolean {
    return this.connected;
  }

  /** Monotonic counter identifying the current subprocess connection attempt. */
  get generation(): number {
    return this.kernelGeneration;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.isIntentionalDisconnect = false;
    this.clearReconnectTimer();
    const generation = ++this.kernelGeneration;
    this.connectingGeneration = generation;

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

    let transport: AcpJsonRpcTransport | null = null;
    let requestHandler: AcpRequestHandler | null = null;

    // A failed spawn (ENOENT) surfaces here first; the transport only sees
    // a closed pipe. Keep the launch error so the UI can name the binary.
    let launchError: Error | null = null;

    try {
      subprocess.start();
      subprocess.onClose((error) => {
        if (error) launchError = launchError ?? error;
        this.handleSubprocessClose(subprocess, error);
      });
      const input = subprocess.stdout;
      const output = subprocess.stdin;
      if (!input || !output) {
        throw new Error(t().acp.stdinNotWritable);
      }

      transport = new AcpJsonRpcTransport({ input, output });
      this.transport = transport;
      transport.start();

      // Initialize AcpRequestHandler (manages FS, terminal, permission handlers)
      requestHandler = new AcpRequestHandler({
        transport,
        vaultPath: cwd,
        onPermissionRequest: this.onPermissionRequest,
        vaultIo: this.vaultIo,
        onPermissionUnreadable: (summary) => this.onPermissionUnreadable?.(summary),
      });
      this.requestHandler = requestHandler;

      const onSessionUpdate = (params: unknown): void => {
        // Drop updates from a transport that has since been replaced or disposed.
        if (this.transport !== transport) return;
        this.dispatchSessionUpdate(params);
      };
      // Exact-match dispatch: accept both the spec and legacy wire names.
      transport.onNotification('session/update', onSessionUpdate);
      transport.onNotification('sessionUpdate', onSessionUpdate);

      const response = await this.requestWithFallback('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'co-ober', version: CLIENT_VERSION },
        clientCapabilities: requestHandler.buildClientCapabilities(),
      });
      if (this.kernelGeneration !== generation) {
        throw new Error(t().acp.superseded);
      }
      const initResult = z
        .object({ agentCapabilities: z.unknown().optional(), authMethods: z.unknown().optional() })
        .safeParse(response);
      if (initResult.success) {
        this.agentCapabilities = normalizeAgentCapabilities(initResult.data.agentCapabilities);
        // Some agents advertise authMethods at the top level of the initialize
        // result rather than nested under agentCapabilities.
        const topAuth = normalizeAuthMethods(initResult.data.authMethods);
        if (topAuth.length > 0 && normalizeAuthMethods(this.agentCapabilities?.authMethods).length === 0) {
          this.agentCapabilities = { ...(this.agentCapabilities ?? {}), authMethods: topAuth };
        }
      } else {
        this.agentCapabilities = null;
      }
      this.authMethods = normalizeAuthMethods(this.agentCapabilities?.authMethods);
      this.authAttempted = false;
      this.methodCache.clear();
      this.connected = true;
    } catch (error) {
      const failure = launchError ?? (error instanceof Error ? error : new Error(String(error)));
      if (this.kernelGeneration === generation) {
        this.onClose?.();
        await this.disposeConnection(failure, true);
      } else {
        // A newer connection owns the client state now; only clean up our own resources.
        requestHandler?.dispose();
        transport?.dispose(failure);
        await subprocess.shutdown().catch(() => {});
      }
      throw failure;
    } finally {
      if (this.connectingGeneration === generation) this.connectingGeneration = null;
    }
  }

  getAgentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilities;
  }

  /** Auth methods advertised by the agent in its initialize result. */
  getAuthMethods(): AuthMethod[] {
    return this.authMethods;
  }

  /** Run one `authenticate` request; resolves false on any failure (never throws). */
  async authenticate(methodId: string): Promise<boolean> {
    if (!methodId || !this.connected) return false;
    try {
      await this.requestWithFallback('authenticate', { methodId });
      return true;
    } catch (error) {
      console.warn('[co-ober] authenticate failed:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.isIntentionalDisconnect = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.onClose?.();
    await this.disposeConnection(new Error(t().acp.disconnected), true);
  }

  async createSession(cwd?: string, mcpServers: McpServerConfig[] = []): Promise<string> {
    const request = () =>
      this.requestWithFallback('newSession', {
        cwd: this.resolveCwd(cwd),
        mcpServers: buildMcpServers(mcpServers),
      });
    let r: unknown;
    try {
      r = await request();
    } catch (err) {
      // An agent that requires login answers session/new with auth_required;
      // try its preferred auth method once per connection, then retry.
      if (!isAuthRequiredError(err) || this.authAttempted) throw err;
      this.authAttempted = true;
      const [preferred] = this.authMethods;
      if (!preferred || !(await this.authenticate(preferred.id))) throw err;
      r = await request();
    }
    const parsed = z.object({ sessionId: z.string() }).safeParse(r);
    if (!parsed.success) throw new Error(t().acp.invalidSessionId);
    this.applySessionSnapshot(r as Record<string, unknown>);
    this.sessionId_ = parsed.data.sessionId;
    return this.sessionId_;
  }

  async loadSession(
    id: string,
    cwd?: string,
    mcpServers: McpServerConfig[] = [],
    onReplayUpdate?: (u: NormalizedUpdate) => void,
  ): Promise<void> {
    this.normalizer.reset();
    this.replayHandler = onReplayUpdate ?? null;
    this.replaySessionId = id;
    try {
      const r = await this.requestWithFallback('loadSession', {
        sessionId: id,
        cwd: this.resolveCwd(cwd),
        mcpServers: buildMcpServers(mcpServers),
      });
      this.applySessionSnapshot(r as Record<string, unknown>);
      this.sessionId_ = id;
    } catch (e) {
      if (isSessionMissingError(e)) throw new AcpSessionMissingError(id, e);
      throw e;
    } finally {
      this.replayHandler = null;
      this.replaySessionId = null;
    }
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    const r = await this.requestWithFallback('listSessions', {
      cwd: this.resolveCwd(cwd),
      limit: ACP_LIST_SESSIONS_LIMIT,
    });
    const parsed = z
      .object({ sessions: z.array(z.object({ sessionId: z.string() }).passthrough()).optional() })
      .safeParse(r);
    return parsed.success ? (parsed.data.sessions as SessionMeta[]) : [];
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.requestWithFallback('forkSession', { sessionId: id, cwd: this.resolveCwd(cwd) });
    const parsed = z.object({ sessionId: z.string() }).safeParse(r);
    if (!parsed.success) throw new Error(t().acp.invalidForkSessionId);
    return parsed.data.sessionId;
  }

  async resumeSession(id: string, cwd?: string, onReplayUpdate?: (u: NormalizedUpdate) => void): Promise<void> {
    this.normalizer.reset();
    this.replayHandler = onReplayUpdate ?? null;
    this.replaySessionId = id;
    try {
      const r = await this.requestWithFallback('resumeSession', { sessionId: id, cwd: this.resolveCwd(cwd) });
      this.applySessionSnapshot(r as Record<string, unknown>);
      this.sessionId_ = id;
    } catch (e) {
      if (isSessionMissingError(e)) throw new AcpSessionMissingError(id, e);
      throw e;
    } finally {
      this.replayHandler = null;
      this.replaySessionId = null;
    }
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
    const configOptions = parsed.success ? ((parsed.data.configOptions as SessionConfigOption[]) ?? []) : [];
    this.applyConfigOptions(configOptions);
    return configOptions;
  }

  /**
   * Route one session/update notification frame: state updates apply only to
   * the main (or replaying) session, chunk delivery targets that session's
   * active stream slot.
   */
  private dispatchSessionUpdate(params: unknown): void {
    const p = params as Record<string, unknown> | undefined;
    const sid = typeof p?.sessionId === 'string' ? p.sessionId : null;
    const update = this.parseUpdate(p?.update as Record<string, unknown> | undefined);
    if (!update) return;
    if (update.sessionUpdate === 'usage_update' && typeof process.env.DEBUG_CO_OBER !== 'undefined') {
      // Usage updates are frequent in long sessions; only log when debug is enabled.
      console.debug('[co-ober] usage_update:', JSON.stringify(update));
    }
    // Client state (models, modes, commands, config) is per-session:
    // a side-chat or a session we switched away from must not clobber it.
    if (!sid || sid === this.sessionId_ || sid === this.replaySessionId) {
      this.applySessionUpdate(update);
    }
    const norms = this.normalizer.normalizeList(update);
    if (norms.length === 0) return;
    let entry = sid ? this.activeStreams.get(sid) : undefined;
    if (!entry && !sid && this.activeStreams.size === 1) {
      // Legacy wire frames without a session id: safe only when unambiguous.
      entry = this.activeStreams.values().next().value;
    }
    if (entry) {
      for (const norm of norms) entry.handler(norm);
    } else if (this.replayHandler && (!sid || sid === this.replaySessionId)) {
      for (const norm of norms) this.replayHandler(norm);
    }
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: NormalizedUpdate) => void): Promise<AcpResponse> {
    if (this.activeStreams.has(id)) {
      return Promise.reject(new Error(t().acp.streamActive));
    }
    // One normalizer serves all streams (state is keyed by messageId), but a
    // reset mid-flight would wipe another session's accumulated text.
    if (this.activeStreams.size === 0) this.normalizer.reset();
    const stream = { handler: onChunk, abort: new AbortController() };
    this.activeStreams.set(id, stream);
    const signal = stream.abort.signal;

    // Use 0 timeout to disable transport-level timeout for streaming
    // The idle timeout in AgentRuntime handles cancellation
    const zAcpResponse = z.object({
      stopReason: z.enum([
        'end_turn',
        'max_tokens',
        'max_turn_requests',
        'tool_calls',
        'interrupted',
        'refusal',
        'cancelled',
      ]),
      usage: z
        .object({
          totalTokens: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          thoughtTokens: z.number().optional(),
          cachedReadTokens: z.number().optional(),
          cachedWriteTokens: z.number().optional(),
        })
        .optional(),
      _meta: z.record(z.string(), z.unknown()).optional(),
    });
    return this.requestWithFallback('prompt', { sessionId: id, prompt: parts }, 0, signal)
      .then((res) => {
        const parsed = zAcpResponse.safeParse(res);
        if (!parsed.success) {
          throw new Error(t().acp.invalidResponse);
        }
        return parsed.data as AcpResponse;
      })
      .finally(() => {
        if (this.activeStreams.get(id) === stream) this.activeStreams.delete(id);
      });
  }

  cancel(id: string): Promise<void> {
    // Abort the in-flight prompt for THIS session first so its sendMessage()
    // rejects immediately; other sessions' streams keep running.
    const stream = this.activeStreams.get(id);
    this.activeStreams.delete(id);
    stream?.abort.abort();

    return this.requestWithFallback('cancel', { sessionId: id })
      .then(() => {})
      .catch((e) => {
        console.warn('[co-ober] cancel RPC failed:', e);
      });
  }

  getAvailableAgents(): Promise<ModeOption[]> {
    return Promise.resolve([...this.availableModes]);
  }
  getAvailableModels(): Promise<ModelOption[]> {
    return Promise.resolve([...this.availableModels]);
  }
  getAvailableCommands(): Promise<AvailableCommand[]> {
    return Promise.resolve([...this.availableCommands]);
  }
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

  getCurrentSessionId(): string | undefined {
    return this.sessionId_ ?? undefined;
  }

  abort(): void {
    // Stop the main session's stream; with no main stream fall back to a
    // single unambiguous active stream (legacy global-abort semantics).
    const targetId =
      this.sessionId_ && this.activeStreams.has(this.sessionId_)
        ? this.sessionId_
        : this.activeStreams.size === 1
          ? [...this.activeStreams.keys()][0]
          : null;
    if (!targetId) return;
    const stream = this.activeStreams.get(targetId);
    this.activeStreams.delete(targetId);
    stream?.abort.abort();
  }

  setClientHandlers(handlers: import('./index').ClientHandlers): void {
    this.onClose = handlers.onClose ?? undefined;
    this.onReconnect = handlers.onReconnect ?? undefined;
    this.onReconnectFailed = handlers.onReconnectFailed ?? undefined;
    this.onPermissionRequest = handlers.onPermissionRequest ?? undefined;
    this.onPermissionUnreadable = handlers.onPermissionUnreadable ?? undefined;
    if (this.requestHandler) {
      if (handlers.onPermissionRequest) {
        this.requestHandler.onPermissionRequest = handlers.onPermissionRequest;
      }
      this.requestHandler.onPermissionUnreadable = (summary) => this.onPermissionUnreadable?.(summary);
    }
  }

  setFsCapabilityMode(mode: import('../types').FsCapabilityMode, maxBytes?: number): void {
    this.requestHandler?.setFsCapabilityMode(mode, maxBytes);
  }

  setTerminalCapabilityMode(
    mode: import('../types').TerminalCapabilityMode,
    timeoutMs?: number,
    maxOutputBytes?: number,
  ): void {
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
        // v2-alpha may carry config options inside the session info frame.
        if (update.configOptions) this.applyConfigOptions(update.configOptions);
        break;
    }
  }

  private parseUpdate(u: Record<string, unknown> | undefined | null): SessionUpdate | null {
    return parseSessionUpdate(u);
  }

  private async requestWithFallback(
    logicalMethod: AcpLogicalMethod,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
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
    // Invalidate any in-flight connect()/reconnect continuation for the old generation.
    this.kernelGeneration++;
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
    this.activeStreams.clear();
    this.replaySessionId = null;
    this.normalizer.reset();

    transport?.dispose(error);
    if (shutdownSubprocess) {
      await subprocess?.shutdown();
    }
  }

  private handleSubprocessClose(subprocess: AcpSubprocess, error?: Error): void {
    if (this.subprocess !== subprocess) return;
    // A close that races the in-flight handshake belongs to that connect():
    // its catch owns teardown, and scheduling a reconnect behind it would
    // resurrect a subprocess whose launch just failed (ENOENT retry storms).
    if (this.connectingGeneration !== null && !this.connected) return;

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
    const generation = this.kernelGeneration;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isIntentionalDisconnect || this.connected || !this.onReconnect) return;
      if (this.kernelGeneration !== generation) return; // a newer connection superseded this attempt
      this.connect()
        .then(() => {
          if (!this.isIntentionalDisconnect) return this.onReconnect?.();
        })
        .then(() => {
          this.reconnectAttempts = 0;
        })
        .catch(() => {
          if (this.isIntentionalDisconnect) return;
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          } else {
            this.onReconnectFailed?.();
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
