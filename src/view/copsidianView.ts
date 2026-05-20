import { ItemView, WorkspaceLeaf } from 'obsidian';
import type CopsidianPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { SessionUpdate, ContextRef, PromptPart, PermissionRequest } from '../types';
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

export class CopsidianView extends ItemView {
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
	private sessionDropdown: HTMLDivElement | null = null;
	private sessionOutsideHandler: ((e: MouseEvent) => void) | null = null;
	private acOutsideHandler: ((e: MouseEvent) => void) | null = null;
	private acKeyHandler: ((e: KeyboardEvent) => void) | null = null;
	private currentRefs: ContextRef[] = [];
	private manualRefs = new Set<string>();
	private acDropdown: HTMLDivElement | null = null;
	private reconnectBtn: HTMLButtonElement | null = null;
	private permissionBannerEl: HTMLDivElement | null = null;
	private welcomeEl: HTMLDivElement | null = null;
	private globalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
	private newMessagesBtn: HTMLButtonElement | null = null;
	private dragOverlayEl: HTMLDivElement | null = null;
	private pendingImageParts: PromptPart[] = [];
	private lastAutoRefId: string | null = null;
	private sendStartTime = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CopsidianPlugin,
	) { super(leaf); }

	private getVaultCwd(): string {
		return getVaultPath(this.plugin.app);
	}

	private resetConversationView(): void {
		this.closeAutocomplete();
		this.dismissPermissionBanner();
		this.hideWelcome();
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
		this.manualRefs.clear();
		this.lastAutoRefId = null;
		this.mention.clear();
		this.contextChipsEl.empty();
	}

	private async syncRuntimeSession(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		const client = this.plugin.getClient();
		if (!client) return;
		if (client.getCurrentSessionId() === sessionId) return;
		await client.loadSession(sessionId, this.getVaultCwd());
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
		const acp = (client as any).acp;
		if (!acp) return;
		acp.onClose = () => this.handleDisconnect();
		acp.onReconnect = async () => {
			await this.plugin.initClient();
			this.bindClientHandlers();
			this.state.isConnected = true;
			this.updateWelcomeStatus();
			this.hideReconnectBtn();
			this.hookPermissionHandler();
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[copsidian] session resync:', e);
			}
			this.loadToolbarOptions();
		};
	}

	override getViewType(): string { return VIEW_TYPE; }
	override getDisplayText(): string { return 'Copsidian'; }
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
		header.createDiv({ text: 'Copsidian', cls: 'copsidian-header-title' });
		const actions = header.createDiv({ cls: 'copsidian-header-actions' });
		actions.createEl('button', { text: 'New', cls: 'mod-icon' }).onclick = () => this.newSession();
		this.sessionButtonEl = actions.createEl('button', { text: '⋯', cls: 'mod-icon' });
		this.sessionButtonEl.onclick = () => this.toggleSessions();

		// ── Messages ──
		this.messagesEl = el.createDiv({ cls: 'copsidian-messages' });
		this.renderer = new ChatRenderer(this.messagesEl, this.plugin.app, () => this.state.autoScrollEnabled);

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
		});

		// Ensure a session exists before rendering
		await this.plugin.waitForClient();
		if (!this.state.sessionId) {
			try {
				const c = this.plugin.getClient();
				if (c) {
					this.state.sessionId = await c.createSession(this.getVaultCwd());
					this.sessionStore.getOrCreate(this.state.sessionId);
					this.sessionStore.setActive(this.state.sessionId);
					await this.sessionStore.save();
				}
			} catch (e) {
				console.error('[copsidian] session init:', e);
			}
		}

		try {
			await this.syncRuntimeSession(this.state.sessionId);
		} catch (e) {
			console.error('[copsidian] session sync:', e);
		}

		// Restore previous messages if any
		await this.restoreSession();

		// Load toolbar options
		this.loadToolbarOptions();

		// Watch for ACP disconnection and auto-reconnect
		this.bindClientHandlers();
		this.hookPermissionHandler();

		// Show welcome page if no messages
		this.maybeShowWelcome();

		// Auto-reference the currently active file
		this.autoRefActiveFile();

		// Track active file changes
		this.setupActiveFileTracking();

		// Register global keybindings
		this.registerKeybindings();

		// Setup smart auto-scroll
		this.setupSmartScroll();

		// Setup drag and drop
		this.setupDragDrop();
	}

	override onClose(): Promise<void> {
		this.closeSessionDropdown();
		this.closeAutocomplete();
		this.unregisterKeybindings();
		this.contextChipsEl.remove();
		return Promise.resolve();
	}

	// ── Welcome page ──

	private maybeShowWelcome(): void {
		if (this.messagesEl.children.length > 0) return;
		this.showWelcome();
	}

	private showWelcome(): void {
		this.hideWelcome();
		const welcome = this.messagesEl.createDiv({ cls: 'copsidian-welcome' });
		this.welcomeEl = welcome;

		welcome.createDiv({ cls: 'copsidian-welcome-title', text: 'Copsidian' });
		welcome.createDiv({ cls: 'copsidian-welcome-subtitle', text: 'OpenCode Agent in Obsidian' });

		const shortcuts = welcome.createDiv({ cls: 'copsidian-welcome-shortcuts' });
		shortcuts.createDiv({ text: 'Enter  Send message' });
		shortcuts.createDiv({ text: 'Escape  Stop generation' });
		shortcuts.createDiv({ text: '@  Reference a note' });
		shortcuts.createDiv({ text: '/  Slash commands' });

		const status = welcome.createDiv({ cls: 'copsidian-welcome-status' });
		status.createSpan({ text: this.plugin.getClient() ? '● Connected' : '○ Disconnected' });
	}

	updateWelcomeStatus(): void {
		if (!this.welcomeEl) return;
		const status = this.welcomeEl.querySelector('.copsidian-welcome-status');
		if (!status) return;
		status.textContent = this.plugin.getClient() ? '● Connected' : '○ Disconnected';
	}

	private hideWelcome(): void {
		if (this.welcomeEl) {
			this.welcomeEl.remove();
			this.welcomeEl = null;
		}
	}

	// ── Keybindings ──

	private registerKeybindings(): void {
		this.globalKeyHandler = (e: KeyboardEvent) => {
			const isMod = e.ctrlKey || e.metaKey;

			// Ctrl/Cmd + N → New session
			if (isMod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
				e.preventDefault();
				this.newSession();
				return;
			}

			// Ctrl/Cmd + L → Clear screen
			if (isMod && e.key.toLowerCase() === 'l' && !e.shiftKey) {
				e.preventDefault();
				void this.clearScreen();
				return;
			}

			// Ctrl/Cmd + Shift + C → Copy last assistant message
			if (isMod && e.shiftKey && e.key.toLowerCase() === 'c') {
				e.preventDefault();
				this.copyLastAssistantMessage();
				return;
			}
		};
		this.contentEl.addEventListener('keydown', this.globalKeyHandler);
	}

	private unregisterKeybindings(): void {
		if (this.globalKeyHandler) {
			this.contentEl.removeEventListener('keydown', this.globalKeyHandler);
			this.globalKeyHandler = null;
		}
	}

	private async clearScreen(): Promise<void> {
		await this.cancelActiveGeneration();
		this.resetConversationView();
		this.clearAutoRefs();
		this.maybeShowWelcome();
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
		this.messagesEl.addEventListener('scroll', () => {
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
		});
	}

	private showNewMessagesBtn(): void {
		if (this.newMessagesBtn) return;
		const btn = this.messagesEl.createEl('button', {
			cls: 'copsidian-new-messages-btn',
			text: '↓ New messages',
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

	// ── Drag and Drop ──

	private setupDragDrop(): void {
		const dropZone = this.messagesEl;

		dropZone.addEventListener('dragover', (e: DragEvent) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'copy';
			this.showDragOverlay();
		});

		dropZone.addEventListener('dragleave', (e: DragEvent) => {
			if (!dropZone.contains(e.relatedTarget as Node)) {
				this.hideDragOverlay();
			}
		});

		dropZone.addEventListener('drop', async (e: DragEvent) => {
			e.preventDefault();
			this.hideDragOverlay();
			await this.handleDrop(e);
		});
	}

	private showDragOverlay(): void {
		if (this.dragOverlayEl) return;
		const overlay = this.messagesEl.createDiv({ cls: 'copsidian-drag-overlay' });
		overlay.createDiv({ text: 'Drop to attach' });
		this.dragOverlayEl = overlay;
	}

	private hideDragOverlay(): void {
		this.dragOverlayEl?.remove();
		this.dragOverlayEl = null;
	}

	private clearPendingImageChips(): void {
		this.pendingImageParts = [];
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

	private async handleDrop(e: DragEvent): Promise<void> {
		const files = e.dataTransfer?.files;
		if (!files?.length) return;

		for (const file of Array.from(files)) {
			if (file.name.endsWith('.md')) {
				// Markdown file → ContextRef
				const path = (file as any).webkitRelativePath || file.name;
				const ref: ContextRef = {
					id: path,
					type: 'note',
					name: file.name.replace(/\.md$/, ''),
					path,
				};
				this.addChip(ref, 'manual');
			} else if (file.type.startsWith('image/')) {
				// Image → base64 PromptPart
				try {
					const data = await this.fileToBase64(file);
					this.pendingImageParts.push({
						type: 'image',
						mimeType: file.type,
						data,
					});
					// Show chip for image
				const chip = this.contextChipsEl.createDiv({
					cls: 'copsidian-chip',
					text: `🖼 ${file.name}`,
				});
				chip.dataset.kind = 'image';
				chip.onclick = () => {
					this.pendingImageParts = this.pendingImageParts.filter(p => p.data !== data);
					chip.remove();
				};
				} catch (err) {
					console.error('[copsidian] Failed to read image:', err);
				}
			}
		}
	}

	private fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				resolve(result.split(',')[1]);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	// ── Session management ──

	private handleDisconnect(): void {
		this.state.isConnected = false;
		this.closeAutocomplete();
		this.dismissPermissionBanner();
		this.renderer.removeAssistantPlaceholder();
		this.streamCtrl.reset();
		this.busy = false;
		this.state.isStreaming = false;
		this.state.usage = null;
		this.state.lastError = null;
		this.state.needsAttention = false;
		this.input.setStreaming(false);
		this.toolbar.setSending(false);
		this.updateWelcomeStatus();
		if (this.reconnectBtn) return;
		this.reconnectBtn = this.contentEl.createEl('button', {
			cls: 'copsidian-reconnect-btn',
			text: 'Reconnect',
		});
		this.reconnectBtn.onclick = () => this.reconnect();
	}

	private async reconnect(): Promise<void> {
		if (this.reconnectBtn) {
			this.reconnectBtn.textContent = 'Reconnecting…';
			this.reconnectBtn.disabled = true;
		}
		try {
			await this.plugin.initClient();
			this.bindClientHandlers();
			this.hookPermissionHandler();
			try {
				await this.syncRuntimeSession(this.state.sessionId);
			} catch (e) {
				console.error('[copsidian] session resync:', e);
			}
			this.loadToolbarOptions();
			this.state.isConnected = true;
			this.updateWelcomeStatus();
			this.hideReconnectBtn();
		} catch (e) {
			console.error('[copsidian] reconnect failed:', e);
			if (this.reconnectBtn) {
				this.reconnectBtn.textContent = 'Reconnect (failed)';
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
		const c = this.plugin.getClient();
		if (!c) return;

		await this.sessionStore.save();

		try {
			await this.cancelActiveGeneration();
			this.resetConversationView();
			this.state.sessionId = await c.createSession(this.getVaultCwd());
			this.sessionStore.getOrCreate(this.state.sessionId);
			this.sessionStore.setActive(this.state.sessionId);
			await this.sessionStore.save();
			this.loadToolbarOptions();
			this.maybeShowWelcome();
			this.autoRefActiveFile();
		} catch (e) {
			console.error('[copsidian] newSession:', e);
		}
	}

	private async toggleSessions(): Promise<void> {
		if (this.sessionDropdown) {
			this.closeSessionDropdown();
			return;
		}

		const list = this.sessionStore.list();
		const dd = this.contentEl.createDiv({ cls: 'copsidian-session-list' });

		const rect = this.sessionButtonEl?.getBoundingClientRect();
		dd.style.position = 'fixed';
		dd.style.top = `${(rect?.bottom ?? 36) + 4}px`;
		dd.style.right = `${Math.max(8, (window.innerWidth - (rect?.right ?? window.innerWidth - 8)))}px`;

		// Search input
		const searchInput = dd.createEl('input', {
			cls: 'copsidian-session-search',
			attr: { placeholder: 'Search sessions…', type: 'text' },
		});

		const itemsContainer = dd.createDiv({ cls: 'copsidian-session-items' });

		const renderItems = (filter: string) => {
			itemsContainer.empty();
			const filtered = filter
				? list.filter(s => s.title?.toLowerCase().includes(filter.toLowerCase()))
				: list;

			if (filtered.length === 0) {
				itemsContainer.createDiv({
					cls: 'copsidian-session-empty',
					text: 'No sessions found',
				});
				return;
			}

			for (const s of filtered) {
				const it = itemsContainer.createDiv({
					cls: `copsidian-session-item${s.sessionId === this.state.sessionId ? ' active' : ''}`,
				});
				it.createSpan({ text: s.title || s.sessionId, cls: 'session-label' });
				const delBtn = it.createSpan({ text: '×', cls: 'session-delete' });
				delBtn.onclick = async (e: MouseEvent) => {
					e.stopPropagation();
					this.sessionStore.remove(s.sessionId);
					await this.sessionStore.save();
				if (s.sessionId === this.state.sessionId) {
					await this.newSession();
				}
				this.closeSessionDropdown();
			};
			it.onclick = async () => {
				this.state.sessionId = s.sessionId;
				this.sessionStore.getOrCreate(s.sessionId);
				this.closeSessionDropdown();
				await this.cancelActiveGeneration();
				this.resetConversationView();
				this.clearAutoRefs();
				try {
					await this.syncRuntimeSession(s.sessionId);
				} catch (e) {
					console.error('[copsidian] session switch sync:', e);
				}
				await this.restoreSession();
				this.sessionStore.setActive(s.sessionId);
				await this.sessionStore.save();
				this.loadToolbarOptions();
				this.maybeShowWelcome();
				this.autoRefActiveFile();
			};
		}
	};

		searchInput.addEventListener('input', () => {
			renderItems(searchInput.value);
		});

		renderItems('');

		this.sessionDropdown = dd;
		this.sessionOutsideHandler = (evt: MouseEvent) => {
			if (!this.sessionDropdown) return;
			const target = evt.target as Node;
			if (this.sessionDropdown.contains(target) || this.sessionButtonEl?.contains(target)) return;
			this.closeSessionDropdown();
		};
		document.addEventListener('mousedown', this.sessionOutsideHandler, true);
	}

	private closeSessionDropdown(): void {
		if (this.sessionDropdown) this.sessionDropdown.remove();
		this.sessionDropdown = null;
		if (this.sessionOutsideHandler) {
			document.removeEventListener('mousedown', this.sessionOutsideHandler, true);
			this.sessionOutsideHandler = null;
		}
	}

	// ── Sending ──

	private async send(text: string, refs: ContextRef[]): Promise<void> {
		const c = this.plugin.getClient();
		const sessionId = this.state.sessionId;
		if (!c || !sessionId || this.busy) return;

		// Hide welcome page on first message
		this.hideWelcome();

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
			const response = await c.sendMessage(sessionId, parts, (ch: SessionUpdate) => {
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
		}
	}

	private async executeBuiltIn(name: string, _args: string): Promise<void> {
		const c = this.plugin.getClient();
		const sessionId = this.state.sessionId;
		if (!c || !sessionId) return;

		if (name === 'compact') {
			this.renderer.addUserMessage('/compact');
			this.streamCtrl.saveMessage('user', '/compact', 'text');
			try {
				await this.syncRuntimeSession(sessionId);
				if (this.state.sessionId !== sessionId) return;
				await c.compact(sessionId);
				if (this.state.sessionId !== sessionId) return;
				const message = 'Session compacted.';
				this.renderer.appendText(message, `compact-${Date.now()}`);
				this.streamCtrl.saveMessage('assistant', message, 'text');
			} catch (e) {
				if (this.state.sessionId === sessionId) {
					this.renderer.addError(e instanceof Error ? e.message : 'Compact failed');
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

	// ── Permission UI ──

	private hookPermissionHandler(): void {
		const client = this.plugin.getClient();
		if (!client) return;
		const acp = (client as any).acp;
		if (!acp) return;
		acp.onPermissionRequest = async (req: PermissionRequest) => (
			client.permissionMode === 'safe'
				? this.showPermissionBanner(req)
				: client.requestPermission(req)
		);
	}

	private showPermissionBanner(req: PermissionRequest): Promise<string> {
		return new Promise((resolve) => {
			this.dismissPermissionBanner();
			const banner = this.messagesEl.createDiv({ cls: 'copsidian-permission-banner' });
			this.permissionBannerEl = banner;

			const title = req.toolCall.title || req.toolCall.kind;
			banner.createDiv({ cls: 'perm-title', text: `Permission: ${title}` });

			if (req.toolCall.locations?.length) {
				banner.createDiv({ cls: 'perm-path', text: req.toolCall.locations[0].path });
			}

			const actions = banner.createDiv({ cls: 'perm-actions' });
			for (const opt of req.options) {
				const btn = actions.createEl('button', {
					text: opt.name,
					cls: `perm-btn perm-${opt.kind}`,
				});
				btn.onclick = () => {
					this.dismissPermissionBanner();
					resolve(opt.optionId);
				};
			}

			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		});
	}

	private dismissPermissionBanner(): void {
		if (this.permissionBannerEl) {
			this.permissionBannerEl.remove();
			this.permissionBannerEl = null;
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
		const sysPrompt = ContextInjection.systemPrompt(this.plugin.settings.systemPrompt);
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
					opt.options.map(o => ({ value: o.value, label: o.name })),
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
			models.map(m => ({ value: m.modelId, label: m.name })),
			modelId ?? undefined,
		);
	}

	private loadToolbarOptions(): void {
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
		const models = snapshot.availableModels.map(model => ({ value: model.modelId, label: model.name }));
		const efforts = [
			{ value: 'default', label: 'Default' },
			{ value: 'low', label: 'Low' },
			{ value: 'medium', label: 'Medium' },
			{ value: 'high', label: 'High' },
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
		const file = activeLeaf?.view?.getViewType() === 'markdown'
			? (activeLeaf.view as any).file
			: leaves[0]?.view ? (leaves[0].view as any).file : null;
		if (!file || file.extension !== 'md') return;
		if (this.manualRefs.has(file.path)) return;
		this.addChip({ id: file.path, type: 'note', name: file.basename, path: file.path }, 'auto');
		this.lastAutoRefId = file.path;
	}

	private setupActiveFileTracking(): void {
		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
				if (!leaf) return;
				const view = leaf.view as any;
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
				allItems.push({ value: 'compact', label: '/compact', description: 'compact the session' });
			}
		}

		const ac = this.inputAreaEl.createDiv({ cls: 'copsidian-ac-dropdown' });
		this.acDropdown = ac;

		let selIdx = 0;
		let filterText = '';
		let filtered = allItems;

		const applyFilter = () => {
			if (!filterText) {
				filtered = allItems;
			} else {
				const lower = filterText.toLowerCase();
				filtered = allItems.filter(it => it.label.toLowerCase().includes(lower) || it.description?.toLowerCase().includes(lower));
			}
			selIdx = 0;
		};

		const render = () => {
			ac.empty();
			if (filtered.length === 0) {
				ac.createDiv({ cls: 'copsidian-ac-item', text: 'No matches' });
				return;
			}
			for (let i = 0; i < filtered.length; i++) {
				const el = ac.createDiv({ cls: `copsidian-ac-item${i === selIdx ? ' selected' : ''}` });
				el.createSpan({ text: filtered[i].label, cls: 'ac-label' });
				if (filtered[i].description) el.createSpan({ text: filtered[i].description, cls: 'ac-desc' });
				el.onclick = () => {
					this.handleACSelect(filtered[i].value, mode);
				};
			}
		};
		render();

		this.acKeyHandler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closeAutocomplete();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'ArrowDown') {
				selIdx = (selIdx + 1) % Math.max(1, filtered.length);
				render();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'ArrowUp') {
				selIdx = (selIdx - 1 + filtered.length) % Math.max(1, filtered.length);
				render();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'Enter') {
				if (filtered.length > 0) {
					this.handleACSelect(filtered[selIdx].value, mode);
				}
				this.closeAutocomplete();
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.key === 'Backspace') {
				if (filterText.length > 0) {
					e.preventDefault();
					e.stopPropagation();
					filterText = filterText.slice(0, -1);
					applyFilter();
					render();
				} else {
					this.closeAutocomplete();
					e.preventDefault();
					e.stopPropagation();
				}
				return;
			}
			if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				e.stopPropagation();
				filterText += e.key;
				applyFilter();
				render();
			}
		};
		document.addEventListener('keydown', this.acKeyHandler, true);

		this.acOutsideHandler = (evt: MouseEvent) => {
			const target = evt.target as Node;
			if (ac.contains(target)) return;
			this.closeAutocomplete();
		};
		document.addEventListener('mousedown', this.acOutsideHandler, true);
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
		if (this.acDropdown) this.acDropdown.remove();
		this.acDropdown = null;
		if (this.acOutsideHandler) {
			document.removeEventListener('mousedown', this.acOutsideHandler, true);
			this.acOutsideHandler = null;
		}
		if (this.acKeyHandler) {
			document.removeEventListener('keydown', this.acKeyHandler, true);
			this.acKeyHandler = null;
		}
	}
}
