import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type CopsidianPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { NormalizedUpdate, ContextRef, PromptPart } from '../types';
import { t } from '../i18n/index';
import { ChatRenderer } from './renderer';
import { ChatInput } from '../chat/input';
import { InputToolbar } from '../chat/toolbar';
import { ContextMention } from '../context/mention';
import { ContextResolver } from '../context/resolver';
import { ContextInjection } from '../context/injection';
import { SyncEngine } from '../sync/engine';
import { getVaultPath } from '../utils/vault';
import { createSessionStore } from '../chat/session';
import type { SessionStore } from '../chat/session';
import { ChatState } from '../chat/chatState';
import { StreamController } from '../chat/streamController';
import { parseSlashCommand, isBuiltInCommand } from '../commands/executor';
import { SessionDropdown } from './sessionDropdown';
import { Autocomplete } from './autocomplete';
import { buildCustomAgentPrompt, getValidActiveCustomAgent } from '../agents/custom';
import { filterCommonModelOptions } from './modelFilter';
import { applyDefaultSessionSettings } from './sessionDefaults';
import { Mutex } from '../utils/mutex';
import { DragDropManager } from './dragDropManager';
import { PermissionBanner } from './permissionBanner';
import { InlineEditPanel } from './inlineEditPanel';
import { WelcomeView } from './welcomeView';
import { KeybindingManager } from './keybindingManager';

interface MarkdownFileView {
	getViewType(): string;
	file?: TFile | null;
}

export class CopsidianView extends ItemView {
	private sessionMutex = new Mutex();
	private messagesEl!: HTMLDivElement;
	private contextChipsEl!: HTMLDivElement;
	private renderer!: ChatRenderer;
	private input!: ChatInput;
	private toolbar!: InputToolbar;
	private inputAreaEl!: HTMLDivElement;
	private sessionButtonEl!: HTMLButtonElement;
	private syncEngine!: SyncEngine;
	private mention!: ContextMention;
	private resolver!: ContextResolver;
	private sessionStore!: SessionStore;
	private state = new ChatState();
	private streamCtrl!: StreamController;
	private busy = false;
	private sessionDropdownMgr: SessionDropdown | null = null;
	private autocomplete: Autocomplete | null = null;
	private currentRefs: ContextRef[] = [];
	private manualRefs = new Set<string>();
	private reconnectBtn: HTMLButtonElement | null = null;
	private welcomeView!: WelcomeView;
	private newMessagesBtn: HTMLButtonElement | null = null;
	private keybindingMgr!: KeybindingManager;
	private dragDropManager!: DragDropManager;
	private permissionBanner!: PermissionBanner;
	private inlineEditPanel!: InlineEditPanel;
	private pendingImageParts: PromptPart[] = [];
	private lastAutoRefId: string | null = null;
	private sendStartTime = 0;
	private headerTitleEl: HTMLDivElement | null = null;
	private newSessionBtnEl: HTMLButtonElement | null = null;

	// Event listener references for cleanup on close
	private scrollHandler: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CopsidianPlugin,
	) { super(leaf); }

	private getVaultCwd(): string {
		return getVaultPath(this.plugin.app);
	}

	private resetConversationView(): void {
		if (this.inlineEditPanel) this.inlineEditPanel.clearState();
		this.closeAutocomplete();
		if (this.permissionBanner) this.permissionBanner.dismiss();
		if (this.welcomeView) this.welcomeView.hide();
		this.renderer.clear();
		this.streamCtrl.reset();
		this.busy = false;
		this.state.isStreaming = false;
		this.state.usage = null;
		this.state.lastError = null;
		this.state.needsAttention = false;
		this.input.setStreaming(false);
		this.toolbar.setSending(false);
		this.currentRefs = [];
		this.pendingImageParts = [];
		if (this.dragDropManager) this.dragDropManager.resetBytes();
		this.manualRefs.clear();
		this.lastAutoRefId = null;
		this.mention.clear();
		this.contextChipsEl.empty();
	}

	private async syncRuntimeSession(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		return this.sessionMutex.runExclusive(async () => {
			const client = this.plugin.getClient();
			if (!client) return;
			if (client.getCurrentSessionId() === sessionId) return;
			await client.loadSession(sessionId, this.getVaultCwd(), this.plugin.settings.mcpServers);
		});
	}

	private async cancelActiveGeneration(): Promise<void> {
		const client = this.plugin.getClient();
		if (!client || !this.busy || !this.state.sessionId) return;
		try {
			await client.cancel(this.state.sessionId);
		} catch (e) {
			console.error('[copsidian] cancel:', e);
		}
	}

	private bindClientHandlers(): void {
		const client = this.plugin.getClient();
		if (!client) return;
		client.setClientHandlers({
			onClose: () => this.handleDisconnect(),
			onReconnect: async () => {
				this.bindClientHandlers();
				this.state.isConnected = true;
				if (this.welcomeView) this.welcomeView.updateStatus(true);
				this.hideReconnectBtn();
				try {
					await this.syncRuntimeSession(this.state.sessionId);
				} catch (e) {
					console.error('[copsidian] session resync:', e);
				}
				this.loadToolbarOptions();
			},
			onPermissionRequest: async (req) => (
				client.permissionMode === 'safe'
					? this.permissionBanner.show(req)
					: client.requestPermission(req)
			),
		});
	}

	override getViewType(): string { return VIEW_TYPE; }
	override getDisplayText(): string { return t().appName; }
	override getIcon(): string { return 'terminal-square'; }

	override async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.addClass('copsidian-view');

		// Init core modules
		this.mention = new ContextMention(this.plugin.app.vault);
		this.resolver = new ContextResolver(this.plugin.app.vault, this.plugin.settings.maxNoteSize);
		this.syncEngine = new SyncEngine(this.plugin.app.vault, this.plugin.settings.syncRules);
		this.sessionStore = createSessionStore(this.plugin);
		await this.sessionStore.load();
		this.state.autoScrollEnabled = this.plugin.settings.autoScrollEnabled ?? true;

		// Session dropdown (initialized after sessionButtonEl is created below)
		this.sessionDropdownMgr = null; // will be set after header creation

		// Restore active session
		const savedId = this.plugin.activeSessionId;
		if (savedId) {
			const saved = this.sessionStore.get(savedId);
			if (saved) {
				this.state.sessionId = saved.opencodeSessionId ?? savedId;
				this.sessionStore.getOrCreate(this.state.sessionId);
				this.sessionStore.setActive(this.state.sessionId);
			}
		}

		// ── Header ──
		const header = el.createDiv({ cls: 'copsidian-header' });
		this.headerTitleEl = header.createDiv({ text: t().appName, cls: 'copsidian-header-title' });
		const actions = header.createDiv({ cls: 'copsidian-header-actions' });
		this.newSessionBtnEl = actions.createEl('button', { text: t().header.new, cls: 'mod-icon' });
		this.newSessionBtnEl.onclick = () => this.newSession();
		this.sessionButtonEl = actions.createEl('button', { text: '⋯', cls: 'mod-icon' });
		this.sessionButtonEl.onclick = () => this.toggleSessions();
		this.sessionDropdownMgr = new SessionDropdown(
			this.contentEl,
			this.sessionButtonEl,
			this.sessionStore,
			() => this.state.sessionId,
			{
				onSwitch: async (sessionId: string) => {
					this.state.sessionId = sessionId;
					this.sessionStore.getOrCreate(sessionId);
					this.closeSessionDropdown();
					await this.cancelActiveGeneration();
					this.resetConversationView();
					this.clearAutoRefs();
					try {
						await this.syncRuntimeSession(sessionId);
					} catch (e) {
						console.error('[copsidian] session switch sync:', e);
					}
					await this.restoreSession();
					this.sessionStore.setActive(sessionId);
					await this.sessionStore.save();
					this.loadToolbarOptions();
					if (this.messagesEl.children.length === 0) {
						this.welcomeView.show(this.plugin.getClient() !== null);
					}
					this.autoRefActiveFile();
				},
				onDelete: async (sessionId: string) => {
					this.sessionStore.remove(sessionId);
					await this.sessionStore.save();
					if (sessionId === this.state.sessionId) {
						await this.newSession();
					}
					this.closeSessionDropdown();
				},
				onNewSession: async () => this.newSession(),
				onFork: async (sessionId: string) => {
					const client = this.plugin.getClient();
					if (!client) return;
					const forkedId = await client.forkSession(sessionId, this.getVaultCwd());
					this.state.sessionId = forkedId;
					this.sessionStore.getOrCreate(forkedId);
					this.sessionStore.setActive(forkedId);
					await this.sessionStore.save();
					this.closeSessionDropdown();
				},
				onResume: async (sessionId: string) => {
					const client = this.plugin.getClient();
					if (!client) return;
					await client.resumeSession(sessionId, this.getVaultCwd());
					this.state.sessionId = sessionId;
					this.sessionStore.getOrCreate(sessionId);
					this.sessionStore.setActive(sessionId);
					await this.sessionStore.save();
					this.closeSessionDropdown();
				},
			},
			() => this.plugin.getClient()?.getAgentCapabilities() ?? null,
		);

		// ── Messages ──
		this.messagesEl = el.createDiv({ cls: 'copsidian-messages' });
		this.renderer = new ChatRenderer(this.messagesEl, this.plugin.app, () => this.state.autoScrollEnabled);

		this.permissionBanner = new PermissionBanner(this.messagesEl);
		this.inlineEditPanel = new InlineEditPanel(this.contentEl);
		this.welcomeView = new WelcomeView(this.messagesEl, () => this.plugin.getClient()?.getAgentCapabilities() ?? null);

		// ── Context chips ──
		this.contextChipsEl = el.createDiv({ cls: 'copsidian-context-chips' });

		// ── Input ──
		this.inputAreaEl = el.createDiv({ cls: 'copsidian-input-area' });
		this.input = new ChatInput(this.inputAreaEl, {
			onSend: (text: string) => this.send(text, this.currentRefs),
			onStop: () => this.stopGeneration(),
			onToggleMention: () => this.showAC('@'),
			onToggleSlash: () => this.showAC('/'),
			onAddRef: (ref: ContextRef) => this.addChip(ref, 'manual'),
			onRemoveRef: (id: string) => this.removeChip(id),
		});
		this.autocomplete = new Autocomplete(this.inputAreaEl, {
			onSelect: (value: string, mode: '@' | '/') => this.handleACSelect(value, mode),
		});

		// ── Toolbar (below input) ──
		const tbEl = el.createDiv({ cls: 'copsidian-toolbar' });
		this.toolbar = new InputToolbar(tbEl, {
			onAgentChange: (agent: string) => {
				const client = this.plugin.getClient();
				if (!this.state.sessionId || !client) return;
				void client.setMode(this.state.sessionId, agent).then(() => this.loadToolbarOptions()).catch(() => {});
			},
			onModelChange: (model: string) => {
				const client = this.plugin.getClient();
				if (!this.state.sessionId || !client) return;
				void client.setModel(this.state.sessionId, model).then(() => this.loadToolbarOptions()).catch(() => {});
			},
			onEffortChange: (effort: string) => {
				const client = this.plugin.getClient();
				if (!this.state.sessionId || !client) return;
				void client.setConfigOption(this.state.sessionId, 'effort', effort).then(() => this.loadToolbarOptions()).catch(() => {});
			},
			onSend: () => this.input.triggerSend(),
			onStop: () => this.input.triggerStop(),
		});

		// Init StreamController
		this.streamCtrl = new StreamController({
			state: this.state,
			renderer: this.renderer,
			syncEngine: this.syncEngine,
			sessionStore: this.sessionStore,
			getSessionId: () => this.state.sessionId,
			onConfigUpdate: (opts) => this.applyConfigOptions(opts),
			onModeUpdate: (modeId, modes) => this.applyModeUpdate(modeId, modes),
			onModelsUpdate: (modelId, models) => this.applyModelUpdate(modelId, models),
			onCommandsUpdate: (_cmds) => {},
			onSyncFailure: (message) => this.renderer.addError(message),
		});

		const connectedClient = this.plugin.getClient();
		this.state.isConnected = connectedClient?.isConnected() ?? false;
		if (this.state.isConnected) {
			this.bindClientHandlers();
			void this.syncRuntimeSession(this.state.sessionId).catch((e) => {
				console.error('[copsidian] session sync:', e);
			});
		} else if (this.plugin.settings.autoConnect) {
			void this.ensureClientConnected();
		}

		// Restore previous messages if any
		await this.restoreSession();

		// Load toolbar options when an ACP client is already available.
		this.loadToolbarOptions();

		// Show welcome page if no messages
		if (this.messagesEl.children.length === 0) {
			this.welcomeView.show(this.plugin.getClient() !== null);
		}

		// Auto-reference the currently active file
		this.autoRefActiveFile();

		// Track active file changes
		this.setupActiveFileTracking();

		// Register global keybindings
		this.keybindingMgr = new KeybindingManager(this.contentEl, {
			onNewSession: () => void this.newSession(),
			onClearScreen: () => void this.clearScreen(),
			onCopyLastMessage: () => this.copyLastAssistantMessage(),
		});
		this.keybindingMgr.register();

		// Setup smart auto-scroll
		this.setupSmartScroll();

		// Setup drag and drop
		this.dragDropManager = new DragDropManager(this.messagesEl, this.messagesEl, {
			onAddNoteRef: (ref) => this.addChip(ref, 'manual'),
			onAddImagePart: (data, mimeType, size, name) => {
				this.pendingImageParts.push({ type: 'image', mimeType, data });
				const chip = this.contextChipsEl.createDiv({
					cls: 'copsidian-chip',
					text: `🖼 ${name}`,
				});
				chip.dataset.kind = 'image';
				chip.onclick = () => {
					this.pendingImageParts = this.pendingImageParts.filter(p => p.data !== data);
					this.dragDropManager.onRemoveImagePart(data, size);
					chip.remove();
				};
			},
			onRemoveImagePart: (_data, _size) => {}
		}, () => this.plugin.getClient()?.getAgentCapabilities() ?? null);
		this.dragDropManager.setup();
	}

	override onClose(): Promise<void> {
		this.closeSessionDropdown();
		this.closeAutocomplete();
		this.keybindingMgr?.unregister();
		this.unregisterEventListeners();
		this.contextChipsEl?.remove();
		return Promise.resolve();
	}

	private unregisterEventListeners(): void {
		if (this.scrollHandler && this.messagesEl) {
			this.messagesEl.removeEventListener('scroll', this.scrollHandler);
			this.scrollHandler = null;
		}
		if (this.dragDropManager) {
			this.dragDropManager.teardown();
		}
	}

	// ── Keybindings ──

	private async clearScreen(): Promise<void> {
		await this.cancelActiveGeneration();
		this.resetConversationView();
		this.clearAutoRefs();
		if (this.messagesEl.children.length === 0) {
			this.welcomeView.show(this.plugin.getClient() !== null);
		}
	}

	private copyLastAssistantMessage(): void {
		if (!this.state.sessionId) return;
		const session = this.sessionStore.get(this.state.sessionId);
		if (!session) return;

		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i];
			if (msg.role === 'assistant' && msg.type !== 'thinking') {
				navigator.clipboard.writeText(msg.content);
				break;
			}
		}
	}

	// ── Smart Auto-scroll ──

	private setupSmartScroll(): void {
		this.scrollHandler = () => {
			const { scrollTop, clientHeight, scrollHeight } = this.messagesEl;
			const nearBottom = scrollTop + clientHeight >= scrollHeight - 50;

			if (!nearBottom && this.state.autoScrollEnabled) {
				// User scrolled up, pause auto-scroll
				this.state.autoScrollEnabled = false;
				this.showNewMessagesBtn();
			} else if (nearBottom && !this.state.autoScrollEnabled) {
				// User scrolled to bottom, resume auto-scroll
				this.state.autoScrollEnabled = true;
				this.hideNewMessagesBtn();
			}
		};
		this.messagesEl.addEventListener('scroll', this.scrollHandler);
	}

	private showNewMessagesBtn(): void {
		if (this.newMessagesBtn) return;
		const btn = this.messagesEl.createEl('button', {
			cls: 'copsidian-new-messages-btn',
			text: t().newMessages,
		});
		btn.onclick = () => {
			this.state.autoScrollEnabled = true;
			this.hideNewMessagesBtn();
			this.renderer.forceScrollToBottom();
		};
		this.newMessagesBtn = btn;
	}

	private hideNewMessagesBtn(): void {
		this.newMessagesBtn?.remove();
		this.newMessagesBtn = null;
	}

	setAutoScrollEnabled(enabled: boolean): void {
		this.state.autoScrollEnabled = enabled;
		if (enabled) this.hideNewMessagesBtn();
	}

	refreshLocale(): void {
		this.headerTitleEl?.setText(t().appName);
		this.newSessionBtnEl?.setText(t().header.new);
		if (this.reconnectBtn) {
			this.reconnectBtn.textContent = this.reconnectBtn.disabled ? t().reconnect.connecting : t().reconnect.text;
		}
		if (this.newMessagesBtn) {
			this.newMessagesBtn.textContent = t().newMessages;
		}
	}

	private clearPendingImageChips(): void {
		this.pendingImageParts = [];
		if (this.dragDropManager) this.dragDropManager.resetBytes();
		this.contextChipsEl.querySelectorAll('.copsidian-chip').forEach((el) => {
			if ((el as HTMLDivElement).dataset.kind === 'image') el.remove();
		});
	}

	private clearAutoRefs(): void {
		if (!this.lastAutoRefId) return;
		const existing = this.currentRefs.find(r => r.id === this.lastAutoRefId);
		if (existing && !this.manualRefs.has(existing.id)) this.removeChip(existing.id);
		this.lastAutoRefId = null;
	}

	// ── Session management ──

	private handleDisconnect(): void {
		this.state.isConnected = false;
		this.closeAutocomplete();
		if (this.permissionBanner) this.permissionBanner.dismiss();
		this.renderer.removeAssistantPlaceholder();
		this.streamCtrl.reset();
		this.busy = false;
		this.state.isStreaming = false;
		this.state.usage = null;
		this.state.lastError = null;
		this.state.needsAttention = false;
		this.input.setStreaming(false);
		this.toolbar.setSending(false);
		if (this.welcomeView) this.welcomeView.updateStatus(false);
		if (this.reconnectBtn) return;
		this.reconnectBtn = this.contentEl.createEl('button', {
			cls: 'copsidian-reconnect-btn',
			text: t().reconnect.text,
		});
		this.reconnectBtn.onclick = () => this.reconnect();
	}

	private async reconnect(): Promise<void> {
		if (this.reconnectBtn) {
			this.reconnectBtn.textContent = t().reconnect.connecting;
			this.reconnectBtn.disabled = true;
		}
		try {
			const connected = await this.plugin.initClient();
			if (!connected) throw new Error(t().reconnect.failed);
			this.bindClientHandlers();
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[copsidian] session resync:', e);
			}
			this.loadToolbarOptions();
			this.state.isConnected = true;
			if (this.welcomeView) this.welcomeView.updateStatus(true);
			this.hideReconnectBtn();
		} catch (e) {
			console.error('[copsidian] reconnect failed:', e);
			if (this.reconnectBtn) {
				this.reconnectBtn.textContent = t().reconnect.failed;
				this.reconnectBtn.disabled = false;
			}
		}
	}

	private hideReconnectBtn(): void {
		if (this.reconnectBtn) {
			this.reconnectBtn.remove();
			this.reconnectBtn = null;
		}
	}

	private async restoreSession(): Promise<void> {
		if (!this.state.sessionId) return;
		const session = this.sessionStore.get(this.state.sessionId);
		if (!session) return;
		let idx = 0;
		for (const msg of session.messages) {
			const restoreId = `restore-${msg.timestamp}-${idx++}`;
			if (msg.role === 'user') {
				this.renderer.addUserMessage(msg.content, msg.timestamp);
			} else if (msg.role === 'assistant') {
				if (msg.type === 'thinking') this.renderer.appendThinking(msg.content, restoreId, msg.timestamp);
				else this.renderer.appendText(msg.content, restoreId, msg.timestamp);
			}
		}
	}

	private async newSession(): Promise<void> {
		await this.sessionStore.save();
		const connected = await this.ensureClientConnected();
		if (!connected) return;
		const c = this.plugin.getClient();
		if (!c) return;

		try {
			await this.cancelActiveGeneration();
			this.resetConversationView();
			await this.sessionMutex.runExclusive(async () => {
				const sid = await c.createSession(this.getVaultCwd(), this.plugin.settings.mcpServers);
				this.state.sessionId = sid;
				await applyDefaultSessionSettings(c, sid, this.plugin.settings);
			});
			if (this.state.sessionId) {
				this.sessionStore.getOrCreate(this.state.sessionId);
				this.sessionStore.setActive(this.state.sessionId);
			}
			await this.sessionStore.save();
			this.loadToolbarOptions();
			if (this.messagesEl.children.length === 0) {
				this.welcomeView.show(this.plugin.getClient() !== null);
			}
			this.autoRefActiveFile();
		} catch (e) {
			console.error('[copsidian] newSession:', e);
		}
	}

	private async toggleSessions(): Promise<void> {
		if (!this.sessionDropdownMgr) return;
		if (this.sessionDropdownMgr.isOpen()) {
			this.sessionDropdownMgr.close();
			return;
		}
		this.sessionDropdownMgr.open();
	}

	private closeSessionDropdown(): void {
		this.sessionDropdownMgr?.close();
	}

	// ── Sending ──

	private async send(text: string, refs: ContextRef[]): Promise<void> {
		if (this.busy) return;
		const sessionId = await this.ensureRuntimeSession();
		const c = this.plugin.getClient();
		if (!c || !sessionId) return;
		const inlineEdit = this.inlineEditPanel.pendingState;
		if (!inlineEdit) this.inlineEditPanel.clearState();

		// Hide welcome page on first message
		if (this.welcomeView) this.welcomeView.hide();

		const cmd = parseSlashCommand(text);
		if (cmd && isBuiltInCommand(cmd.name)) {
			await this.executeBuiltIn(cmd.name, cmd.args);
			return;
		}
		// Non-built-in slash commands are sent directly to the agent as text

		this.busy = true;
		this.state.isStreaming = true;
		this.input.setStreaming(true);
		this.toolbar.setSending(true);
		this.sendStartTime = Date.now();
		this.renderer.addUserMessage(text);
		this.streamCtrl.saveMessage('user', text, 'text');
		this.renderer.addAssistantPlaceholder();

		try {
			await this.syncRuntimeSession(sessionId);
			const parts = await this.buildParts(text, refs);
			if (this.state.sessionId !== sessionId || !this.busy) return;
			this.clearPendingImageChips();
			const response = await c.sendMessage(sessionId, parts, (ch: NormalizedUpdate) => {
				if (!this.busy || this.state.sessionId !== sessionId) return;
				this.streamCtrl.handleChunk(ch);
			});
			// Use response-level usage (has inputTokens/outputTokens), fall back to state.usage for cost
			if (response?.usage) {
				this.state.usage = {
					totalTokens: response.usage.totalTokens ?? 0,
					inputTokens: response.usage.inputTokens ?? 0,
					outputTokens: response.usage.outputTokens ?? 0,
					thoughtTokens: response.usage.thoughtTokens,
					cost: this.state.usage?.cost,
				};
			}
		} catch (e: unknown) {
			if (this.state.sessionId === sessionId) {
				this.renderer.addError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			this.renderer.removeAssistantPlaceholder();
			this.busy = false;
			this.state.isStreaming = false;
			this.input.setStreaming(false);
			this.toolbar.setSending(false);
			this.input.focus();
			// Show usage stats after streaming completes
			if (this.state.usage) {
				this.renderer.showUsage({
					...this.state.usage,
					modelId: this.state.currentModelId ?? undefined,
					elapsedMs: Date.now() - this.sendStartTime,
				});
			}
			// Handle inline edit response
			if (inlineEdit && this.inlineEditPanel.pendingState === inlineEdit) {
				const session = this.sessionStore.get(sessionId ?? '');
				if (session) {
					const lastMsg = session.messages.slice().reverse().find(m => m.role === 'assistant');
					if (lastMsg) {
						this.inlineEditPanel.showDiffFromResponse(inlineEdit.original, lastMsg.content);
					}
				}
				this.inlineEditPanel.pendingState = null;
			}
		}
	}

	private async executeBuiltIn(name: string, _args: string): Promise<void> {
		const sessionId = await this.ensureRuntimeSession();
		const c = this.plugin.getClient();
		if (!c || !sessionId) return;

		if (name === 'compact') {
			this.renderer.addUserMessage('/compact');
			this.streamCtrl.saveMessage('user', '/compact', 'text');
			try {
				await this.syncRuntimeSession(sessionId);
				if (this.state.sessionId !== sessionId) return;
				await c.compact(sessionId);
				if (this.state.sessionId !== sessionId) return;
				const message = t().message.compacted;
				this.renderer.appendText(message, `compact-${Date.now()}`);
				this.streamCtrl.saveMessage('assistant', message, 'text');
			} catch (e) {
				if (this.state.sessionId === sessionId) {
					this.renderer.addError(e instanceof Error ? e.message : t().error.compact);
				}
			}
		}
	}

	private async stopGeneration(): Promise<void> {
		const c = this.plugin.getClient();
		if (!c || !this.state.sessionId || (!this.busy && !this.state.isStreaming)) return;
		// Reset UI immediately so user gets feedback
		this.busy = false;
		this.state.isStreaming = false;
		this.input.setStreaming(false);
		this.toolbar.setSending(false);
		try {
			await c.cancel(this.state.sessionId);
		} catch (e) {
			console.error('[copsidian] cancel:', e);
		}
	}

	private async buildParts(text: string, refs: ContextRef[]): Promise<PromptPart[]> {
		const parts: PromptPart[] = [];

		// Add context injection if there are references
		const resolved: Array<{ name: string; content: string }> = [];
		for (const ref of refs) {
			const result = await this.resolver.resolveNote(ref.path);
			if (result) resolved.push(result);
		}
		const injection = ContextInjection.build(resolved);
		const activeAgent = getValidActiveCustomAgent(
			this.plugin.settings.activeCustomAgentId,
			this.plugin.settings.customAgents,
			this.plugin.settings.customSkills,
		);
		const customAgentPrompt = buildCustomAgentPrompt(activeAgent, this.plugin.settings.customSkills);
		const sysPrompt = ContextInjection.systemPrompt(this.plugin.settings.systemPrompt, customAgentPrompt);
		const combined = [sysPrompt, injection].filter(Boolean).join('\n\n');
		if (combined) parts.push({ type: 'text', text: combined });

		parts.push({ type: 'text', text });
		parts.push(...this.pendingImageParts.map(part => ({ ...part })));

		return parts;
	}

	// ── Toolbar options ──

	private applyConfigOptions(opts: import('../types').SessionConfigOption[]): void {
		for (const opt of opts) {
			if (opt.id === 'model') {
				this.toolbar.updateModels(
					this.filterCommonModelOptions(opt.options.map(o => ({ value: o.value, label: o.name }))),
					opt.currentValue,
				);
			}
			if (opt.id === 'effort') {
				this.toolbar.updateEffort(
					opt.options.map(o => ({ value: o.value, label: o.name })),
					opt.currentValue,
				);
			}
			if (opt.id === 'mode') {
				this.toolbar.updateAgents(
					opt.options.map(o => ({ value: o.value, label: o.name })),
					opt.currentValue,
				);
			}
		}
	}

	private applyModeUpdate(modeId: string | null, modes: import('../types').ModeOption[]): void {
		this.toolbar.updateAgents(
			modes.map(m => ({ value: m.id, label: m.name })),
			modeId ?? undefined,
		);
	}

	private applyModelUpdate(modelId: string | null, models: import('../types').ModelOption[]): void {
		this.toolbar.updateModels(
			this.filterCommonModelOptions(models.map(m => ({ value: m.modelId, label: m.name }))),
			modelId ?? undefined,
		);
	}

	private async ensureClientConnected(): Promise<boolean> {
		const existing = this.plugin.getClient();
		if (existing?.isConnected()) {
			this.state.isConnected = true;
			this.bindClientHandlers();
			this.hideReconnectBtn();
			if (this.welcomeView) this.welcomeView.updateStatus(true);
			return true;
		}

		const connected = await this.plugin.initClient();
		this.state.isConnected = connected;
		if (!connected) {
			this.handleDisconnect();
			return false;
		}

		this.bindClientHandlers();
		this.hideReconnectBtn();
		if (this.welcomeView) this.welcomeView.updateStatus(true);
		return true;
	}

	private async ensureRuntimeSession(): Promise<string | null> {
		if (!(await this.ensureClientConnected())) return null;
		const client = this.plugin.getClient();
		if (!client) return null;

		if (this.state.sessionId) {
			await this.syncRuntimeSession(this.state.sessionId);
			this.loadToolbarOptions();
			return this.state.sessionId;
		}

		try {
			await this.sessionMutex.runExclusive(async () => {
				const sid = await client.createSession(this.getVaultCwd(), this.plugin.settings.mcpServers);
				this.state.sessionId = sid;
				await applyDefaultSessionSettings(client, sid, this.plugin.settings);
			});
			if (this.state.sessionId) {
				this.sessionStore.getOrCreate(this.state.sessionId);
				this.sessionStore.setActive(this.state.sessionId);
			}
			await this.sessionStore.save();
			this.loadToolbarOptions();
			return this.state.sessionId;
		} catch (e) {
			console.error('[copsidian] session init:', e);
			return null;
		}
	}

	loadToolbarOptions(): void {
		const c = this.plugin.getClient();
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

		this.toolbar.updateAgents(
			agents,
			snapshot.currentModeId ?? modeConfig?.currentValue ?? this.plugin.settings.defaultAgent,
		);
		this.toolbar.updateModels(
			models,
			snapshot.currentModelId ?? modelConfig?.currentValue ?? this.plugin.settings.defaultModel,
		);
		this.state.currentModelId = snapshot.currentModelId ?? modelConfig?.currentValue ?? null;
		this.toolbar.updateEffort(
			efforts,
			effortConfig?.currentValue ?? this.plugin.settings.defaultEffort,
		);
	}

	private filterCommonModelOptions(options: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
		return filterCommonModelOptions(options, this.plugin.settings.commonModels, this.plugin.settings.defaultModel);
	}

	// ── @mention chips ──

	private addChip(ref: ContextRef, source: 'manual' | 'auto' = 'manual'): void {
		if (this.currentRefs.some(r => r.id === ref.id)) {
			if (source === 'manual') {
				this.manualRefs.add(ref.id);
				if (this.lastAutoRefId === ref.id) this.lastAutoRefId = null;
			}
			return;
		}
		this.currentRefs.push(ref);
		if (source === 'manual') {
			this.manualRefs.add(ref.id);
			if (this.lastAutoRefId === ref.id) this.lastAutoRefId = null;
		}
		const chip = this.contextChipsEl.createDiv({ cls: 'copsidian-chip' });
		chip.dataset.refId = ref.id;
		chip.title = ref.path;
		chip.createSpan({ text: `@${ref.name}` });
		const x = chip.createSpan({ cls: 'chip-remove', text: '×' });
		x.onclick = (e: MouseEvent) => { e.stopPropagation(); this.removeChip(ref.id); };
	}

	private removeChip(id: string): void {
		this.currentRefs = this.currentRefs.filter(r => r.id !== id);
		if (this.mention.hasRef(id)) this.mention.removeRef(id);
		this.manualRefs.delete(id);
		this.contextChipsEl.querySelectorAll('.copsidian-chip').forEach(el => {
			if ((el as HTMLDivElement).dataset.refId === id) el.remove();
		});
	}

	private autoRefActiveFile(): void {
		// Try to get the active file from a non-Copsidian leaf
		const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
		const activeLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		const activeView = activeLeaf?.view as MarkdownFileView | undefined;
		const firstMarkdownView = leaves[0]?.view as MarkdownFileView | undefined;
		const file = activeLeaf?.view?.getViewType() === 'markdown'
			? activeView?.file
			: firstMarkdownView?.file;
		if (!file || file.extension !== 'md') return;
		if (this.manualRefs.has(file.path)) return;
		this.addChip({ id: file.path, type: 'note', name: file.basename, path: file.path }, 'auto');
		this.lastAutoRefId = file.path;
	}

	private setupActiveFileTracking(): void {
		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
				if (!leaf) return;
				const view = leaf.view as MarkdownFileView;
				if (view?.getViewType?.() !== 'markdown') return;
				const file = view.file;
				if (!file || file.extension !== 'md') return;
				// Replace existing auto-ref chip with the new active file
				const existing = this.currentRefs.find(r => r.id === this.lastAutoRefId);
				if (existing) {
					if (this.manualRefs.has(existing.id)) this.lastAutoRefId = null;
					else this.removeChip(existing.id);
				}
				if (this.manualRefs.has(file.path)) return;
				this.lastAutoRefId = file.path;
				this.addChip({ id: file.path, type: 'note', name: file.basename, path: file.path }, 'auto');
			}),
		);
	}

	// ── Autocomplete ──

	private showAC(mode: '@' | '/'): void {
		this.closeAutocomplete();
		const allItems: Array<{ value: string; label: string; description?: string }> = [];

		if (mode === '@') {
			const notes = this.mention.listAllNotes();
			for (const n of notes) {
				allItems.push({ value: n.path, label: `@${n.name}`, description: n.path });
			}
		} else {
			for (const cmd of this.state.availableCommands) {
				allItems.push({ value: cmd.name, label: `/${cmd.name}`, description: cmd.description });
			}
			if (allItems.length === 0) {
				allItems.push({ value: 'compact', label: '/compact', description: t().slash.compact });
			}
		}

		this.autocomplete?.open(allItems, mode);
	}

	private handleACSelect(value: string, mode: '@' | '/'): void {
		this.closeAutocomplete();

		if (mode === '@') {
			const allNotes = this.mention.listAllNotes();
			const note = allNotes.find(n => n.path === value || n.name === value);
			if (note) {
				this.mention.addRef(note);
				this.addChip(note, 'manual');
				value = `@${note.name}`;
			} else {
				value = value.startsWith('@') ? value : `@${value}`;
			}
		} else if (!value.startsWith('/')) {
			value = `/${value}`;
		}

		this.input.appendValue(value + ' ');
		this.input.focus();
	}

	private closeAutocomplete(): void {
		this.autocomplete?.close();
	}

	// ── Inline Edit ──

	async requestInlineEdit(selected: string, editor: import('obsidian').Editor): Promise<void> {
		const prompt = this.inlineEditPanel.request(selected, editor);
		await this.send(prompt, []);
	}
}
