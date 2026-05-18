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
  type: 'text' | 'image' | 'resource_link' | 'resource';
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

export interface PermissionOption {
  optionId: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once';
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

export type ToolKind = 'read' | 'edit' | 'execute' | 'fetch' | 'search' | 'other';

export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'agent_thought_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'tool_call'; toolCallId: string; title: string; kind: ToolKind; status: 'pending'; rawInput: Record<string, unknown>; locations: { path: string }[] }
  | { sessionUpdate: 'tool_call_update'; toolCallId: string; status: 'in_progress' | 'completed' | 'failed'; kind: ToolKind; title?: string; rawInput?: Record<string, unknown>; rawOutput?: Record<string, unknown>; content?: { type: string; content: { type: string; text?: string } }[] }
  | { sessionUpdate: 'plan'; entries: { content: string; status: string; priority: string }[] }
  | { sessionUpdate: 'user_message_chunk'; messageId: string; content: { type: string; text: string } }
  | { sessionUpdate: 'config_option_update'; configOptions: SessionConfigOption[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: 'usage_update'; used: number; size: number; cost?: { amount: number; currency: string } };

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

export interface CopsidianSettings {
  opencodePath: string;
  defaultAgent: string;
  defaultModel: string;
  defaultEffort: string;
  permissionMode: PermissionLevel;
  defaultNoteFolder: string;
  syncRules: SyncRule[];
}

export const DEFAULT_SETTINGS: CopsidianSettings = {
  opencodePath: 'opencode',
  defaultAgent: 'build',
  defaultModel: '',
  defaultEffort: 'default',
  permissionMode: 'yolo',
  defaultNoteFolder: 'opencode-sync',
  syncRules: [
    { id: 'edit', enabled: true, toolName: 'edit', folder: 'opencode-sync', filenameTemplate: '{{tool}}-{{date}}-{{shortId}}' },
    { id: 'write', enabled: true, toolName: 'write', folder: 'opencode-sync', filenameTemplate: '{{tool}}-{{date}}-{{shortId}}' },
  ],
};

export const VIEW_TYPE = 'copsidian-view';
