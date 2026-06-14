import type {
	PermissionRequest,
	PermissionOption,
	FsCapabilityMode,
	TerminalCapabilityMode,
	TerminalCreateParams,
} from '../types';
import type { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { FsDelegate } from './fsDelegate';
import { TerminalManager, TerminalError } from './terminalManager';

export interface AcpRequestHandlerOptions {
	transport: AcpJsonRpcTransport;
	vaultPath: string;
	onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
}

export class AcpRequestHandler {
	private fsDelegate: FsDelegate | null = null;
	private fsCapabilityMode: FsCapabilityMode = 'enabled';
	private terminalManager: TerminalManager | null = null;
	private terminalCapabilityMode: TerminalCapabilityMode = 'enabled';
	private transport: AcpJsonRpcTransport;
	private vaultPath: string;
	onPermissionRequest?: (req: PermissionRequest) => Promise<string>;

	constructor(options: AcpRequestHandlerOptions) {
		this.transport = options.transport;
		this.vaultPath = options.vaultPath;
		this.onPermissionRequest = options.onPermissionRequest;

		this.fsDelegate = new FsDelegate({
			vaultPath: this.vaultPath,
			maxBytes: 8000,
		});

		this.terminalManager = new TerminalManager({
			timeoutMs: 30000,
			maxOutputBytes: 100000,
		});

		this.registerHandlers();
	}

	private registerHandlers(): void {
		this.transport.onRequest('request_permission', (params) => {
			return this.handleServerRequestPermission(params as Record<string, unknown>);
		});

		this.transport.onRequest('fs/read_text_file', (params) => {
			return this.handleReadTextFile(params as Record<string, unknown>);
		});

		this.transport.onRequest('fs/write_text_file', (params) => {
			return this.handleWriteTextFile(params as Record<string, unknown>);
		});

		this.transport.onRequest('terminal/create', (params) => {
			return this.handleTerminalCreate(params as Record<string, unknown>);
		});
		this.transport.onRequest('terminal/output', (params) => {
			return this.handleTerminalOutput(params as Record<string, unknown>);
		});
		this.transport.onRequest('terminal/kill', (params) => {
			return this.handleTerminalKill(params as Record<string, unknown>);
		});
		this.transport.onRequest('terminal/release', (params) => {
			return this.handleTerminalRelease(params as Record<string, unknown>);
		});
		this.transport.onRequest('terminal/wait_for_exit', (params) => {
			return this.handleTerminalWaitForExit(params as Record<string, unknown>);
		});
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
		const req: PermissionRequest = {
			sessionId: params.sessionId as string,
			toolCall: params.toolCall as PermissionRequest['toolCall'],
			options: params.options as PermissionOption[],
		};

		const handler = this.onPermissionRequest ?? ((r: PermissionRequest) => this.requestPermission(r));
		return Promise.resolve(handler(req)).then((decision: string) => ({
			sessionId: params.sessionId,
			decision: { optionId: decision },
		})).catch((error: unknown) => {
			// Only fall back to reject if the custom handler threw (e.g. programming error).
			// The default handler never throws.
			console.error('[copsilot] permission request handler failed, falling back to reject:', error);
			return this.requestPermission(req).then((decision: string) => ({
				sessionId: params.sessionId,
				decision: { optionId: decision },
			}));
		});
	}

	private async requestPermission(req: PermissionRequest): Promise<string> {
		const reject = req.options.find((o) => o.kind === 'reject_once');
		return reject?.optionId ?? 'reject_once';
	}

	private handleReadTextFile(params: Record<string, unknown>): Promise<unknown> {
		if (this.fsCapabilityMode === 'disabled' || !this.fsDelegate) {
			return Promise.resolve({ content: '', error: 'File system access is disabled' });
		}

		const filePath = params.path as string;
		if (!filePath) {
			return Promise.resolve({ content: '', error: 'Missing required parameter: path' });
		}

		return Promise.resolve(this.fsDelegate.readTextFile(filePath));
	}

	private handleWriteTextFile(params: Record<string, unknown>): Promise<unknown> {
		if (this.fsCapabilityMode !== 'enabled' || !this.fsDelegate) {
			return Promise.resolve({ success: false, error: 'File system write access is disabled' });
		}

		const filePath = params.path as string;
		const content = params.content as string;

		if (!filePath) {
			return Promise.resolve({ success: false, error: 'Missing required parameter: path' });
		}

		if (content === undefined || content === null) {
			return Promise.resolve({ success: false, error: 'Missing required parameter: content' });
		}

		return Promise.resolve(this.fsDelegate.writeTextFile(filePath, content));
	}

	private handleTerminalCreate(params: Record<string, unknown>): Promise<unknown> {
		if (this.terminalCapabilityMode !== 'enabled' || !this.terminalManager) {
			return Promise.resolve({ error: 'Terminal access is disabled' });
		}

		const command = params.command as string;
		if (!command) {
			return Promise.resolve({ error: 'Missing required parameter: command' });
		}

		const createParams: TerminalCreateParams = {
			command,
			args: params.args as string[] | undefined,
			cwd: params.cwd as string | undefined,
			env: params.env as Record<string, string> | undefined,
		};

		try {
			const instance = this.terminalManager.create(createParams, this.vaultPath);
			return Promise.resolve({
				terminalId: instance.terminalId,
				pid: instance.pid,
			});
		} catch (e) {
			const message = e instanceof TerminalError ? e.message : `Failed to create terminal: ${e instanceof Error ? e.message : String(e)}`;
			return Promise.resolve({ error: message });
		}
	}

	private handleTerminalOutput(params: Record<string, unknown>): Promise<unknown> {
		if (!this.terminalManager) {
			return Promise.resolve({ error: 'Terminal manager not initialized' });
		}

		const terminalId = params.terminalId as string;
		if (!terminalId) {
			return Promise.resolve({ error: 'Missing required parameter: terminalId' });
		}

		const result = this.terminalManager.output(terminalId);
		return Promise.resolve(result);
	}

	private handleTerminalKill(params: Record<string, unknown>): Promise<unknown> {
		if (!this.terminalManager) {
			return Promise.resolve({ error: 'Terminal manager not initialized' });
		}

		const terminalId = params.terminalId as string;
		if (!terminalId) {
			return Promise.resolve({ error: 'Missing required parameter: terminalId' });
		}

		const success = this.terminalManager.kill(terminalId);
		return Promise.resolve({ success });
	}

	private handleTerminalRelease(params: Record<string, unknown>): Promise<unknown> {
		if (!this.terminalManager) {
			return Promise.resolve({ error: 'Terminal manager not initialized' });
		}

		const terminalId = params.terminalId as string;
		if (!terminalId) {
			return Promise.resolve({ error: 'Missing required parameter: terminalId' });
		}

		const success = this.terminalManager.release(terminalId);
		return Promise.resolve({ success });
	}

	private handleTerminalWaitForExit(params: Record<string, unknown>): Promise<unknown> {
		if (!this.terminalManager) {
			return Promise.resolve({ error: 'Terminal manager not initialized' });
		}

		const terminalId = params.terminalId as string;
		if (!terminalId) {
			return Promise.resolve({ error: 'Missing required parameter: terminalId' });
		}

		return this.terminalManager.waitForExit(terminalId).then((result) => result ?? { error: 'Terminal not found' });
	}
}
