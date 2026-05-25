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
  resource?: { text?: string; blob?: string; uri?: string };
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

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'content'; content: { type: 'image'; mimeType: string; data: string } }
  | { type: 'diff'; path: string; oldText: string; newText: string };

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

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  name: string;
  command: string;
  args: string[];
  env?: McpServerEnvVar[];
}

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

export interface SerializedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  type: 'text' | 'tool-call' | 'tool-result' | 'thinking';
  toolCallId?: string;
  timestamp: number;
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
  settings: CopsidianSettings;
  sessions: SerializedSession[];
  activeSessionId: string | null;
}

export interface CopsidianSettings {
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
}

export const DEFAULT_SETTINGS: CopsidianSettings = {
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
};

export const VIEW_TYPE = 'copsidian-view';
