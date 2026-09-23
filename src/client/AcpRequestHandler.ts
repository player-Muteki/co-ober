import type { PermissionRequest, FsCapabilityMode, TerminalCapabilityMode, TerminalCreateParams } from '../types';
import type { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { FsDelegate, type VaultWriteIo } from './fsDelegate';
import { TerminalManager, TerminalError } from './terminalManager';
import { z } from 'zod';
import { REQUEST_DEFAULT_TIMEOUT_MS, REQUEST_DEFAULT_MAX_OUTPUT_BYTES } from '../constants';
import { ACP_SERVER_REQUEST_ALIASES } from './AcpMethodNames';

const zPermissionParams = z
  .object({
    sessionId: z.string(),
    toolCall: z
      .object({
        toolCallId: z.string().optional(),
        title: z.string(),
        status: z.string().optional(),
        rawInput: z.record(z.string(), z.unknown()).optional(),
        kind: z
          .enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
          .optional(),
        locations: z.array(z.object({ path: z.string() })).optional(),
      })
      .passthrough(),
    options: z.array(
      z.object({
        optionId: z.string(),
        kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
        name: z.string(),
      }),
    ),
  })
  .passthrough();

const zFsPathParam = z.object({ path: z.string() });
const zFsWriteParam = z.object({ path: z.string(), content: z.string() });
const zTerminalIdParam = z.object({ terminalId: z.string() });
const zTerminalCreateParam = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export interface AcpRequestHandlerOptions {
  transport: AcpJsonRpcTransport;
  vaultPath: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
  vaultIo?: VaultWriteIo;
  onPermissionUnreadable?: (summary: string) => void;
}

export class AcpRequestHandler {
  private fsDelegate: FsDelegate | null = null;
  private fsCapabilityMode: FsCapabilityMode = 'enabled';
  private terminalManager: TerminalManager | null = null;
  private terminalCapabilityMode: TerminalCapabilityMode = 'enabled';
  private transport: AcpJsonRpcTransport;
  private vaultPath: string;
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
  onPermissionUnreadable?: (summary: string) => void;

  constructor(options: AcpRequestHandlerOptions) {
    this.transport = options.transport;
    this.vaultPath = options.vaultPath;
    this.onPermissionRequest = options.onPermissionRequest;
    this.onPermissionUnreadable = options.onPermissionUnreadable;

    this.fsDelegate = new FsDelegate({
      vaultPath: this.vaultPath,
      maxBytes: 8000,
      vaultIo: options.vaultIo,
    });

    this.terminalManager = new TerminalManager({
      timeoutMs: REQUEST_DEFAULT_TIMEOUT_MS,
      maxOutputBytes: REQUEST_DEFAULT_MAX_OUTPUT_BYTES,
    });

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Register every wire-name alias: dispatch in AcpJsonRpcTransport is
    // exact-match, and agents may send either the spec name
    // (session/request_permission) or the legacy bare name.
    this.registerServerRequest('requestPermission', (params) => {
      return this.handleServerRequestPermission(this.toRecord(params));
    });

    this.registerServerRequest('readTextFile', (params) => {
      return this.handleReadTextFile(this.toRecord(params));
    });

    this.registerServerRequest('writeTextFile', (params) => {
      return this.handleWriteTextFile(this.toRecord(params));
    });

    this.registerServerRequest('createTerminal', (params) => {
      return this.handleTerminalCreate(this.toRecord(params));
    });
    this.registerServerRequest('terminalOutput', (params) => {
      return this.handleTerminalOutput(this.toRecord(params));
    });
    this.registerServerRequest('killTerminal', (params) => {
      return this.handleTerminalKill(this.toRecord(params));
    });
    this.registerServerRequest('releaseTerminal', (params) => {
      return this.handleTerminalRelease(this.toRecord(params));
    });
    this.registerServerRequest('waitForTerminalExit', (params) => {
      return this.handleTerminalWaitForExit(this.toRecord(params));
    });
  }

  private registerServerRequest(
    logical: keyof typeof ACP_SERVER_REQUEST_ALIASES,
    handler: (params: unknown) => Promise<unknown>,
  ): void {
    for (const wireName of ACP_SERVER_REQUEST_ALIASES[logical]) {
      this.transport.onRequest(wireName, handler);
    }
  }

  private toRecord(params: unknown): Record<string, unknown> {
    const r = z.record(z.string(), z.unknown()).safeParse(params);
    return r.success ? r.data : {};
  }

  buildClientCapabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = {};
    if (this.fsCapabilityMode !== 'disabled') {
      caps.fs = {
        readTextFile: true,
        writeTextFile: this.fsCapabilityMode === 'enabled',
      };
    }
    if (this.terminalCapabilityMode === 'enabled') {
      caps.terminal = true;
    }
    return caps;
  }

  dispose(): void {
    this.terminalManager?.dispose();
    this.terminalManager = null;
    this.fsDelegate = null;
  }

  setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void {
    this.fsCapabilityMode = mode;
    if (this.fsDelegate && maxBytes !== undefined) {
      this.fsDelegate.setMaxBytes(maxBytes);
    }
  }

  setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void {
    this.terminalCapabilityMode = mode;
    if (this.terminalManager) {
      this.terminalManager.setConfig({ timeoutMs, maxOutputBytes });
    }
  }

  private handleServerRequestPermission = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = zPermissionParams.safeParse(params);
    if (!parsed.success) {
      // A malformed request must not pass silently: the agent proceeds either
      // way, so the user needs to know the prompt they never saw was cancelled.
      const summary = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')
        .slice(0, 240);
      console.error('[co-ober] unreadable permission request, cancelling it:', summary);
      this.onPermissionUnreadable?.(summary);
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const req: PermissionRequest = {
      sessionId: parsed.data.sessionId,
      toolCall: parsed.data.toolCall as PermissionRequest['toolCall'],
      options: parsed.data.options,
    };

    const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
    return Promise.resolve(handler(req))
      .then((decision: string) => ({
        outcome: { outcome: 'selected', optionId: decision },
      }))
      .catch((error: unknown) => {
        // Only fall back to reject if the custom handler threw (e.g. programming error).
        // The default handler never throws.
        console.error('[co-ober] permission request handler failed, falling back to reject:', error);
        return this.requestPermission(req).then((decision: string) => ({
          outcome: { outcome: 'selected', optionId: decision },
        }));
      });
  };

  private async requestPermission(req: PermissionRequest): Promise<string> {
    const reject = req.options.find((o) => o.kind === 'reject_once');
    return reject?.optionId ?? 'reject_once';
  }

  private handleReadTextFile(params: Record<string, unknown>): Promise<unknown> {
    if (this.fsCapabilityMode === 'disabled' || !this.fsDelegate) {
      return Promise.resolve({ content: '', error: 'File system access is disabled' });
    }

    const parsed = zFsPathParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ content: '', error: 'Missing required parameter: path' });
    }

    return Promise.resolve(this.fsDelegate.readTextFile(parsed.data.path));
  }

  private handleWriteTextFile(params: Record<string, unknown>): Promise<unknown> {
    if (this.fsCapabilityMode !== 'enabled' || !this.fsDelegate) {
      return Promise.resolve({ success: false, error: 'File system write access is disabled' });
    }

    const parsed = zFsWriteParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ success: false, error: 'Missing required parameter: path or content' });
    }

    return Promise.resolve(this.fsDelegate.writeTextFile(parsed.data.path, parsed.data.content));
  }

  private handleTerminalCreate(params: Record<string, unknown>): Promise<unknown> {
    if (this.terminalCapabilityMode !== 'enabled' || !this.terminalManager) {
      return Promise.resolve({ error: 'Terminal access is disabled' });
    }

    const parsed = zTerminalCreateParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: command' });
    }

    const createParams: TerminalCreateParams = {
      command: parsed.data.command,
      args: parsed.data.args,
      cwd: parsed.data.cwd,
      env: parsed.data.env,
    };

    try {
      const instance = this.terminalManager.create(createParams, this.vaultPath);
      return Promise.resolve({
        terminalId: instance.terminalId,
        pid: instance.pid,
      });
    } catch (e) {
      const message =
        e instanceof TerminalError
          ? e.message
          : `Failed to create terminal: ${e instanceof Error ? e.message : String(e)}`;
      return Promise.resolve({ error: message });
    }
  }

  private handleTerminalOutput(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve(this.terminalManager.output(parsed.data.terminalId));
  }

  private handleTerminalKill(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve({ success: this.terminalManager.kill(parsed.data.terminalId) });
  }

  private handleTerminalRelease(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return Promise.resolve({ success: this.terminalManager.release(parsed.data.terminalId) });
  }

  private handleTerminalWaitForExit(params: Record<string, unknown>): Promise<unknown> {
    if (!this.terminalManager) {
      return Promise.resolve({ error: 'Terminal manager not initialized' });
    }

    const parsed = zTerminalIdParam.safeParse(params);
    if (!parsed.success) {
      return Promise.resolve({ error: 'Missing required parameter: terminalId' });
    }

    return this.terminalManager
      .waitForExit(parsed.data.terminalId)
      .then((result) => result ?? { error: 'Terminal not found' });
  }
}
