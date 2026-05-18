import type {
  SessionId,
  SessionConfigOption,
  ModelOption,
  ModeOption,
  AvailableCommand,
  PermissionRequest,
  SessionUpdate,
  PromptPart,
  AcpResponse,
  SessionMeta,
} from '../types';

export interface OpencodeClient {
  isConnected(): boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  createSession(cwd?: string): Promise<SessionId>;
  loadSession(sessionId: SessionId, cwd?: string): Promise<void>;
  listSessions(cwd?: string): Promise<SessionMeta[]>;
  closeSession(sessionId: SessionId): Promise<void>;
  forkSession(sessionId: SessionId, cwd?: string): Promise<SessionId>;
  resumeSession(sessionId: SessionId, cwd?: string): Promise<void>;

  setMode(sessionId: SessionId, modeId: string): Promise<void>;
  setConfigOption(sessionId: SessionId, configId: string, value: string): Promise<SessionConfigOption[]>;

  sendMessage(sessionId: SessionId, parts: PromptPart[], onChunk: (chunk: SessionUpdate) => void): Promise<AcpResponse>;
  cancel(sessionId: SessionId): Promise<void>;

  requestPermission(req: PermissionRequest): Promise<string>;
  permissionMode: string;

  getAvailableAgents(): Promise<ModeOption[]>;
  getAvailableModels(): Promise<ModelOption[]>;
  getAvailableCommands(): Promise<AvailableCommand[]>;
  getCurrentSessionId(): SessionId | undefined;
}
