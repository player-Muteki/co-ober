import type { NormalizedUpdate, ContextRef, PromptPart, SessionConfigOption, ModeOption, ModelOption, AcpResponse } from '../types';
import type CoOberPlugin from '../main';
import { t } from '../i18n/index';
import type { ChatRenderer } from './renderer';
import type { ChatInput } from '../chat/input';
import type { InputToolbar } from '../chat/toolbar';
import type { ContextMention } from '../context/mention';
import type { ContextResolver } from '../context/resolver';
import type { SyncEngine } from '../sync/engine';
import type { SessionStore } from '../chat/session';
import { ChatState } from '../chat/chatState';
import { StreamController } from '../chat/streamController';
import { buildCustomAgentPrompt, getValidActiveCustomAgent } from '../agents/custom';
import { filterCommonModelOptions } from './modelFilter';
import { applyDefaultSessionSettings } from './sessionDefaults';
import { Mutex } from '../utils/mutex';
import { getVaultPath } from '../utils/vault';
import type { WelcomeView } from './welcomeView';
import type { PermissionBanner } from './permissionBanner';
import type { InlineEditPanel } from './inlineEditPanel';
import { buildSystemPrompt } from '../context/injection';
import { AcpTimeoutError, AcpProcessExitError, AcpAbortError } from '../client/AcpErrors';
import { commandRegistry } from '../commands/registry';
import { parseSlashCommand } from '../commands/executor';
import { NOTECACHE_MAX_SIZE } from '../constants';

export interface ControllerCallbacks {
	onShowWelcome(connected: boolean): void;
	onHideWelcome(): void;
	onShowReconnectBtn(): void;
	onHideReconnectBtn(): void;
	onShowNewMessagesBtn(): void;
	onHideNewMessagesBtn(): void;
	onScrollToBottom(): void;
	onClearUI(): void;
	onRefreshLocale?(): void;
	onClearChips(): void;
	onClearPendingImageChips(): void;
	onAutoRefActiveFile(): void;
}

export interface ControllerDeps {
	renderer: ChatRenderer;
	input: ChatInput;
	toolbar: InputToolbar;
	inlineEditPanel: InlineEditPanel;
	permissionBanner: PermissionBanner;
	mention: ContextMention;
	resolver: ContextResolver;
	syncEngine: SyncEngine;
	sessionStore: SessionStore;
	welcomeView: WelcomeView;
	plugin: CoOberPlugin;
	updateContextMeter: (usage: import('../types').UsageInfo | null) => void;
}

export class CoOberViewController {
	private sessionMutex = new Mutex();
	readonly state = new ChatState();
	private streamCtrl!: StreamController;
	private busy = false;
	private sendStartTime = 0;
	private genId = 0;
	private promptQueue: Array<{ text: string; refs: ContextRef[] }> = [];

	constructor(
		private deps: ControllerDeps,
		private callbacks: ControllerCallbacks,
	) {
		this.streamCtrl = new StreamController({
			state: this.state,
			renderer: deps.renderer,
			syncEngine: deps.syncEngine,
			sessionStore: deps.sessionStore,
			getSessionId: () => this.state.sessionId,
			onConfigUpdate: (opts) => this.applyConfigOptions(opts),
			onModeUpdate: (modeId, modes) => this.applyModeUpdate(modeId, modes),
			onModelsUpdate: (modelId, models) => this.applyModelUpdate(modelId, models),
			onCommandsUpdate: (commands) => commandRegistry.updateAcpCommands(commands),
			onUsageUpdate: () => this.deps.updateContextMeter(this.state.usage),
			onSyncFailure: (message) => deps.renderer.addError(message),
		});

		// Register builtin slash commands
		this.registerBuiltinCommands();
	}

	private registerBuiltinCommands(): void {
		const registry = commandRegistry;
		const client = () => this.deps.plugin.getClient();
		const caps = () => client()?.getAgentCapabilities?.();

		registry.registerBuiltin({
			id: 'compact',
			trigger: 'compact',
			aliases: ['summarize'],
			title: 'Compact Session',
			description: t().slash.compact,
			category: 'session',
			source: 'builtin',
			run: async () => { await this.compactSession(); },
		});
		registry.registerBuiltin({
			id: 'new',
			trigger: 'new',
			title: 'New Session',
			description: t().slash.new,
			category: 'session',
			source: 'builtin',
			run: async () => { await this.createNewSession(); },
		});
		registry.registerBuiltin({
			id: 'clear',
			trigger: 'clear',
			title: 'Clear Screen',
			description: t().slash.clear,
			category: 'view',
			source: 'builtin',
			run: async () => {
				await this.cancelActiveGeneration();
				this.busy = false;
				++this.genId;
				this.noteContentCache.clear();
				this.cacheSessionId = null;
				this.state.clear();
				this.deps.renderer.clear();
				this.callbacks.onShowWelcome(true);
			},
		});
		registry.registerBuiltin({
			id: 'help',
			trigger: 'help',
			title: 'Help',
			description: t().slash.help,
			category: 'view',
			source: 'builtin',
			run: async () => {
				const cmds = registry.getAll();
				const helpText = cmds.map((c) =>
					`- **/${c.trigger}**${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.description}`
				).join('\n');
				this.deps.renderer.addUserMessage('/help');
				this.deps.renderer.addSystemMessage(`### Available Commands\n\n${helpText}`);
			},
		});
		registry.registerBuiltin({
			id: 'add-dir',
			trigger: 'add-dir',
			title: 'Add Context Directory',
			description: t().slash.addDir,
			argumentHint: '[path/to/directory]',
			category: 'session',
			source: 'builtin',
			enabled: () => client() !== null,
			run: async (args: string) => {
				const c = client();
				if (!c || !this.state.sessionId) return;
				const path = args.trim() || this.getVaultCwd();
				await this.sendTextToAgent(`/add-dir ${path}`);
			},
		});
		registry.registerBuiltin({
			id: 'resume',
			trigger: 'resume',
			title: 'Resume Session',
			description: t().slash.resume,
			category: 'session',
			source: 'builtin',
			enabled: () => caps()?.sessionCapabilities?.resume ?? false,
			run: async () => {
				// Handled by the session dropdown UI, not text input.
			},
		});
		registry.registerBuiltin({
			id: 'fork',
			trigger: 'fork',
			title: 'Fork Session',
			description: t().slash.fork,
			category: 'session',
			source: 'builtin',
			enabled: () => caps()?.sessionCapabilities?.fork ?? false,
			run: async () => {
				if (!this.state.sessionId) return;
				await this.forkSession(this.state.sessionId);
			},
		});
		registry.registerBuiltin({
			id: 'model',
			trigger: 'model',
			title: 'Switch Model',
			description: t().slash.model,
			argumentHint: '<model-id>',
			category: 'agent',
			source: 'builtin',
			enabled: () => client() !== null && this.state.sessionId !== null,
			run: async (args: string) => {
				const modelId = args.trim();
				if (!modelId) {
					this.deps.renderer.addSystemMessage(
						`Available models:\n${this.state.availableModels.map((m) => `- \`${m.modelId}\`: ${m.name}`).join('\n')}`
					);
					return;
				}
				const c = client();
				if (!c || !this.state.sessionId) return;
				await c.setModel(this.state.sessionId, modelId);
				this.deps.renderer.addSystemMessage(`Switched to model: \`${modelId}\``);
			},
		});
		registry.registerBuiltin({
			id: 'mode',
			trigger: 'mode',
			title: 'Switch Mode/Agent',
			description: t().slash.mode,
			argumentHint: '<mode-id>',
			category: 'agent',
			source: 'builtin',
			enabled: () => client() !== null && this.state.sessionId !== null,
			run: async (args: string) => {
				const modeId = args.trim();
				if (!modeId) {
					this.deps.renderer.addSystemMessage(
						`Available modes:\n${this.state.availableModes.map((m) => `- \`${m.id}\`: ${m.name}`).join('\n')}`
					);
					return;
				}
				const c = client();
				if (!c || !this.state.sessionId) return;
				await c.setMode(this.state.sessionId, modeId);
				this.deps.renderer.addSystemMessage(`Switched to mode: \`${modeId}\``);
			},
		});
	}

	getVaultCwd(): string {
		return getVaultPath(this.deps.plugin.app);
	}

	isBusy(): boolean {
		return this.busy;
	}

	getSessionId(): string | null {
		return this.state.sessionId;
	}

	getStreamCtrl(): StreamController {
		return this.streamCtrl;
	}

	dispose(): void {
		this.streamCtrl.dispose();
		this.noteContentCache.clear();
		this.cacheSessionId = null;
	}

	// ── Connection ──

	async ensureClientConnected(): Promise<boolean> {
		const existing = this.deps.plugin.getClient();
		if (existing?.isConnected()) {
			this.state.isConnected = true;
			this.bindClientHandlers();
			this.callbacks.onHideReconnectBtn();
			this.deps.welcomeView.updateStatus(true);
			await this.syncSavedSessionAndLoadToolbar();
			return true;
		}

		const connected = await this.deps.plugin.initClient();
		this.state.isConnected = connected;
		if (!connected) {
			this.handleDisconnect();
			return false;
		}

		this.bindClientHandlers();
		this.callbacks.onHideReconnectBtn();
		this.deps.welcomeView.updateStatus(true);
		await this.syncSavedSessionAndLoadToolbar();
		return true;
	}

	private async syncSavedSessionAndLoadToolbar(): Promise<void> {
		if (this.state.sessionId) {
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[co-ober] session sync on connect:', e);
			}
		}
		this.loadToolbarOptions();
	}

	bindClientHandlers(): void {
		const client = this.deps.plugin.getClient();
		if (!client) return;
		client.setClientHandlers({
			onClose: () => this.handleDisconnect(),
			onReconnect: async () => {
				this.bindClientHandlers();
				this.state.isConnected = true;
				this.deps.welcomeView.updateStatus(true);
				this.callbacks.onHideReconnectBtn();
				try {
					await this.syncRuntimeSession(this.state.sessionId);
				} catch (e) {
					console.error('[co-ober] session resync:', e);
				}
				this.loadToolbarOptions();
				if (this.busy) {
					++this.genId;
					this.busy = false;
					this.state.isStreaming = false;
					this.deps.input.setStreaming(false);
					this.deps.toolbar.setSending(false);
					this.deps.renderer.removeAssistantPlaceholder();
					this.deps.renderer.addError(t().error.reconnected);
				}
			},
			onPermissionRequest: async (req) => (
				client.permissionMode === 'safe'
					? this.deps.permissionBanner.show(req)
					: client.requestPermission(req)
			),
		});
	}

	handleDisconnect(): void {
		this.state.isConnected = false;
		this.deps.permissionBanner.dismiss();
		this.deps.renderer.removeAssistantPlaceholder();
		this.streamCtrl.reset();
		++this.genId;
		this.busy = false;
		this.state.isStreaming = false;
		this.state.usage = null;
		this.deps.updateContextMeter(null);
		this.state.lastError = null;
		this.state.needsAttention = false;
		this.deps.input.setStreaming(false);
		this.deps.toolbar.setSending(false);
		this.deps.welcomeView.updateStatus(false);
		this.callbacks.onShowReconnectBtn();
	}

	async reconnect(): Promise<void> {
		try {
			const connected = await this.deps.plugin.initClient();
			if (!connected) throw new Error(t().reconnect.failed);
			this.bindClientHandlers();
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[co-ober] session resync:', e);
			}
			this.loadToolbarOptions();
			this.state.isConnected = true;
			this.deps.welcomeView.updateStatus(true);
			this.callbacks.onHideReconnectBtn();
		} catch (e) {
			console.error('[co-ober] reconnect failed:', e);
			throw e;
		}
	}

	// ── Session lifecycle ──

	async syncRuntimeSession(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		return this.sessionMutex.runExclusive(async () => {
			const client = this.deps.plugin.getClient();
			if (!client) return;
			if (client.getCurrentSessionId() === sessionId) return;
			await client.loadSession(sessionId, this.getVaultCwd(), this.deps.plugin.settings.mcpServers);
		});
	}

	async cancelActiveGeneration(): Promise<void> {
		const client = this.deps.plugin.getClient();
		if (!client || !this.busy || !this.state.sessionId) return;
		try {
			await client.cancel(this.state.sessionId);
		} catch (e) {
			console.error('[co-ober] cancel:', e);
		}
	}

	async compactSession(): Promise<void> {
		// Cancel any active generation, then send /compact through the ACP agent
		await this.cancelActiveGeneration();
		await this.sendTextToAgent('/compact');
	}

	async createNewSession(): Promise<void> {
		await this.newSession();
	}

	async newSession(): Promise<void> {
		await this.deps.sessionStore.save();
		const connected = await this.ensureClientConnected();
		if (!connected) return;
		const c = this.deps.plugin.getClient();
		if (!c) return;

		try {
			await this.cancelActiveGeneration();
			this.resetConversationView();
			await this.sessionMutex.runExclusive(async () => {
				const sid = await c.createSession(this.getVaultCwd(), this.deps.plugin.settings.mcpServers);
				this.state.sessionId = sid;
				await applyDefaultSessionSettings(c, sid, this.deps.plugin.settings);
			});
			if (this.state.sessionId) {
				this.deps.sessionStore.getOrCreate(this.state.sessionId);
				this.deps.sessionStore.setActive(this.state.sessionId);
			}
			await this.deps.sessionStore.save();
			this.loadToolbarOptions();
			this.callbacks.onShowWelcome(this.deps.plugin.getClient() !== null);
			this.callbacks.onAutoRefActiveFile();
		} catch (e) {
			console.error('[co-ober] newSession:', e);
		}
	}

	async restoreSession(): Promise<void> {
		if (!this.state.sessionId) return;
		const session = this.deps.sessionStore.get(this.state.sessionId);
		if (!session) return;
		let idx = 0;
		for (const msg of session.messages) {
			const restoreId = `restore-${msg.timestamp}-${idx++}`;
			if (msg.role === 'user') {
				this.deps.renderer.addUserMessage(msg.content, msg.timestamp);
			} else if (msg.role === 'assistant') {
				if (msg.type === 'thinking') this.deps.renderer.appendThinking(msg.content, restoreId, msg.timestamp);
				else this.deps.renderer.appendText(msg.content, restoreId, msg.timestamp);
			}
		}
	}

	async ensureRuntimeSession(): Promise<string | null> {
		if (!(await this.ensureClientConnected())) return null;
		const client = this.deps.plugin.getClient();
		if (!client) return null;

		if (this.state.sessionId) {
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[co-ober] session sync failed, creating new session:', e);
				this.state.sessionId = null;
			}
			this.loadToolbarOptions();
			if (this.state.sessionId) return this.state.sessionId;
		}

		try {
			await this.sessionMutex.runExclusive(async () => {
				const sid = await client.createSession(this.getVaultCwd(), this.deps.plugin.settings.mcpServers);
				this.state.sessionId = sid;
				await applyDefaultSessionSettings(client, sid, this.deps.plugin.settings);
			});
			if (this.state.sessionId) {
				this.deps.sessionStore.getOrCreate(this.state.sessionId);
				this.deps.sessionStore.setActive(this.state.sessionId);
			}
			await this.deps.sessionStore.save();
			this.loadToolbarOptions();
			return this.state.sessionId;
		} catch (e) {
			console.error('[co-ober] session init:', e);
			return null;
		}
	}

	// ── Session dropdown actions ──

	async switchSession(sessionId: string): Promise<void> {
		this.state.sessionId = sessionId;
		this.deps.sessionStore.getOrCreate(sessionId);
		await this.cancelActiveGeneration();
		this.callbacks.onClearUI();
		this.resetConversationView();
		try {
			await this.syncRuntimeSession(sessionId);
		} catch (e) {
			console.error('[co-ober] session switch sync:', e);
		}
		await this.restoreSession();
		this.deps.sessionStore.setActive(sessionId);
		await this.deps.sessionStore.save();
		this.loadToolbarOptions();
		this.callbacks.onShowWelcome(this.deps.plugin.getClient() !== null);
		this.callbacks.onAutoRefActiveFile();
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.deps.sessionStore.remove(sessionId);
		await this.deps.sessionStore.save();
		if (sessionId === this.state.sessionId) {
			await this.newSession();
		}
	}

	async forkSession(sessionId: string): Promise<void> {
		const client = this.deps.plugin.getClient();
		if (!client) return;
		const forkedId = await client.forkSession(sessionId, this.getVaultCwd());
		this.state.sessionId = forkedId;
		this.deps.sessionStore.getOrCreate(forkedId);
		this.deps.sessionStore.setActive(forkedId);
		await this.deps.sessionStore.save();
	}

	async resumeSession(sessionId: string): Promise<void> {
		const client = this.deps.plugin.getClient();
		if (!client) return;
		await client.resumeSession(sessionId, this.getVaultCwd());
		this.state.sessionId = sessionId;
		this.deps.sessionStore.getOrCreate(sessionId);
		this.deps.sessionStore.setActive(sessionId);
		await this.deps.sessionStore.save();
	}

	// ── Sending ──

	private async executeAgentCall(
		text: string,
		refs: ContextRef[],
		config: {
			addUserMessage?: boolean;
			saveMessage?: boolean;
			buildPartsWithRefs?: ContextRef[];
			onAfterResponse?: (response: AcpResponse | undefined) => Promise<void>;
			onFinally?: () => void;
			retryFn?: (text: string, refs?: ContextRef[]) => Promise<void>;
		},
	): Promise<void> {
		const sessionId = await this.ensureRuntimeSession();
		const c = this.deps.plugin.getClient();
		if (!c || !sessionId) return;

		const currentGen = ++this.genId;
		this.callbacks.onHideWelcome();

		this.busy = true;
		this.state.isStreaming = true;
		this.deps.input.setStreaming(true);
		this.deps.toolbar.setSending(true);
		this.sendStartTime = Date.now();
		if (config.addUserMessage !== false) this.deps.renderer.addUserMessage(text);
		if (config.saveMessage !== false) this.streamCtrl.saveMessage('user', text, 'text');
		this.deps.renderer.addAssistantPlaceholder();

		try {
			await this.syncRuntimeSession(sessionId);
			if (this.state.sessionId !== sessionId || !this.busy) return;
			const parts = config.buildPartsWithRefs
				? await this.buildParts(text, config.buildPartsWithRefs)
				: [{ type: 'text' as const, text }];
			if (this.state.sessionId !== sessionId || !this.busy) return;
			this.callbacks.onClearPendingImageChips();
			const response = await c.sendMessage(sessionId, parts, (ch: NormalizedUpdate) => {
				if (!this.busy || this.state.sessionId !== sessionId) return;
				this.streamCtrl.handleChunk(ch);
			});
			if (response?.usage) {
				this.state.usage = {
					totalTokens: response.usage.totalTokens ?? 0,
					inputTokens: response.usage.inputTokens ?? 0,
					outputTokens: response.usage.outputTokens ?? 0,
					thoughtTokens: response.usage.thoughtTokens,
					cost: this.state.usage?.cost,
					contextWindow: this.state.usage?.contextWindow,
					contextTokens: this.state.usage?.contextTokens,
				};
				this.deps.updateContextMeter(this.state.usage);
			}
			if (config.onAfterResponse) await config.onAfterResponse(response);
		} catch (e: unknown) {
			if (!this.state.isConnected) return;
			if (this.state.sessionId === sessionId) {
				if (e instanceof AcpAbortError) {
					// User cancelled, don't show error
				} else if (e instanceof AcpTimeoutError) {
					this.deps.renderer.addError(t().error.timeout, 'retry', () =>
						config.retryFn ? config.retryFn(text, refs) : undefined,
					);
				} else if (e instanceof AcpProcessExitError) {
					this.deps.renderer.addError(t().error.processExit, 'restart', async () => {
						await this.reconnect();
						if (config.retryFn) await config.retryFn(text, refs);
					});
				} else {
					this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
				}
			}
		} finally {
			this.deps.renderer.removeAssistantPlaceholder();
			if (this.genId === currentGen) {
				this.busy = false;
				this.state.isStreaming = false;
				this.deps.input.setStreaming(false);
				this.deps.toolbar.setSending(false);
				this.deps.input.focus();
				config.onFinally?.();
			}
		}
	}

	async send(text: string, refs: ContextRef[]): Promise<void> {
		if (this.busy) {
			this.promptQueue.push({ text, refs });
			return;
		}
		const parsed = parseSlashCommand(text);
		if (parsed) {
			const def = commandRegistry.find(parsed.name);
			if (def) {
				if (def.source === 'builtin') {
					this.deps.renderer.addUserMessage(text);
					this.streamCtrl.saveMessage('user', text, 'text');
					await def.run(parsed.args);
					return;
				}
				if (def.source === 'file' && def.template) {
					const { templateExpander } = await import('../commands/templateExpander');
					const expanded = templateExpander.buildPrompt(def, parsed.args);
					await this.sendTextToAgent(expanded, refs);
					return;
				}
			}
		}
		const inlineEdit = this.deps.inlineEditPanel.pendingState;
		if (inlineEdit) this.deps.inlineEditPanel.clearState();

		await this.executeAgentCall(text, refs, {
			buildPartsWithRefs: refs,
			retryFn: (t, r) => this.send(t, r ?? refs),
			onFinally: () => {
				if (this.state.usage) {
					this.deps.renderer.showUsage({
						...this.state.usage,
						modelId: this.state.currentModelId ?? undefined,
						elapsedMs: Date.now() - this.sendStartTime,
					});
				}
				if (inlineEdit && this.deps.inlineEditPanel.pendingState === inlineEdit) {
					const session = this.deps.sessionStore.get(this.state.sessionId ?? '');
					if (session) {
						const lastMsg = session.messages.slice().reverse().find(m => m.role === 'assistant');
						if (lastMsg) {
							this.deps.inlineEditPanel.showDiffFromResponse(inlineEdit.original, lastMsg.content);
						}
					}
					this.deps.inlineEditPanel.pendingState = null;
				}
				void this.drainQueue();
			},
		});
	}

	private async sendTextToAgent(text: string, refs?: ContextRef[]): Promise<void> {
		await this.executeAgentCall(text, refs ?? [], {
			addUserMessage: false,
			saveMessage: false,
			buildPartsWithRefs: refs && refs.length > 0 ? refs : undefined,
			retryFn: (t, r) => this.sendTextToAgent(t, r),
		});
	}

	private async drainQueue(): Promise<void> {
		while (this.promptQueue.length > 0 && !this.busy) {
			const next = this.promptQueue.shift()!;
			await this.send(next.text, next.refs);
		}
	}

	async stopGeneration(): Promise<void> {
		const c = this.deps.plugin.getClient();
		if (!c || !this.state.sessionId || (!this.busy && !this.state.isStreaming)) return;
		++this.genId;
		this.busy = false;
		this.state.isStreaming = false;
		this.deps.input.setStreaming(false);
		this.deps.toolbar.setSending(false);
		this.promptQueue.length = 0;
		try {
			await c.cancel(this.state.sessionId);
		} catch (e) {
			console.error('[co-ober] cancel:', e);
		}
	}

	/** Cache note content by path to avoid re-reading the same file. */
	private noteContentCache = new Map<string, { name: string; content: string }>();
	private cacheSessionId: string | null = null;

	private setCacheEntry(path: string, entry: { name: string; content: string }): void {
		if (this.noteContentCache.size >= NOTECACHE_MAX_SIZE) {
			const firstKey = this.noteContentCache.keys().next().value;
			if (firstKey !== undefined) this.noteContentCache.delete(firstKey);
		}
		this.noteContentCache.set(path, entry);
	}

	async buildParts(text: string, refs: ContextRef[]): Promise<PromptPart[]> {
		const parts: PromptPart[] = [];

		// Clear stale cache on session change
		if (this.cacheSessionId && this.cacheSessionId !== this.state.sessionId) {
			this.noteContentCache.clear();
		}
		this.cacheSessionId = this.state.sessionId;

		const resolved: Array<{ name: string; content: string }> = [];
		for (const ref of refs) {
			const cached = this.noteContentCache.get(ref.path);
			if (cached) {
				resolved.push(cached);
				continue;
			}
			const result = await this.deps.resolver.resolveNote(ref.path);
			if (result) {
				resolved.push(result);
				this.setCacheEntry(ref.path, result);
			}
		}
		const activeAgent = getValidActiveCustomAgent(
			this.deps.plugin.settings.activeCustomAgentId,
			this.deps.plugin.settings.customAgents,
			this.deps.plugin.settings.customSkills,
		);
		const customAgentPrompt = buildCustomAgentPrompt(activeAgent, this.deps.plugin.settings.customSkills);
		const customInstructions = [this.deps.plugin.settings.systemPrompt, customAgentPrompt].filter(Boolean).join('\n\n');
		const sysPrompt = buildSystemPrompt(customInstructions);
		const notesBlock = buildNotesBlock(resolved);
		const combined = [sysPrompt, notesBlock].filter(Boolean).join('\n\n');
		if (combined) parts.push({ type: 'text', text: combined });

		parts.push({ type: 'text', text });

		return parts;
	}

	copyLastAssistantMessage(): void {
		if (!this.state.sessionId) return;
		const session = this.deps.sessionStore.get(this.state.sessionId);
		if (!session) return;

		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i];
			if (msg.role === 'assistant' && msg.type !== 'thinking') {
				void navigator.clipboard.writeText(msg.content);
				break;
			}
		}
	}

	// ── Toolbar sync ──

	loadToolbarOptions(): void {
		const c = this.deps.plugin.getClient();
		if (!c) return;

		const snapshot = c.getSessionSnapshot();
		this.state.configOptions = snapshot.configOptions;
		this.state.availableCommands = snapshot.availableCommands;
		this.state.availableModels = snapshot.availableModels;
		this.state.availableModes = snapshot.availableModes;
		this.state.currentModeId = snapshot.currentModeId;

		const configMap = new Map(snapshot.configOptions.map(opt => [opt.id, opt]));
		const modeConfig = configMap.get('mode');
		const modelConfig = configMap.get('model');
		const effortConfig = configMap.get('effort');

		const agents = snapshot.availableModes.map(mode => ({ value: mode.id, label: mode.name }));
		const models = this.filterCommonModelOptions(snapshot.availableModels.map(model => ({ value: model.modelId, label: model.name })));
		const ef = t().toolbar.effort;
		const efforts = [
			{ value: 'default', label: ef.default },
			{ value: 'low', label: ef.low },
			{ value: 'medium', label: ef.medium },
			{ value: 'high', label: ef.high },
		];

		this.deps.toolbar.updateAgents(
			agents,
			snapshot.currentModeId ?? modeConfig?.currentValue ?? this.deps.plugin.settings.defaultAgent,
		);
		this.deps.toolbar.updateModels(
			models,
			snapshot.currentModelId ?? modelConfig?.currentValue ?? this.deps.plugin.settings.defaultModel,
		);
		this.state.currentModelId = snapshot.currentModelId ?? modelConfig?.currentValue ?? null;
		this.deps.toolbar.updateEffort(
			efforts,
			effortConfig?.currentValue ?? this.deps.plugin.settings.defaultEffort,
		);
		this.deps.toolbar.updatePermission(this.deps.plugin.settings.permissionMode);
	}

	applyConfigOptions(opts: SessionConfigOption[]): void {
		for (const opt of opts) {
			if (opt.id === 'model') {
				this.deps.toolbar.updateModels(
					this.filterCommonModelOptions(opt.options.map(o => ({ value: o.value, label: o.name }))),
					opt.currentValue,
				);
			}
			if (opt.id === 'effort') {
				this.deps.toolbar.updateEffort(
					opt.options.map(o => ({ value: o.value, label: o.name })),
					opt.currentValue,
				);
			}
			if (opt.id === 'mode') {
				this.deps.toolbar.updateAgents(
					opt.options.map(o => ({ value: o.value, label: o.name })),
					opt.currentValue,
				);
			}
		}
	}

	applyModeUpdate(modeId: string | null, modes: ModeOption[]): void {
		this.deps.toolbar.updateAgents(
			modes.map(m => ({ value: m.id, label: m.name })),
			modeId ?? undefined,
		);
	}

	applyModelUpdate(modelId: string | null, models: ModelOption[]): void {
		this.deps.toolbar.updateModels(
			this.filterCommonModelOptions(models.map(m => ({ value: m.modelId, label: m.name }))),
			modelId ?? undefined,
		);
	}

	filterCommonModelOptions(options: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
		return filterCommonModelOptions(options, this.deps.plugin.settings.commonModels, this.deps.plugin.settings.defaultModel);
	}

	// ── Reset ──

	resetConversationView(): void {
		this.deps.inlineEditPanel.clearState();
		this.deps.permissionBanner.dismiss();
		this.deps.welcomeView.hide();
		this.deps.renderer.clear();
		this.streamCtrl.reset();
		++this.genId;
		this.promptQueue = [];
		this.busy = false;
		this.state.isStreaming = false;
		this.state.usage = null;
		this.deps.updateContextMeter(null);
		this.state.lastError = null;
		this.state.needsAttention = false;
		this.deps.input.setStreaming(false);
		this.deps.toolbar.setSending(false);
		this.callbacks.onClearUI();
		this.callbacks.onClearChips();
		this.callbacks.onClearPendingImageChips();
	}

}

function buildNotesBlock(resolved: Array<{ name: string; content: string }>): string {
  if (resolved.length === 0) return '';
  const blocks = resolved.map(
    (r) => `=== NOTE: [[${r.name}]] ===\n${r.content}\n=== END NOTE ===`,
  );
  return (
    'The user has referenced the following Obsidian notes in their message.\n' +
    'You should consider their content as relevant context for your response:\n\n' +
    blocks.join('\n\n')
  );
}