export type SessionId = string;
export type ToolCallId = string;
export type MessageId = string;

export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
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
  id: 'model' | 'effort' | 'mode';
  name: string;
  category: 'model' | 'thought_level' | 'mode';
  type: 'select';
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
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
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

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'apply_patch' | 'other';

export type ToolCallContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'content'; content: { type: 'image'; mimeType: string; data: string } }
  | { type: 'diff'; path: string; oldText: string; newText: string }
  | { type: 'terminal'; terminalId: string };

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'user_message_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind?: ToolKind; status?: string; rawInput?: Record<string, unknown>; locations?: { path: string }[] }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; kind?: ToolKind; title?: string; locations?: { path: string }[]; rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>; content?: ToolCallContent[] }
  | { sessionUpdate: 'plan'; entries: { content: string; status: string; priority: string }[] }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId?: string; availableModes?: ModeOption[] }
  | { sessionUpdate: 'current_model_update'; currentModelId?: string; availableModels?: ModelOption[] }
  | { sessionUpdate: 'session_info_update'; sessionId?: string; title?: string; cwd?: string }
  | { sessionUpdate: 'usage_update'; used?: number; size?: number; totalTokens?: number; inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cost?: { amount: number; currency: string } };

export type NormalizedUpdate =
  | { kind: 'message_chunk'; role: 'user' | 'agent' | 'thought'; messageId: string; chunkText: string; accumulatedText: string }
  | { kind: 'tool_call_snapshot'; toolCallId: string; title: string; toolKind: ToolKind; status: 'pending' | 'in_progress' | 'completed' | 'failed'; rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>; locations?: { path: string }[]; contents: ToolCallContent[] }
  | { kind: 'plan'; entries: { content: string; status: string; priority: string }[] }
  | { kind: 'commands'; commands: AvailableCommand[] }
  | { kind: 'mode'; currentModeId: string | null; availableModes: ModeOption[] }
  | { kind: 'model'; currentModelId: string | null; availableModels: ModelOption[] }
  | { kind: 'config_options'; configOptions: SessionConfigOption[] }
  | { kind: 'session_info'; sessionId?: string; title?: string; cwd?: string }
  | { kind: 'usage'; totalTokens?: number; inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cost?: { amount: number; currency: string }; used?: number; size?: number };

export interface AcpResponse {
  stopReason: 'end_turn' | 'max_tokens' | 'tool_calls' | 'interrupted';
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

export type PermissionLevel = 'yolo' | 'plan' | 'safe';
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
	exitCode: number | null;
	signal: string | null;
	createdAt: number;
}

// === Structured Content Types (Phase 1) ===

export type ContentBlockType = 'text' | 'thinking' | 'tool_use' | 'context_compacted' | 'subagent';

/** A single block within an assistant message, rendered in order. */
export interface ContentBlock {
  type: ContentBlockType;
  /** Text content for text/thinking blocks */
  text?: string;
  /** References the tool call id for tool_use blocks */
  toolCallId?: string;
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
  /** @since Phase 1 — total response duration in seconds */
  durationSeconds?: number;
  /** @since Phase 1 — whether this message was interrupted mid-generation */
  isInterrupt?: boolean;
}

export interface SerializedSession {
  sessionId: string;
  title: string;
  opencodeSessionId?: string;
  messages: SerializedMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface PluginData {
  settings: CoOberSettings;
  sessions: SerializedSession[];
  activeSessionId: string | null;
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
	autoConnect: false,
	autoScrollEnabled: true,
	maxSessionMessages: 200,
	sessionRetentionDays: 30,
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
