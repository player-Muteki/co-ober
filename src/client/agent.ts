import type {
  SessionUpdate,
  PromptPart,
  SessionConfigOption,
  PermissionRequest,
  AvailableCommand,
  ModelOption,
  ModeOption,
  AcpResponse,
} from '../types';
import type { OpencodeClient } from './index';
import type { SessionMeta } from '../types';
import { AcpClient } from './acp';

export class AgentRuntime implements OpencodeClient {
  permissionMode = 'yolo';

  constructor(private acp: AcpClient) {}

  isConnected(): boolean { return this.acp.isConnected(); }
  connect(): Promise<void> { return this.acp.connect(); }
  disconnect(): Promise<void> { return this.acp.disconnect(); }
  createSession(cwd?: string): Promise<string> { return this.acp.createSession(cwd); }
  loadSession(id: string, cwd?: string): Promise<void> { return this.acp.loadSession(id, cwd); }
  listSessions(cwd?: string): Promise<SessionMeta[]> { return this.acp.listSessions(cwd); }
  closeSession(id: string): Promise<void> { return this.acp.closeSession(id); }
  forkSession(id: string, cwd?: string): Promise<string> { return this.acp.forkSession(id, cwd); }
  resumeSession(id: string, cwd?: string): Promise<void> { return this.acp.resumeSession(id, cwd); }
  setMode(id: string, mode: string): Promise<void> { return this.acp.setMode(id, mode); }

  async setConfigOption(id: string, cid: string, val: string): Promise<SessionConfigOption[]> {
    return this.acp.setConfigOption(id, cid, val);
  }

  async sendMessage(id: string, parts: PromptPart[], handler: (u: SessionUpdate) => void): Promise<AcpResponse> {
    return this.acp.sendMessage(id, parts, handler) as Promise<AcpResponse>;
  }

  cancel(id: string): Promise<void> { return this.acp.cancel(id); }

  async requestPermission(req: PermissionRequest): Promise<string> {
    if (this.permissionMode === 'yolo') {
      if (['read', 'search', 'execute'].includes(req.toolCall.kind)) return 'always';
    }
    return this.acp.requestPermission(req);
  }

  getAvailableAgents(): Promise<ModeOption[]> { return this.acp.getAvailableAgents(); }
  getAvailableModels(): Promise<ModelOption[]> { return this.acp.getAvailableModels(); }
  getAvailableCommands(): Promise<AvailableCommand[]> { return this.acp.getAvailableCommands(); }
  getCurrentSessionId(): string | undefined { return this.acp.getCurrentSessionId(); }
}
