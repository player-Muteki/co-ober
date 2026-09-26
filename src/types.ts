export type SessionId = string;
export type ToolCallId = string;
export type MessageId = string;

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  /** Line-count summary from the OpenCode native database, when available. */
  additions?: number;
  deletions?: number;
  files?: number;
  /** Short excerpt around a text-part match from the native session search. */
  snippet?: string;
  /** OpenCode agent that ran the session (native v1 database only). */
  agent?: string;
  /** Model id the session last ran on (native v1 database only). */
  model?: string;
  /** Local sessions only: pinned conversations sort to the top of the dropdown. */
  pinned?: boolean;
}

export interface PromptPart {
  type: 'text' | 'image' | 'audio' | 'resource_link' | 'resource';
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: { text?: string; blob?: string; uri?: string; mimeType?: string };
}

export interface SessionConfigOption {
  // Consumers look options up by id ('model', 'effort', 'mode') and ignore
  // the rest, so unknown ids/categories parse instead of failing the frame.
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

export interface ModelOption {
  modelId: string;
  name: string;
}

export interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface AvailableCommand {
  name: string;
  description: string;
  /**
   * What the agent expects after the command name, folded in from the wire's
   * `input.hint`. The slash menu shows it under the command.
   */
  argumentHint?: string;
  /** Wire spelling of the hint; read once when the command list is merged. */
  input?: { hint?: string } | null;
}

export interface SessionSnapshot {
  configOptions: SessionConfigOption[];
  availableCommands: AvailableCommand[];
  availableModels: ModelOption[];
  availableModes: ModeOption[];
  currentModelId: string | null;
  currentModeId: string | null;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    close?: boolean;
    fork?: boolean;
    list?: boolean;
    resume?: boolean;
  };
  promptCapabilities?: {
    audio?: boolean;
    embeddedContext?: boolean;
    image?: boolean;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
}

export interface PermissionOption {
  optionId: string;
  // Agents mint custom kinds beyond the four spec values; consumers compare
  // against the known kinds and treat anything else as "no preference".
  kind: string;
  name: string;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    status: string;
    title: string;
    rawInput: Record<string, unknown>;
    kind: ToolKind;
    locations: { path: string }[];
  };
  options: PermissionOption[];
}

/**
 * What the user made of a permission request: an offered option's id, or null
 * when nobody answered it. `null` travels on the wire as `cancelled`, which is
 * not the same claim as a refusal — walking away from a prompt is not pressing
 * its reject button.
 */
export type PermissionDecision = string | null;

/**
 * A privilege this client granted the agent on its own side of the wire: the
 * agent asked Co-Ober to write a file or run a command, and Co-Ober did it
 * without the user being asked. `detail` names what was touched.
 */
export interface CapabilityGrant {
  sessionId?: string;
  kind: 'file-write' | 'terminal';
  detail: string;
}

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'apply_patch' | 'other';

/** One primitive property of an elicitation's `requestedSchema`. */
export interface ElicitationField {
  key: string;
  label: string;
  description?: string;
  kind: 'text' | 'number' | 'boolean' | 'enum';
  required: boolean;
  /** Choices of an enum field, in the order the agent offered them. */
  values?: { value: string; label: string }[];
}

/**
 * A question the agent asks mid-turn. `fields` holds what this client can put
 * an input against; `omittedFields` names what it cannot, so the reader learns
 * the answer will be partial instead of discovering it from the agent.
 */
export interface ElicitationRequest {
  sessionId: string;
  elicitationId: string;
  message: string;
  fields: ElicitationField[];
  omittedFields: string[];
  /** url mode: the answering happens on the page this link points at. */
  url?: string;
}

export type ElicitationAnswer =
  | { action: 'accept'; content: Record<string, string | number | boolean> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type ToolCallContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'content'; content: { type: 'image'; mimeType: string; data: string } }
  | { type: 'diff'; path: string; oldText?: string; newText?: string }
  | { type: 'terminal'; terminalId: string }
  /** An item whose shape this client cannot render; `originalType` is the wire tag. */
  | { type: 'unsupported'; originalType: string };

/**
 * Content payload of a streamed message chunk. Only `text` chunks are
 * accumulated into the transcript; image/audio/resource payloads keep their
 * fields optional so unknown content shapes parse instead of dropping the frame.
 */
export type ChunkContent = { type: string; text?: string; mimeType?: string; data?: string };

export type SessionUpdate =
  // `messageId` is an unstable, optional ACP field: the SDK requires only
  // `content`, so a chunk without an id is a frame we must still draw.
  | { sessionUpdate: 'agent_message_chunk'; messageId?: string; content: ChunkContent }
  | { sessionUpdate: 'agent_thought_chunk'; messageId?: string; content: ChunkContent }
  | { sessionUpdate: 'user_message_chunk'; messageId?: string; content: ChunkContent }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; name?: string; kind?: ToolKind; status?: string; rawInput?: Record<string, unknown>; locations?: { path: string }[]; content?: ToolCallContent[] }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status?: string; kind?: ToolKind; title?: string; name?: string; locations?: { path: string }[]; rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>; content?: ToolCallContent[] }
  | { sessionUpdate: 'plan'; entries: { content: string; status: string; priority: string }[] }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId?: string; availableModes?: ModeOption[] }
  | { sessionUpdate: 'current_model_update'; currentModelId?: string; availableModels?: ModelOption[] }
  | { sessionUpdate: 'session_info_update'; sessionId?: string; title?: string; cwd?: string; configOptions?: SessionConfigOption[] }
  | { sessionUpdate: 'usage_update'; used?: number; size?: number; totalTokens?: number; inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cost?: { amount: number; currency: string } }
  // Extension updates not in the v1 contract yet (notice RFD #2004,
  // compaction RFD #2002): parsed permissively so they render instead of dropping.
  // The official v2-alpha spellings (`notice{severity,title,description}`,
  // compaction frames keyed by compactionId) are coerced onto these internal shapes.
  | { sessionUpdate: 'notice_update'; level: string; message: string }
  | { sessionUpdate: 'compaction_update'; compactionId?: string; status?: string; summary?: string; error?: string }
  | { sessionUpdate: 'state_update'; state: string; stopReason?: string; usage?: Record<string, unknown> };

export type NormalizedUpdate =
  | { kind: 'message_chunk'; role: 'user' | 'agent' | 'thought'; messageId: string; chunkText: string; accumulatedText: string; content?: ChunkContent }
  | { kind: 'tool_call_snapshot'; toolCallId: string; title: string; toolName?: string; toolKind: ToolKind; status: 'pending' | 'in_progress' | 'completed' | 'failed'; rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>; locations?: { path: string }[]; contents: ToolCallContent[] }
  | { kind: 'plan'; entries: { content: string; status: string; priority: string }[] }
  | { kind: 'commands'; commands: AvailableCommand[] }
  | { kind: 'mode'; currentModeId: string | null; availableModes: ModeOption[] }
  | { kind: 'model'; currentModelId: string | null; availableModels: ModelOption[] }
  | { kind: 'config_options'; configOptions: SessionConfigOption[] }
  | { kind: 'session_info'; sessionId?: string; title?: string; cwd?: string }
  | { kind: 'usage'; totalTokens?: number; inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cost?: { amount: number; currency: string }; used?: number; size?: number }
  | { kind: 'notice'; level: string; message: string }
  | { kind: 'compaction'; summary?: string };

export interface AcpResponse {
  // Agents mint new stop reasons ahead of the ACP enum; the client parses any
  // string and handles the known ones (end_turn, max_tokens, max_turn_requests,
  // tool_calls, interrupted, refusal, cancelled), badging unknown ones verbatim.
  stopReason: string;
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  };
  _meta?: Record<string, unknown>;
}

export type PermissionLevel = 'yolo' | 'plan' | 'safe' | 'readonly';
export type FsCapabilityMode = 'enabled' | 'readonly' | 'disabled';
export type TerminalCapabilityMode = 'enabled' | 'disabled';

export interface ContextRef {
  id: string;
  type: 'note' | 'file';
  name: string;
  path: string;
  content?: string;
}

export interface SyncRule {
  id: string;
  enabled: boolean;
  toolName: string;
  pathPattern?: string;
  folder: string;
  filenameTemplate: string;
  template?: string;
}

export interface McpServerEnvVar {
  name: string;
  value: string;
}

export type McpServerConfig =
  | { type: 'stdio'; id: string; enabled: boolean; name: string; command: string; args: string[]; env?: McpServerEnvVar[] }
  | { type: 'http'; id: string; enabled: boolean; name: string; url: string; headers?: { name: string; value: string }[] }
  | { type: 'sse'; id: string; enabled: boolean; name: string; url: string; headers?: { name: string; value: string }[] };

export interface CustomSkillDefinition {
  id: string;
  enabled: boolean;
  name: string;
  description: string;
  instructions: string;
}

export interface CustomAgentDefinition {
	id: string;
	enabled: boolean;
	name: string;
	description: string;
	instructions: string;
	skillIds: string[];
	modeId?: string;
	modelId?: string;
}

export interface TerminalCreateParams {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface TerminalOutputResult {
	output: string;
	/** ACP requires the flag even when nothing was trimmed away. */
	truncated?: boolean;
	exitStatus?: { exitCode: number | null; signal: string | null };
	error?: string;
}

export interface TerminalInstance {
	terminalId: string;
	command: string;
	args: string[];
	cwd: string;
	pid: number | null;
	status: 'running' | 'exited' | 'killed';
	output: string;
	/** Set once ring-trimming has discarded earlier output. */
	outputTruncated?: boolean;
	exitCode: number | null;
	signal: string | null;
	createdAt: number;
}

// === Structured Content Types (Phase 1) ===

export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'context_compacted' | 'subagent' | 'image';

/** A single block within an assistant message, rendered in order. */
export interface ContentBlock {
  type: ContentBlockType;
  /** Text content for text/thinking blocks */
  text?: string;
  /** MIME type + base64 payload for image blocks streamed by the agent */
  mimeType?: string;
  data?: string;
  /** References the tool call id for tool_use blocks */
  toolCallId?: string;
  /** Snapshot of the tool title, so restored history can re-render the call */
  toolTitle?: string;
  /** Snapshot of the tool kind, so restored history can re-render the call */
  toolKind?: string;
  /** Last known status of the tool call (updated when it completes or fails) */
  toolStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  /** Error message captured from the OpenCode native database on restore */
  toolError?: string;
  /** Duration in seconds (populated after completion for thinking blocks) */
  duration?: number;
  /** Sub-agent metadata for subagent blocks */
  subagentInfo?: SubagentInfo;
}

/** Structured info about a tool call for rendering purposes. */
export interface ToolCallInfo {
  name: string;
  input?: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

/** Sub-agent tracking info. */
export interface SubagentInfo {
  name: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
}

/** Image attachment metadata. */
export interface ImageAttachment {
  mimeType: string;
  data: string;
}

/** Diff line counts. */
export interface DiffStats {
  added: number;
  removed: number;
}

/** A single diff line. */
export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
}

/** A file-level diff with stats and lines. */
export interface FileDiff {
  path: string;
  stats: DiffStats;
  lines: DiffLine[];
}

export interface SerializedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type: 'text' | 'tool-call' | 'tool-result' | 'thinking';
  toolCallId?: string;
  timestamp: number;
  /** @since Phase 1 — structured content blocks for ordered rendering */
  contentBlocks?: ContentBlock[];
  /** Persistence-only marker set when text-only blocks were elided from the data.json copy. */
  blocksElided?: boolean;
  /** @since Phase 1 — total response duration in seconds */
  durationSeconds?: number;
  /** @since Phase 1 — whether this message was interrupted mid-generation */
  isInterrupt?: boolean;
  /** Image attachments sent with a user message (base64 payloads). */
  images?: ImageAttachment[];
  /** Per-message cost/token totals read from the OpenCode native database. */
  usage?: MessageUsage;
  /** Turn wall-clock throughput re-derived from the native database on reload. */
  turnStats?: TurnStats;
  /** OpenCode-native message id this replayed message was aggregated from, when known. */
  nativeMessageId?: string;
}

export interface MessageUsage {
  cost?: number;
  /** ISO currency the agent attached to cost; the native DB has none. */
  costCurrency?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Generated tokens and measured wall clock for one completed turn. */
export interface TurnStats {
  outputTokens: number;
  durationMs: number;
}

export interface SerializedSession {
  sessionId: string;
  title: string;
  opencodeSessionId?: string;
  messages: SerializedMessage[];
  createdAt: number;
  updatedAt: number;
  /** Keep this conversation at the top of the session dropdown. */
  pinned?: boolean;
}

export interface PluginData {
  /** Persisted schema version; absent means pre-0.1.34 data (version 0). */
  schemaVersion?: number;
  settings: CoOberSettings;
  sessions: SerializedSession[];
  activeSessionId: string | null;
  /** Tab shells (schema v2): which conversations were open side by side. */
  openTabs?: TabShell[];
  activeTabId?: string | null;
}

/**
 * One open tab as stored on disk. `tabId` is only a positional key — live tab
 * ids are minted by the controller, so restore re-keys them.
 */
export interface TabShell {
  tabId: string;
  sessionId: string | null;
  /** Unsent composer state. Absent means the box was empty. */
  draft?: StoredDraft;
}

/**
 * What the composer held when the app last closed. A note reference is stored
 * without its body — the text is re-read from the vault when the draft is sent.
 * Staged images are counted rather than stored: base64 would dwarf the
 * transcript in data.json, so the restore says what it left out.
 */
export interface StoredDraft {
  text: string;
  refs?: Array<Pick<ContextRef, 'id' | 'type' | 'name' | 'path'>>;
  manual?: string[];
  images?: number;
}

export interface CoOberSettings {
	opencodePath: string;
	defaultAgent: string;
	defaultModel: string;
	defaultEffort: string;
	permissionMode: PermissionLevel;
	defaultNoteFolder: string;
	systemPrompt: string;
	language: string;
	maxNoteSize: number;
	syncRules: SyncRule[];
	mcpServers: McpServerConfig[];
	customSkills: CustomSkillDefinition[];
	customAgents: CustomAgentDefinition[];
	activeCustomAgentId: string;
	commonModels: string[];
	autoConnect?: boolean;
	autoScrollEnabled?: boolean;
	maxSessionMessages?: number;
	sessionRetentionDays?: number;
	maxOpenTabs?: number;
	fsCapability?: FsCapabilityMode;
	terminalCapability?: TerminalCapabilityMode;
	terminalTimeoutMs?: number;
	terminalMaxOutputBytes?: number;
	idleTimeoutMs?: number;
}

export const DEFAULT_SETTINGS: CoOberSettings = {
	opencodePath: 'opencode',
	defaultAgent: 'build',
	defaultModel: '',
	defaultEffort: 'default',
	permissionMode: 'safe',
	defaultNoteFolder: 'opencode-sync',
	systemPrompt: '',
	language: 'en',
	maxNoteSize: 8000,
	syncRules: [
		{ id: 'edit', enabled: true, toolName: 'edit', folder: 'opencode-sync', filenameTemplate: '{{tool}}-{{date}}-{{shortId}}' },
		{ id: 'write', enabled: true, toolName: 'write', folder: 'opencode-sync', filenameTemplate: '{{tool}}-{{date}}-{{shortId}}' },
	],
	mcpServers: [],
	customSkills: [],
	customAgents: [],
	activeCustomAgentId: '',
	commonModels: [],
	// The view auto-connects on open when this is on; off shows the manual button.
	autoConnect: true,
	autoScrollEnabled: true,
	maxSessionMessages: 200,
	sessionRetentionDays: 30,
	maxOpenTabs: 6,
	fsCapability: 'enabled',
	terminalCapability: 'enabled',
	terminalTimeoutMs: 30000,
	terminalMaxOutputBytes: 100000,
	idleTimeoutMs: 300000,
};

/**
 * Unified usage / cost tracking info, consolidated from duplicates in
 * chatState.ts, toolbar.ts, and renderer.ts.
 */
export interface UsageInfo {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cost?: { amount: number; currency: string };
  contextWindow?: number;
  contextTokens?: number;
  percentage?: number;
  modelId?: string;
  elapsedMs?: number;
}

export const VIEW_TYPE = 'co-ober-view';
