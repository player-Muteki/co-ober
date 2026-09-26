import type {
	SessionId,
	SessionConfigOption,
	ModelOption,
	ModeOption,
	AvailableCommand,
	PermissionRequest,
	PermissionDecision,
	CapabilityGrant,
	ElicitationRequest,
	ElicitationAnswer,
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
  onReconnectFailed?: () => void;
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  /** Ask the user to answer an elicitation the agent posed; the answer goes back verbatim. */
  onElicitationRequest?: (req: ElicitationRequest) => Promise<ElicitationAnswer>;
  /**
   * Called when an inbound permission request fails schema validation and had to be
   * cancelled. The session id is whatever the frame still revealed, so the line can
   * land in the conversation the request belonged to rather than the tab on screen.
   */
  onPermissionUnreadable?: (summary: string, sessionId?: string) => void;
  /** This client let the agent write a file or run a command without asking anyone. */
  onCapabilityGrant?: (grant: CapabilityGrant) => void;
  /** An inbound update frame was dropped without being drawn; the conversation says so. */
  onProtocolDrift?: (sessionId: string | null, kind: string) => void;
  /** The agent reported an outstanding elicitation was resolved outside this client. */
  onElicitationComplete?: (elicitationId: string) => void;
}

export interface OpencodeClient {
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getAgentCapabilities(): AgentCapabilities | null;
  /** The protocol version the agent negotiated, when the handshake reported one. */
  getAgentProtocolVersion?(): number | null;

  createSession(cwd?: string, mcpServers?: McpServerConfig[]): Promise<SessionId>;
  loadSession(sessionId: SessionId, cwd?: string, mcpServers?: McpServerConfig[], onReplayUpdate?: (chunk: NormalizedUpdate) => void): Promise<void>;
  listSessions(cwd?: string): Promise<SessionMeta[]>;
  closeSession(sessionId: SessionId): Promise<void>;
  forkSession(sessionId: SessionId, cwd?: string): Promise<SessionId>;
  resumeSession(sessionId: SessionId, cwd?: string, onReplayUpdate?: (chunk: NormalizedUpdate) => void): Promise<void>;

  setMode(sessionId: SessionId, modeId: string): Promise<void>;
  setModel(sessionId: SessionId, modelId: string): Promise<void>;
  setConfigOption(sessionId: SessionId, configId: string, value: string | boolean): Promise<SessionConfigOption[]>;

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
	getSessionSnapshotFor(sessionId: SessionId): SessionSnapshot;
	getCurrentSessionId(): SessionId | undefined;
	isSessionLoaded(sessionId: SessionId): boolean;
	activeStreamCount(): number;
	setClientHandlers(handlers: ClientHandlers): void;
	setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void;
	setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void;
}
