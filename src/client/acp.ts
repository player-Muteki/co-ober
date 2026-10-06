import { ACP_LIST_SESSIONS_LIMIT, ACP_LIST_SESSIONS_MAX_PAGES, ACP_RECONNECT_BACKOFF_BASE_MS, ACP_LOAD_SESSION_IDLE_TIMEOUT_MS, MAX_CONCURRENT_STREAMS, MAX_SESSION_NORMALIZERS } from '../constants';
import { getSpawnInfo } from '../utils/commandResolution';
import { AcpSubprocess, type AcpSubprocessLaunchSpec } from './AcpSubprocess';

import { type AcpLogicalMethod, getAcpMethodCandidates } from './AcpMethodNames';
import {
  AcpProtocolError,
  AcpSessionMissingError,
  AcpStreamCapacityError,
  AcpTimeoutError,
  isSessionMissingError,
  isAuthRequiredError,
} from './AcpErrors';
import type {
  SessionUpdate,
  PromptPart,
  SessionConfigOption,
  PermissionLevel,
  PermissionRequest,
  PermissionDecision,
  CapabilityGrant,
  AvailableCommand,
  ModelOption,
  ModeOption,
  SessionSnapshot,
  McpServerConfig,
  AgentCapabilities,
  ToolCallContent,
  TerminalOutputResult,
  ElicitationRequest,
  ElicitationAnswer,
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
  zPlanRemoved,
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
  parseConfigOptions,
  parseAvailableCommands,
} from './acpSchemas';
import { z } from 'zod';

// Update kinds whose only destination is a transcript. The rest (models,
// modes, commands, config, usage) are client state `applySessionUpdate` has
// already taken in, so such a frame arriving with no stream behind it is not a
// lost piece of the conversation.
const UNPLACED_UPDATE_KINDS = new Set(['message_chunk', 'tool_call_snapshot', 'plan', 'notice', 'compaction']);

export const CLIENT_VERSION = '0.2.57';

/** Tail length of the agent stderr snapshot attached to a close error. */
const STDERR_SNAPSHOT_CHARS = 800;

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

/**
 * Kinds already reported as unknown, and kinds already reported as
 * validation-rejected. One entry logs once per *connection* — `connect()`
 * clears both, so a reconnect that starts losing the same frame again is
 * visible a second time instead of being silenced by the last run's memory.
 */
const warnedUnknownUpdateKinds = new Set<string>();
const warnedRejectedKinds = new Set<string>();

/** Forget the once-per-connection drop warnings; called by every new handshake. */
export function resetDropWarnings(): void {
  warnedUnknownUpdateKinds.clear();
  warnedRejectedKinds.clear();
}

/** Why a frame was not drawn, reported for every drop so a tab can count them. */
export type DropReporter = (kind: string) => void;

/**
 * A `terminal` content item names a process this very client spawned, so its
 * output is ours to read — the renderer has no way to fetch it. Fold the
 * output and exit status into the only content shape it can paint.
 */
export function terminalContentFrom(res: TerminalOutputResult | null): ToolCallContent {
  if (!res || res.error) {
    // Say which kind of absence the manager reported. A `released` reason
    // keeps the old wording — someone did release a terminal that had been
    // here. An `unknown` reason says so, because "no longer available" over
    // an id this client never created points the reader at a release that
    // did not happen, the exact shape the 0.2.42 stage D absent-vs-unread
    // note fix refused for references to renamed-away files. A null manager
    // (disconnect or disposal) keeps the released reading, matching the
    // pre-split behavior where the same string covered both.
    const text =
      res?.errorReason === 'unknown' ? t().tool.terminalUnknown : t().tool.terminalGone;
    return { type: 'content', content: { type: 'text', text } };
  }
  const lines: string[] = [];
  if (res.truncated) lines.push(t().tool.outputTrimmed);
  if (res.output) lines.push(res.output);
  const exit = res.exitStatus;
  // A clean 0 exit is what a finished tool card already says; the line is
  // worth its space when the process ended badly.
  if (exit?.signal) lines.push(t().tool.terminated.replace('{signal}', exit.signal));
  else if (exit && exit.exitCode) lines.push(t().tool.exitCode.replace('{code}', String(exit.exitCode)));
  return { type: 'content', content: { type: 'text', text: lines.join('\n') } };
}

/**
 * Known update kinds that fail validation were invisible drops — protocol
 * drift never surfaced. Log the first offending issue once per kind, then
 * drop the frame as before.
 */
function unwrapParsed<T>(
  su: string,
  r: { success: true; data: T } | { success: false; error: { issues: { path: readonly unknown[]; message: string }[] } },
  onDrop?: DropReporter,
): T | null {
  if (r.success) return r.data;
  if (!warnedRejectedKinds.has(su)) {
    warnedRejectedKinds.add(su);
    const issue = r.error.issues[0];
    console.warn(`[co-ober] ${su} frame rejected: ${issue ? `${issue.path.map(String).join('.') || '(root)'} — ${issue.message}` : 'invalid'}`);
  }
  onDrop?.(su);
  return null;
}

/** Parse a JSON-RPC update into a strongly typed SessionUpdate */
export function parseSessionUpdate(
  u: Record<string, unknown> | undefined | null,
  onDrop?: DropReporter,
): SessionUpdate | null {
  if (!u || !u.sessionUpdate) return null;
  const su = u.sessionUpdate as string;
  switch (su) {
    case 'agent_message_chunk': {
      const r = zAgentMessageChunk.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'agent_thought_chunk': {
      const r = zAgentThoughtChunk.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'tool_call': {
      const r = zToolCall.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'tool_call_update': {
      const r = zToolCallUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'plan': {
      const r = zPlan.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'plan_update': {
      // v2: coerce the item-based envelope onto the v1 plan shape; reserved
      // non-items content variants stay unrendered.
      const r = zPlanUpdate.safeParse(u);
      if (!r.success) return unwrapParsed(su, r, onDrop);
      if (r.data.plan.type !== 'items' || !Array.isArray(r.data.plan.entries)) {
        const key = `plan_update:${r.data.plan.type}`;
        if (!warnedRejectedKinds.has(key)) {
          warnedRejectedKinds.add(key);
          console.warn(`[co-ober] plan_update with content type '${r.data.plan.type}' has no renderable items; dropping`);
        }
        onDrop?.(su);
        return null;
      }
      return { sessionUpdate: 'plan', entries: r.data.plan.entries };
    }
    case 'plan_removed': {
      // v2 signals plan completion by removal; an empty plan clears the panel.
      const r = zPlanRemoved.safeParse(u);
      if (!r.success) onDrop?.(su);
      return r.success ? { sessionUpdate: 'plan', entries: [] } : null;
    }
    case 'notice_update': {
      const r = zNoticeUpdate.safeParse(u);
      if (!r.success) onDrop?.(su);
      // A notice that parsed but carries no message is still content that
      // arrived and cannot be shown; it counts as dropped, not as a silent gap.
      if (r.success && !r.data.message) onDrop?.(su);
      return r.success && r.data.message ? r.data : null;
    }
    case 'notice': {
      // Official v2-alpha spelling; fold severity/title/description onto the
      // internal notice_update shape so every consumer keeps one representation.
      const r = zNotice.safeParse(u);
      if (!r.success) {
        onDrop?.(su);
        return null;
      }
      const message = [r.data.title, r.data.description].filter(Boolean).join(' — ');
      if (!message) {
        onDrop?.(su);
        return null;
      }
      return { sessionUpdate: 'notice_update', level: r.data.severity, message };
    }
    case 'compaction_update': {
      const r = zCompactionUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'compaction_summary_chunk':
      // Known v2 frame feeding a summary the transcript does not paint. It
      // stays out of the unknown-kind warning, but the text it carried is
      // still content that arrived and never reached the reader.
      onDrop?.(su);
      return null;
    case 'state_update': {
      const r = zStateUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'user_message_chunk': {
      const r = zUserMessageChunk.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'config_option_update': {
      const r = zConfigOptionUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'available_commands_update': {
      const r = zAvailableCommandsUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'usage_update': {
      const r = zUsageUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'current_mode_update': {
      const r = zCurrentModeUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'current_model_update': {
      const r = zCurrentModelUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    case 'session_info_update': {
      const r = zSessionInfoUpdate.safeParse(u);
      return unwrapParsed(su, r, onDrop);
    }
    default:
      // Agents emit kinds outside the ACP contract (e.g. opencode's
      // module_chunk); dropping them silently hides protocol drift.
      if (!warnedUnknownUpdateKinds.has(su)) {
        warnedUnknownUpdateKinds.add(su);
        console.warn(`[co-ober] dropping unknown session update kind: ${su}`);
      }
      onDrop?.(su);
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
    const hint = command.argumentHint ?? command.input?.hint;
    // `input` is the wire's home for the hint; the merged entry carries the
    // field every menu reads instead, so nothing downstream sees the raw pair.
    merged.push({ name, description: command.description ?? '', ...(hint ? { argumentHint: hint } : {}) });
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
    // A boolean currentValue is not a model id; claiming one would put the
    // word "true" in the model selector.
    meta.currentModelId = typeof modelOption.currentValue === 'string' ? modelOption.currentValue : null;
    meta.availableModels = modelOption.options.map((opt) => ({
      modelId: opt.value,
      name: opt.name,
    }));
  }

  const modeOption = configOptions.find((opt) => opt.id === 'mode');
  if (modeOption) {
    meta.currentModeId = typeof modeOption.currentValue === 'string' ? modeOption.currentValue : null;
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
    // Read through the same parser a notification already uses: this is the
    // agent's `session/new` answer, and an entry without a name used to be
    // handed to `command.name.trim()` as a cast said it was one of ours.
    snapshot.availableCommands = mergeAvailableCommands(parseAvailableCommands(result.availableCommands));
  }

  if (result.sessionInfo) {
    snapshot.sessionInfo = result.sessionInfo;
  }

  if (Array.isArray(result.configOptions)) {
    // Same reader as a config_option_update notification: an agent that groups
    // its model choices, or ships a boolean toggle with no options, used to
    // throw here — from inside the code that runs right after the session was
    // created — and the caller never heard about the session at all.
    const configMeta = extractConfigMeta(parseConfigOptions(result.configOptions));
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
  return out;
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
  /**
   * One normalizer per session: two sessions minting the same messageId must
   * not weld their accumulated text together. LRU-evicted past
   * MAX_SESSION_NORMALIZERS (idle sessions only).
   */
  private normalizers = new Map<string, SessionUpdateNormalizer>();
  private sessionId_: string | null = null;
  /** Sessions the agent currently holds (created/loaded/resumed here); cleared with the connection. */
  private loadedSessionIds = new Set<string>();
  private cmdPath: string;
  private cwd?: string;
  private vaultIo?: VaultWriteIo;
  /** Session metadata per session id; the null key is the pre-session slot. */
  private sessionMeta = new Map<string | null, AcpSessionMeta>();
  /** No-sessionId frames with several delivery targets are dropped; warn once per connection. */
  private warnedAmbiguousNoSid = false;
  onClose?: () => void;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** The agent asked the user a question; the view answers it or declines. */
  onElicitationRequest?: (req: ElicitationRequest) => Promise<ElicitationAnswer>;
  onPermissionUnreadable?: (summary: string, sessionId?: string) => void;
  /** This client let the agent write a file or run a command without asking anyone. */
  onCapabilityGrant?: (grant: CapabilityGrant) => void;
  /** An inbound frame could not be drawn; the conversation it belongs to says so. */
  onProtocolDrift?: (sessionId: string | null, kind: string) => void;
  /** Agent reported an outstanding elicitation resolved elsewhere. */
  onElicitationComplete?: (elicitationId: string) => void;
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
  /**
   * The capability tier last requested, remembered on the client rather than
   * only on the handler. The handler exists while connected, so a tier set
   * before `connect()` used to reach the wire as the defaults: the agent was
   * told `fs.writeTextFile` and `terminal` were supported after the user had
   * switched them off, then had every attempt refused by the runtime gate.
   */
  private capabilityTier: {
    fs: import('../types').FsCapabilityMode;
    fsMaxBytes?: number;
    terminal: import('../types').TerminalCapabilityMode;
    terminalTimeoutMs?: number;
    terminalMaxOutputBytes?: number;
  } = { fs: 'enabled', terminal: 'enabled' };
  /** The protocol version the agent answered `initialize` with, if any. */
  agentProtocolVersion: number | null = null;

  /** Hand the remembered tier to whichever handler is live (freshly built or not). */
  private syncCapabilityTier(): void {
    const tier = this.capabilityTier;
    this.requestHandler?.setFsCapabilityMode(tier.fs, tier.fsMaxBytes);
    this.requestHandler?.setTerminalCapabilityMode(tier.terminal, tier.terminalTimeoutMs, tier.terminalMaxOutputBytes);
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnectExhausted(): boolean {
    // A client that is currently connected is not exhausted by definition —
    // the counter is reset on a successful attempt (:1476) and on reconnect()
    // (:1458). The flag only reports meaningfully after a drop.
    if (this.connected) return false;
    return this.reconnectAttempts >= this.maxReconnectAttempts;
  }

  /** Monotonic counter identifying the current subprocess connection attempt. */
  get generation(): number {
    return this.kernelGeneration;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.isIntentionalDisconnect = false;
    this.clearReconnectTimer();
    resetDropWarnings();
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
      // Before start(): a pipe that is already broken disposes off the first
      // readline event, and a hook fitted after that is attached to a transport
      // nobody is listening to any more.
      transport.onDisposed = (error) => this.handleTransportClose(transport, error);
      transport.start();

      // Initialize AcpRequestHandler (manages FS, terminal, permission handlers)
      requestHandler = new AcpRequestHandler({
        transport,
        vaultPath: cwd,
        onPermissionRequest: this.onPermissionRequest,
        onElicitationRequest: this.onElicitationRequest,
        vaultIo: this.vaultIo,
        onPermissionUnreadable: (summary, sessionId) => this.onPermissionUnreadable?.(summary, sessionId),
        // A wrapper, not the field: the view binds these handlers after the
        // connection exists, and a grant must reach whoever is listening then.
        onCapabilityGrant: (grant) => this.onCapabilityGrant?.(grant),
      });
      this.requestHandler = requestHandler;
      // Before `initialize`, not after: the capabilities we advertise have to be
      // the ones this client will actually honour, and a tier assigned to the
      // client earlier (main.ts, or a reconnect reusing it) lives here.
      this.syncCapabilityTier();

      const onSessionUpdate = (params: unknown): void => {
        // Drop updates from a transport that has since been replaced or disposed.
        if (this.transport !== transport) return;
        this.dispatchSessionUpdate(params);
      };
      // Exact-match dispatch: accept both the spec and legacy wire names.
      transport.onNotification('session/update', onSessionUpdate);
      transport.onNotification('sessionUpdate', onSessionUpdate);
      transport.onUnknownNotification = (method) => this.reportDrift(null, method);
      transport.onNotification('elicitation/complete', (params: unknown) => {
        // The agent answered its own pending elicitation (e.g. in another
        // client); retire the matching banner so it never sits there unclicked.
        if (this.transport !== transport) return;
        const p = params as Record<string, unknown> | undefined;
        const id = typeof p?.elicitationId === 'string' ? p.elicitationId : null;
        if (id) this.onElicitationComplete?.(id);
      });

      const response = await this.requestWithFallback('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'co-ober', version: CLIENT_VERSION },
        clientCapabilities: requestHandler.buildClientCapabilities(),
      });
      if (this.kernelGeneration !== generation) {
        throw new Error(t().acp.superseded);
      }
      const initResult = z
        .object({
          protocolVersion: z.number().optional(),
          agentCapabilities: z.unknown().optional(),
          authMethods: z.unknown().optional(),
        })
        .safeParse(response);
      if (initResult.success) {
        const negotiated = initResult.data.protocolVersion;
        this.agentProtocolVersion = typeof negotiated === 'number' ? negotiated : null;
        if (negotiated !== undefined && negotiated !== 1) {
          // A later-speaking agent still answers the v1 subset we implement;
          // failing the handshake over the number alone would make it unusable.
          // The user still has to hear it: parts of what this agent sends may
          // not be drawn.
          console.warn(`[co-ober] agent negotiated ACP protocolVersion ${negotiated}, client speaks v1`);
        }
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
      // ACP's handshake closes with the client acknowledging initialize.
      // Some agents gate every later request on receiving it; unknown
      // notifications are ignorable on the wire, so this is safe to send.
      transport.notify('notifications/initialized', {});
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
    const sid = parsed.data.sessionId;
    this.applySessionSnapshot(r as Record<string, unknown>, sid);
    this.loadedSessionIds.add(sid);
    this.sessionId_ = sid;
    return this.sessionId_;
  }

  async loadSession(
    id: string,
    cwd?: string,
    mcpServers: McpServerConfig[] = [],
    onReplayUpdate?: (u: NormalizedUpdate) => void,
  ): Promise<void> {
    return this.replayBoundedLoad(
      'loadSession',
      {
        sessionId: id,
        cwd: this.resolveCwd(cwd),
        mcpServers: buildMcpServers(mcpServers),
      },
      id,
      onReplayUpdate,
    );
  }

  /**
   * session/load and session/resume both stream a replay back, and a big
   * history stays alive far past the fixed per-request timeout. The deadline is
   * idle-based instead — every replay update refreshes it, so only a stalled
   * load ever expires, and a long tail of updates is never cut off mid-note.
   */
  private async replayBoundedLoad(
    logicalMethod: AcpLogicalMethod,
    params: Record<string, unknown>,
    id: string,
    onReplayUpdate?: (u: NormalizedUpdate) => void,
  ): Promise<void> {
    // A replay reset while this same session streams would wipe its
    // accumulated text — other sessions keep their own normalizer instances.
    if (!this.activeStreams.has(id)) this.normalizers.delete(id);
    const userReplay = onReplayUpdate ?? null;
    let touchReplayDeadline: () => void = () => {};
    this.replayHandler = (u) => {
      touchReplayDeadline();
      userReplay?.(u);
    };
    this.replaySessionId = id;
    let idleTimer: number | null = null;
    const loadAbort = new AbortController();
    const idleDeadline = new Promise<never>((_, reject) => {
      const arm = () => {
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(
          () => {
            // The timeout line humanizes to `did not answer "{method}"`, so it
            // must name the method that went on the wire. `logicalMethod` is a
            // client-internal label (loadSession/resumeSession); the request that
            // raced against this deadline went out as session/load (or the cached
            // candidate), and once requestWithFallback picks a candidate it caches
            // it. Quote the cached pick, else the primary candidate — the same
            // rule that site uses to choose what to send.
            const wireMethod = this.methodCache.get(logicalMethod) ?? getAcpMethodCandidates(logicalMethod)[0];
            reject(new AcpTimeoutError(wireMethod, ACP_LOAD_SESSION_IDLE_TIMEOUT_MS));
            // Rejecting the race does not end the request: with no timeout of
            // its own the load sits on the transport's pending map for the life
            // of the connection, so the user's retry of the same session answers
            // against a ghost request — and the ghost's late reply settles a
            // promise nobody is routing any more.
            loadAbort.abort();
          },
          ACP_LOAD_SESSION_IDLE_TIMEOUT_MS,
        );
      };
      touchReplayDeadline = arm;
      arm();
    });
    try {
      const r = await Promise.race([this.requestWithFallback(logicalMethod, params, 0, loadAbort.signal), idleDeadline]);
      this.applySessionSnapshot(r as Record<string, unknown>, id);
      this.loadedSessionIds.add(id);
      this.sessionId_ = id;
    } catch (e) {
      if (isSessionMissingError(e)) throw new AcpSessionMissingError(id, e);
      throw e;
    } finally {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      this.replayHandler = null;
      this.replaySessionId = null;
    }
  }

  async listSessions(cwd?: string): Promise<SessionMeta[]> {
    // session/list is cursor-paginated: agents with more than one page of
    // history would otherwise hide everything past the first limit.
    const collected: SessionMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ACP_LIST_SESSIONS_MAX_PAGES; page++) {
      const r = await this.requestWithFallback('listSessions', {
        cwd: this.resolveCwd(cwd),
        limit: ACP_LIST_SESSIONS_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      const parsed = z
        .object({
          sessions: z.array(z.looseObject({ sessionId: z.string() })).optional(),
          nextCursor: z.string().nullish().transform((c) => c ?? undefined),
        })
        .safeParse(r);
      if (!parsed.success) break;
      collected.push(...((parsed.data.sessions as SessionMeta[]) ?? []));
      const next = parsed.data.nextCursor;
      // A repeated cursor means the agent is not actually advancing; stop
      // rather than loop on the same page.
      if (!next || next === cursor) break;
      cursor = next;
    }
    return collected;
  }

  async forkSession(id: string, cwd?: string): Promise<string> {
    const r = await this.requestWithFallback('forkSession', { sessionId: id, cwd: this.resolveCwd(cwd) });
    const parsed = z.object({ sessionId: z.string() }).safeParse(r);
    if (!parsed.success) throw new Error(t().acp.invalidForkSessionId);
    return parsed.data.sessionId;
  }

  async resumeSession(id: string, cwd?: string, onReplayUpdate?: (u: NormalizedUpdate) => void): Promise<void> {
    // Resume replays too, wherever the agent supports it; judging that stream
    // by the fixed per-request timeout cut long histories off mid-replay while
    // still reporting a successful load.
    return this.replayBoundedLoad(
      'resumeSession',
      { sessionId: id, cwd: this.resolveCwd(cwd) },
      id,
      onReplayUpdate,
    );
  }

  async closeSession(id: string): Promise<void> {
    this.loadedSessionIds.delete(id);
    // The agent has dropped this session, so the commands, models and config
    // options it last reported for it are no longer true of anything.
    this.sessionMeta.delete(id);
    try {
      await this.requestWithFallback('closeSession', { sessionId: id });
    } catch (e) {
      console.warn(`[co-ober] failed to close session ${id}:`, e);
    }
  }

  async setMode(id: string, modeId: string): Promise<void> {
    // The agent's `current_mode_update` chunk (applySessionUpdate :1258)
    // is the only writer of meta.currentModeId; the RPC resolving means the
    // request was accepted, not that the change landed — painting `modeId`
    // here would be the 0.2.44 A "accepted ≠ landed" lie on the mode face.
    await this.requestWithFallback('setMode', { sessionId: id, modeId }).then(() => {});
  }

  async setModel(id: string, modelId: string): Promise<void> {
    // Same refusal as setMode above; the chunk path is the only writer.
    await this.requestWithFallback('setModel', { sessionId: id, modelId }).then(() => {});
  }

  // The spec's value is `anyOf`: a value id for a select, a real boolean for a
  // toggle. Sending `true` as the string "true" makes the agent reject it, and
  // a bare `true` still leaves a schema-strict agent guessing which branch of
  // the union it belongs to — so a boolean carries its `type` discriminator.
  async setConfigOption(id: string, configId: string, value: string | boolean): Promise<SessionConfigOption[]> {
    const params =
      typeof value === 'boolean'
        ? { sessionId: id, configId, value, type: 'boolean' }
        : { sessionId: id, configId, value };
    const r = await this.requestWithFallback('setConfigOption', params);
    // `z.array(z.any())` handed the raw frame straight to the toolbar, which
    // walks option lists: the same grouped or toggle-shaped element a
    // notification would have flattened arrived here unparsed.
    const configOptions = parseConfigOptions((r as { configOptions?: unknown } | undefined)?.configOptions) as SessionConfigOption[];
    this.applyConfigOptions(configOptions, id);
    return configOptions;
  }

  /**
   * Route one session/update notification frame: metadata applies to the
   * session the frame belongs to; chunk delivery targets that session's
   * active stream slot. Frames without a sessionId are only routed when
   * there is exactly one candidate target (streams + replay).
   */
  private dispatchSessionUpdate(params: unknown): void {
    const p = params as Record<string, unknown> | undefined;
    const sid = typeof p?.sessionId === 'string' ? p.sessionId : null;
    const update = this.parseUpdate(p?.update as Record<string, unknown> | undefined, (kind) => this.reportDrift(sid, kind));
    if (!update) return;
    this.fillTerminalContent(update);
    if (update.sessionUpdate === 'usage_update' && typeof process.env.DEBUG_CO_OBER !== 'undefined') {
      // Usage updates are frequent in long sessions; only log when debug is enabled.
      console.debug('[co-ober] usage_update:', JSON.stringify(update));
    }
    let target = sid;
    if (!target) {
      const candidates = this.noSidTargets();
      if (candidates.length > 1) {
        // Two sessions could own this frame; guessing would cross-wire them.
        if (!this.warnedAmbiguousNoSid) {
          this.warnedAmbiguousNoSid = true;
          console.warn('[co-ober] dropping session update without sessionId: several delivery targets are live');
        }
        this.reportDrift(this.sessionId_, 'session update without a sessionId');
        return;
      }
      target = candidates[0] ?? null;
    }
    // Client state (models, modes, commands, config) is per-session:
    // a side-chat or a background load must not clobber another session's slot.
    this.applySessionUpdate(update, target ?? this.sessionId_);
    const norms = this.normalizerFor(target ?? this.sessionId_).normalizeList(update);
    if (norms.length === 0) return;
    const entry = target ? this.activeStreams.get(target) : undefined;
    if (entry) {
      for (const norm of norms) entry.handler(norm);
      return;
    }
    if (this.replayHandler && (!sid || sid === this.replaySessionId)) {
      for (const norm of norms) this.replayHandler(norm);
      return;
    }
    // Normalized, and nothing left to draw it into: the turn had already given
    // up its slot — Stop removes it before the agent's last frames land. The
    // reader learns the answer arrived incomplete instead of meeting a gap
    // that looks like the model simply stopped talking.
    for (const norm of norms) {
      if (UNPLACED_UPDATE_KINDS.has(norm.kind)) this.reportDrift(sid ?? target, norm.kind);
    }
  }

  /** Sessions a frame without a sessionId could belong to. */
  private noSidTargets(): string[] {
    const targets = [...this.activeStreams.keys()];
    if (this.replaySessionId) targets.push(this.replaySessionId);
    return targets;
  }

  sendMessage(id: string, parts: PromptPart[], onChunk: (u: NormalizedUpdate) => void): Promise<AcpResponse> {
    if (this.activeStreams.has(id)) {
      return Promise.reject(new Error(t().acp.streamActive));
    }
    if (this.activeStreams.size >= MAX_CONCURRENT_STREAMS) {
      return Promise.reject(new AcpStreamCapacityError(MAX_CONCURRENT_STREAMS));
    }
    // Each session owns its normalizer; a new turn starts from clean
    // accumulation without touching any other session in flight.
    this.normalizers.delete(id);
    const stream = { handler: onChunk, abort: new AbortController() };
    this.activeStreams.set(id, stream);
    const signal = stream.abort.signal;

    // Use 0 timeout to disable transport-level timeout for streaming
    // The idle timeout in AgentRuntime handles cancellation
    const zAcpResponse = z.object({
      // stopReason must stay permissive: agents add new reasons ahead of the
      // schema, and rejecting the whole response would discard its usage too.
      // But a missing/malformed reason must not become a claim that the agent
      // said 'end_turn' — that was the 0.2.49 stage B laundering, minting a
      // completion the wire never reported. The field's own absence is the
      // honest reading; `surfaceStopReason` speaks it as "not reported"
      // (CoOberViewController.ts:2272), matching the sibling treatment at
      // `acpSchemas.ts:335`, which nullish-transforms the same field on
      // `state_update` rather than fabricating a value for it.
      stopReason: z.string().optional().catch(undefined),
      usage: z
        .object({
          totalTokens: z.number().catch(0),
          inputTokens: z.number().catch(0),
          outputTokens: z.number().catch(0),
          thoughtTokens: z.number().optional().catch(undefined),
          cachedReadTokens: z.number().optional().catch(undefined),
          cachedWriteTokens: z.number().optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
      _meta: z.record(z.string(), z.unknown()).nullish().transform((m) => m ?? undefined),
    });
    return this.requestWithFallback('prompt', { sessionId: id, prompt: parts.map(wirePromptPart) }, 0, signal)
      .then((res) => {
        // The transport answers `undefined` for a frame that carries the id but
        // no result, and `null` for one whose result is JSON null — both are an
        // agent that finished the turn and sent nothing with it. Parsing `res`
        // as it arrived handed those two to z.object, which rejects a non-object
        // outright, so a completed turn was reported as an invalid response and
        // its text thrown away. An empty object is the same answer, read the way
        // every other field here already degrades it.
        const parsed = zAcpResponse.safeParse(res ?? {});
        if (!parsed.success) {
          throw new Error(t().acp.invalidResponse);
        }
        return parsed.data;
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

    // session/cancel is a notification in ACP: awaiting a response held the
    // Stop button for the full timeout against agents that never answer it.
    // Unknown notification methods are ignorable per JSON-RPC, so both wire
    // aliases are sent — the agent acts on the one it knows.
    const transport = this.transport;
    if (!transport) return Promise.resolve();
    try {
      for (const candidate of getAcpMethodCandidates('cancel')) {
        transport.notify(candidate, { sessionId: id });
      }
    } catch (e) {
      console.warn('[co-ober] cancel notification failed:', e);
    }
    return Promise.resolve();
  }

  getAvailableAgents(): Promise<ModeOption[]> {
    return Promise.resolve([...this.metaFor(this.sessionId_).availableModes]);
  }
  getAvailableModels(): Promise<ModelOption[]> {
    return Promise.resolve([...this.metaFor(this.sessionId_).availableModels]);
  }
  getAvailableCommands(): Promise<AvailableCommand[]> {
    return Promise.resolve([...this.metaFor(this.sessionId_).availableCommands]);
  }
  getSessionInfo(): { sessionId?: string; title?: string; cwd?: string } | null {
    return this.metaFor(this.sessionId_).sessionInfo ?? null;
  }
  getSessionSnapshot(): SessionSnapshot {
    return this.snapshotOf(this.sessionId_);
  }
  getSessionSnapshotFor(sessionId: string): SessionSnapshot {
    return this.snapshotOf(sessionId);
  }
  /** Whether the agent was told this session is live on this connection. */
  isSessionLoaded(sessionId: string): boolean {
    return this.loadedSessionIds.has(sessionId);
  }
  activeStreamCount(): number {
    return this.activeStreams.size;
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
    this.onElicitationRequest = handlers.onElicitationRequest ?? undefined;
    this.onPermissionUnreadable = handlers.onPermissionUnreadable ?? undefined;
    this.onCapabilityGrant = handlers.onCapabilityGrant ?? undefined;
    this.onProtocolDrift = handlers.onProtocolDrift ?? undefined;
    this.onElicitationComplete = handlers.onElicitationComplete ?? undefined;
    if (this.requestHandler) {
      // Assigned straight through, guards included: a view that is being torn
      // down hands an empty handler set to let go of its own prompts, and a
      // guarded assignment left its banner and elicitation panel wired to an
      // agent that now answers to someone else.
      this.requestHandler.onPermissionRequest = handlers.onPermissionRequest;
      this.requestHandler.onElicitationRequest = handlers.onElicitationRequest;
      this.requestHandler.onPermissionUnreadable = (summary, sessionId) => this.onPermissionUnreadable?.(summary, sessionId);
      this.requestHandler.onCapabilityGrant = (grant) => this.onCapabilityGrant?.(grant);
    }
  }

  setFsCapabilityMode(mode: import('../types').FsCapabilityMode, maxBytes?: number): void {
    this.capabilityTier.fs = mode;
    if (maxBytes !== undefined) this.capabilityTier.fsMaxBytes = maxBytes;
    this.requestHandler?.setFsCapabilityMode(mode, maxBytes);
  }

  setTerminalCapabilityMode(
    mode: import('../types').TerminalCapabilityMode,
    timeoutMs?: number,
    maxOutputBytes?: number,
  ): void {
    this.capabilityTier.terminal = mode;
    if (timeoutMs !== undefined) this.capabilityTier.terminalTimeoutMs = timeoutMs;
    if (maxOutputBytes !== undefined) this.capabilityTier.terminalMaxOutputBytes = maxOutputBytes;
    this.requestHandler?.setTerminalCapabilityMode(mode, timeoutMs, maxOutputBytes);
  }

  // ── Private ──

  private resolveCwd(cwd?: string): string {
    return cwd ?? this.cwd ?? process.cwd();
  }

  /** Metadata slot for one session (null = the pre-session slot); created on first read. */
  private metaFor(sid: string | null): AcpSessionMeta {
    let meta = this.sessionMeta.get(sid);
    if (!meta) {
      meta = {
        availableCommands: [{ name: 'compact', description: t().slash.compact }],
        availableModels: [],
        availableModes: [],
        configOptions: [],
        currentModelId: null,
        currentModeId: null,
      };
      this.sessionMeta.set(sid, meta);
    }
    return meta;
  }

  private snapshotOf(sid: string | null): SessionSnapshot {
    const meta = this.metaFor(sid);
    return {
      configOptions: [...meta.configOptions],
      availableCommands: [...meta.availableCommands],
      availableModels: [...meta.availableModels],
      availableModes: [...meta.availableModes],
      currentModelId: meta.currentModelId,
      currentModeId: meta.currentModeId,
    };
  }

  /** Per-session normalizer; idle entries are LRU-evicted past the cap. */
  private normalizerFor(sid: string | null): SessionUpdateNormalizer {
    if (sid === null) return new SessionUpdateNormalizer();
    let normalizer = this.normalizers.get(sid);
    if (normalizer) {
      this.normalizers.delete(sid);
      this.normalizers.set(sid, normalizer);
      return normalizer;
    }
    normalizer = new SessionUpdateNormalizer();
    this.normalizers.set(sid, normalizer);
    if (this.normalizers.size > MAX_SESSION_NORMALIZERS) {
      for (const idleSid of [...this.normalizers.keys()]) {
        if (this.normalizers.size <= MAX_SESSION_NORMALIZERS) break;
        if (this.activeStreams.has(idleSid) || idleSid === this.replaySessionId) continue;
        this.normalizers.delete(idleSid);
      }
    }
    return normalizer;
  }

  private applySessionSnapshot(result: Record<string, unknown>, sid: string): void {
    const snapshot = extractSessionSnapshot(result);
    const meta = this.metaFor(sid);
    meta.availableCommands = snapshot.availableCommands;
    meta.availableModels = snapshot.availableModels;
    meta.availableModes = snapshot.availableModes;
    meta.configOptions = snapshot.configOptions;
    meta.currentModelId = snapshot.currentModelId;
    meta.currentModeId = snapshot.currentModeId;
    meta.sessionInfo = snapshot.sessionInfo;
  }

  private applyConfigOptions(configOptions: SessionConfigOption[], sid: string | null): void {
    const meta = this.metaFor(sid);
    const extracted = extractConfigMeta(configOptions);
    meta.configOptions = extracted.configOptions;
    meta.currentModelId = extracted.currentModelId;
    meta.availableModels = extracted.availableModels;
    meta.currentModeId = extracted.currentModeId;
    meta.availableModes = extracted.availableModes;
  }

  private applySessionUpdate(update: SessionUpdate, sid: string | null): void {
    const meta = this.metaFor(sid);
    switch (update.sessionUpdate) {
      case 'config_option_update':
        this.applyConfigOptions(update.configOptions, sid);
        break;
      case 'available_commands_update':
        meta.availableCommands = mergeAvailableCommands(update.availableCommands);
        break;
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') {
          meta.currentModeId = update.currentModeId;
        }
        if (update.availableModes) {
          meta.availableModes = [...update.availableModes];
        }
        break;
      case 'current_model_update':
        if (typeof update.currentModelId === 'string') {
          meta.currentModelId = update.currentModelId;
        }
        if (update.availableModels) {
          meta.availableModels = [...update.availableModels];
        }
        break;
      case 'session_info_update':
        meta.sessionInfo = {
          ...meta.sessionInfo,
          ...(typeof update.sessionId === 'string' ? { sessionId: update.sessionId } : {}),
          ...(typeof update.title === 'string' ? { title: update.title } : {}),
          ...(typeof update.cwd === 'string' ? { cwd: update.cwd } : {}),
        };
        // v2-alpha may carry config options inside the session info frame.
        if (update.configOptions) this.applyConfigOptions(update.configOptions, sid);
        break;
    }
  }

  private parseUpdate(u: Record<string, unknown> | undefined | null, onDrop?: DropReporter): SessionUpdate | null {
    return parseSessionUpdate(u, onDrop);
  }

  /**
   * Read a hosted terminal into the text item the transcript can paint. The
   * agent only names the process; the bytes live here, in this client.
   */
  private fillTerminalContent(update: SessionUpdate): void {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    const items = update.content;
    if (!items?.some((item) => item.type === 'terminal')) return;
    const handler = this.requestHandler;
    if (!handler) return;
    update.content = items.map((item) =>
      item.type === 'terminal' ? terminalContentFrom(handler.readTerminal(item.terminalId)) : item,
    );
  }

  /**
   * A frame that never reaches the transcript is invisible protocol drift. The
   * console warns once per kind; the tab counts every one. A frame with no
   * session of its own is blamed on the session this client mainly serves,
   * which is the same attribution the rest of the client already uses.
   */
  private reportDrift(sid: string | null, kind: string): void {
    this.onProtocolDrift?.(sid ?? this.sessionId_, kind);
  }

  private async requestWithFallback(
    logicalMethod: AcpLogicalMethod,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // The transport field only exists between connect() and disposeConnection().
    // A null here means there is no live connection at all — often no OpenCode
    // process — which is not the per-process I/O condition stdinNotWritable
    // describes (that claim is honest only at its spawn-time site, where the
    // child's stdin really is null). Report the state the code actually holds.
    if (!this.transport) throw new Error(t().acp.disconnected);

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
    this.normalizers.clear();
    this.loadedSessionIds.clear();
    // Per-session metadata belongs to the agent this connection talked to;
    // keeping it made a reopened session look as if it still had the old turn's
    // commands, models and config options.
    this.sessionMeta.clear();
    this.warnedAmbiguousNoSid = false;
    // Nothing was negotiated any more: a later note must not quote the version
    // an agent answered with three connections ago.
    this.agentProtocolVersion = null;

    transport?.dispose(error);
    if (shutdownSubprocess) {
      await subprocess?.shutdown();
    }
  }

  /**
   * The JSON-RPC pipe stopped carrying messages while the agent process was
   * still alive: input closed, the stream errored, or a write hit EPIPE. Only
   * `onClose` of the subprocess was wired before, so a transport that died on
   * its own left `connected` true — Send stayed lit, the banner kept promising
   * an answer, and no reconnect was ever scheduled.
   */
  private handleTransportClose(transport: AcpJsonRpcTransport | null, error: Error): void {
    // Our own teardown clears this.transport before disposing, so a dispose the
    // client asked for is not a loss to report back to it.
    if (transport === null || this.transport !== transport) return;
    // A close that races the in-flight handshake belongs to that connect(): its
    // catch owns teardown.
    if (this.connectingGeneration !== null && !this.connected) return;

    console.error('[co-ober] JSON-RPC transport closed:', error);
    // The child goes with the pipe. A transport that cannot carry a message is a
    // connection that cannot answer, and leaving the agent running behind it
    // parks a process no one can talk to until the next reconnect gets there.
    void this.disposeConnection(error, true).then(this.announceClose, this.announceClose);
  }

  private handleSubprocessClose(subprocess: AcpSubprocess, error?: Error): void {
    if (this.subprocess !== subprocess) return;
    // A close that races the in-flight handshake belongs to that connect():
    // its catch owns teardown, and scheduling a reconnect behind it would
    // resurrect a subprocess whose launch just failed (ENOENT retry storms).
    if (this.connectingGeneration !== null && !this.connected) return;

    const stderrMsg = subprocess.getStderrSnapshot() || '';
    // A clean exit still needs a concrete cause: without the real code the
    // message says "unknown", and the last stderr lines are usually the only
    // clue to why the agent walked away mid-session.
    const exit = subprocess.exitInfo;
    const codeText = exit && exit.code !== null ? String(exit.code) : t().acp.unknownCode;
    const closeError = error ?? new Error(t().acp.processExited.replace('{code}', codeText));
    if (stderrMsg) {
      closeError.message = `${closeError.message}\nstderr: ${stderrMsg.slice(-STDERR_SNAPSHOT_CHARS)}`;
    }
    if (error) {
      console.error('[co-ober] process error:', error, 'stderr:', stderrMsg);
    } else {
      console.error('[co-ober] process exited. stderr:', stderrMsg);
    }

    // Teardown runs either way: a subprocess that refuses to die still left the
    // conversation. Reporting only success here left Send lit and no process
    // behind it, with no reconnect scheduled, because the rejection had nowhere
    // to go.
    void this.disposeConnection(closeError).then(this.announceClose, this.announceClose);
  }

  /**
   * One tail for both ways a connection ends — the process going away and the
   * pipe going away without it. They used to be separate copies of this, and
   * only the first was ever called, which is how a dead transport came to look
   * like a live one.
   */
  private readonly announceClose = (): void => {
    this.onClose?.();
    if (!this.isIntentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  };

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

/**
 * Copy a prompt part down to the fields the ACP content schema actually
 * carries. A part assembled upstream can hold a local label or an internal id
 * that has no wire home; sending it verbatim asked the agent to parse keys its
 * schema does not define, so the extra fields are dropped on the way out.
 */
export function wirePromptPart(part: PromptPart): PromptPart {
  const out: PromptPart = { type: part.type };
  if (typeof part.text === 'string') out.text = part.text;
  if (typeof part.mimeType === 'string') out.mimeType = part.mimeType;
  if (typeof part.data === 'string') out.data = part.data;
  if (typeof part.uri === 'string') out.uri = part.uri;
  if (typeof part.name === 'string') out.name = part.name;
  return out;
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
