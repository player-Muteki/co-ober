import type {
	NormalizedUpdate,
	PromptPart,
	SessionConfigOption,
	PermissionRequest,
	AvailableCommand,
	ModelOption,
	ModeOption,
	AcpResponse,
	SessionSnapshot,
	McpServerConfig,
	FsCapabilityMode,
	TerminalCapabilityMode,
} from '../types';
import type { OpencodeClient, ClientHandlers } from './index';
import type { AgentCapabilities } from '../types';
import type { SessionMeta } from '../types';
import { AcpClient } from './acp';
import { AcpTimeoutError } from './AcpErrors';

export class AgentRuntime implements OpencodeClient {
  permissionMode: import('../types').PermissionLevel = 'safe';
  idleTimeoutMs = 5 * 60 * 1000; // 5 minutes default

  constructor(private acp: AcpClient) {}

  isConnected(): boolean { return this.acp.isConnected(); }
  connect(): Promise<void> { return this.acp.connect(); }
  disconnect(): Promise<void> { return this.acp.disconnect(); }
  createSession(cwd?: string, mcpServers?: McpServerConfig[]): Promise<string> { return this.acp.createSession(cwd, mcpServers); }
  loadSession(id: string, cwd?: string, mcpServers?: McpServerConfig[]): Promise<void> { return this.acp.loadSession(id, cwd, mcpServers); }
  listSessions(cwd?: string): Promise<SessionMeta[]> { return this.acp.listSessions(cwd); }
  closeSession(id: string): Promise<void> { return this.acp.closeSession(id); }
  forkSession(id: string, cwd?: string): Promise<string> { return this.acp.forkSession(id, cwd); }
  resumeSession(id: string, cwd?: string): Promise<void> { return this.acp.resumeSession(id, cwd); }
  setMode(id: string, mode: string): Promise<void> { return this.acp.setMode(id, mode); }
  setModel(id: string, model: string): Promise<void> { return this.acp.setModel(id, model); }

  async setConfigOption(id: string, cid: string, val: string): Promise<SessionConfigOption[]> {
    return this.acp.setConfigOption(id, cid, val);
  }

  async sendMessage(id: string, parts: PromptPart[], handler: (u: NormalizedUpdate) => void): Promise<AcpResponse> {
    const timeoutMs = this.idleTimeoutMs;
    if (timeoutMs <= 0) {
      return this.acp.sendMessage(id, parts, handler);
    }
    return new Promise<AcpResponse>((resolve, reject) => {
      let timeout: number;

      const resetTimeout = () => {
        if (timeout) window.clearTimeout(timeout);
        timeout = window.setTimeout(() => {
          reject(new AcpTimeoutError('sendMessage', timeoutMs));
        }, timeoutMs);
      };

      resetTimeout();

      const heartbeatHandler = (u: NormalizedUpdate) => {
        resetTimeout();
        handler(u);
      };

      this.acp.sendMessage(id, parts, heartbeatHandler)
        .then((res) => {
          window.clearTimeout(timeout);
          resolve(res);
        })
        .catch((err: unknown) => {
          window.clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  setClientHandlers(handlers: ClientHandlers): void {
    this.acp.onClose = handlers.onClose ?? undefined;
    this.acp.onReconnect = handlers.onReconnect ?? undefined;
    this.acp.onPermissionRequest = handlers.onPermissionRequest ?? ((req) => this.requestPermission(req));
  }

  cancel(id: string): Promise<void> { return this.acp.cancel(id); }
  abort(): void { this.acp.abort(); }

  async requestPermission(req: PermissionRequest): Promise<string> {
    if (this.permissionMode === 'yolo') {
      const allowAlways = req.options.find((o) => o.kind === 'allow_always');
      if (allowAlways) return allowAlways.optionId;
      return req.options[0]?.optionId ?? 'allow_once';
    }

    if (this.permissionMode === 'plan') {
      if (['read', 'search'].includes(req.toolCall.kind)) {
        const allow = req.options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_once');
        if (allow) return allow.optionId;
      }
      const reject = req.options.find((o) => o.kind === 'reject_always' || o.kind === 'reject_once');
      if (reject) return reject.optionId;
      return req.options[0]?.optionId ?? 'reject_once';
    }

    const reject = req.options.find((o) => o.kind === 'reject_always' || o.kind === 'reject_once');
    return reject?.optionId ?? req.options[0]?.optionId ?? 'reject_once';
  }

  getAgentCapabilities(): AgentCapabilities | null { return this.acp.getAgentCapabilities(); }
  getAvailableAgents(): Promise<ModeOption[]> { return this.acp.getAvailableAgents(); }
  getAvailableModels(): Promise<ModelOption[]> { return this.acp.getAvailableModels(); }
  getAvailableCommands(): Promise<AvailableCommand[]> { return this.acp.getAvailableCommands(); }
  getSessionInfo(): { sessionId?: string; title?: string; cwd?: string } | null { return this.acp.getSessionInfo(); }
  getSessionSnapshot(): SessionSnapshot { return this.acp.getSessionSnapshot(); }
	getCurrentSessionId(): string | undefined { return this.acp.getCurrentSessionId(); }
	setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void { this.acp.setFsCapabilityMode(mode, maxBytes); }
	setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void {
		this.acp.setTerminalCapabilityMode(mode, timeoutMs, maxOutputBytes);
	}
}
