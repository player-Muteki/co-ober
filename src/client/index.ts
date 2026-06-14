import type {
	SessionId,
	SessionConfigOption,
	ModelOption,
	ModeOption,
	AvailableCommand,
	PermissionRequest,
	PermissionLevel,
	NormalizedUpdate,
	PromptPart,
	AcpResponse,
	SessionMeta,
	SessionSnapshot,
	McpServerConfig,
	AgentCapabilities,
	FsCapabilityMode,
	TerminalCapabilityMode,
} from '../types';

export interface ClientHandlers {
  onClose?: () => void;
  onReconnect?: () => Promise<void>;
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
}

export interface OpencodeClient {
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAgentCapabilities(): AgentCapabilities | null;

  createSession(cwd?: string, mcpServers?: McpServerConfig[]): Promise<SessionId>;
  loadSession(sessionId: SessionId, cwd?: string, mcpServers?: McpServerConfig[]): Promise<void>;
  listSessions(cwd?: string): Promise<SessionMeta[]>;
  closeSession(sessionId: SessionId): Promise<void>;
  forkSession(sessionId: SessionId, cwd?: string): Promise<SessionId>;
  resumeSession(sessionId: SessionId, cwd?: string): Promise<void>;

  setMode(sessionId: SessionId, modeId: string): Promise<void>;
  setModel(sessionId: SessionId, modelId: string): Promise<void>;
  setConfigOption(sessionId: SessionId, configId: string, value: string): Promise<SessionConfigOption[]>;

  sendMessage(sessionId: SessionId, parts: PromptPart[], onChunk: (chunk: NormalizedUpdate) => void): Promise<AcpResponse>;
  cancel(sessionId: SessionId): Promise<void>;
  abort(): void;

  requestPermission?(req: PermissionRequest): Promise<string>;
  permissionMode: PermissionLevel;

  getAvailableAgents(): Promise<ModeOption[]>;
  getAvailableModels(): Promise<ModelOption[]>;
  getAvailableCommands(): Promise<AvailableCommand[]>;
  getSessionInfo(): { sessionId?: string; title?: string; cwd?: string } | null;
	getSessionSnapshot(): SessionSnapshot;
	getCurrentSessionId(): SessionId | undefined;
	setClientHandlers(handlers: ClientHandlers): void;
	setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void;
	setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void;
}
