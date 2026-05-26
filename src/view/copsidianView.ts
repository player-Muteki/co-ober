import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type CopsidianPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { ContextRef, PromptPart } from '../types';
import { t } from '../i18n/index';
import { ChatRenderer } from './renderer';
import { ChatInput } from '../chat/input';
import { InputToolbar } from '../chat/toolbar';
import { ContextMention } from '../context/mention';
import { ContextResolver } from '../context/resolver';
import { SyncEngine } from '../sync/engine';
import { createSessionStore } from '../chat/session';
import type { SessionStore } from '../chat/session';
import { SessionDropdown } from './sessionDropdown';
import { Autocomplete } from './autocomplete';
import { DragDropManager } from './dragDropManager';
import { PermissionBanner } from './permissionBanner';
import { InlineEditPanel } from './inlineEditPanel';
import { WelcomeView } from './welcomeView';
import { KeybindingManager } from './keybindingManager';
import { CopsidianViewController } from './copsidianViewController';
import type { ControllerCallbacks, ControllerDeps } from './copsidianViewController';

interface MarkdownFileView {
	getViewType(): string;
	file?: TFile | null;
}

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
	private headerTitleEl: HTMLDivElement | null = null;
	private newSessionBtnEl: HTMLButtonElement | null = null;
	private controller!: CopsidianViewController;

	// Event listener references for cleanup on close
	private scrollHandler: (() => void) | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CopsidianPlugin,
	) { super(leaf); }

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

		// Restore active session
		const savedId = this.plugin.activeSessionId;
		if (savedId) {
			const saved = this.sessionStore.get(savedId);
			if (saved) {
				const sessionId = saved.opencodeSessionId ?? savedId;
				this.sessionStore.getOrCreate(sessionId);
				this.sessionStore.setActive(sessionId);
			}
		}

		// ── Header ──
		const header = el.createDiv({ cls: 'copsidian-header' });
		this.headerTitleEl = header.createDiv({ text: t().appName, cls: 'copsidian-header-title' });
		const actions = header.createDiv({ cls: 'copsidian-header-actions' });
		this.newSessionBtnEl = actions.createEl('button', { text: t().header.new, cls: 'mod-icon' });
		this.sessionButtonEl = actions.createEl('button', { text: '⋯', cls: 'mod-icon' });

		// ── Messages ──
		this.messagesEl = el.createDiv({ cls: 'copsidian-messages' });
		this.renderer = new ChatRenderer(this.messagesEl, this.plugin.app, () => this.controller?.state.autoScrollEnabled ?? true);

		this.permissionBanner = new PermissionBanner(this.messagesEl);
		this.inlineEditPanel = new InlineEditPanel(this.contentEl);
		this.welcomeView = new WelcomeView(this.messagesEl, () => this.plugin.getClient()?.getAgentCapabilities() ?? null);

		// ── Context chips ──
		this.contextChipsEl = el.createDiv({ cls: 'copsidian-context-chips' });

		// ── Input ──
		this.inputAreaEl = el.createDiv({ cls: 'copsidian-input-area' });
		this.input = new ChatInput(this.inputAreaEl, {
			onSend: (text: string) => this.send(text),
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
				if (!this.controller?.getSessionId() || !client) return;
				void client.setMode(this.controller.getSessionId()!, agent).then(() => this.controller.loadToolbarOptions()).catch(() => {});
			},
			onModelChange: (model: string) => {
				const client = this.plugin.getClient();
				if (!this.controller?.getSessionId() || !client) return;
				void client.setModel(this.controller.getSessionId()!, model).then(() => this.controller.loadToolbarOptions()).catch(() => {});
			},
			onEffortChange: (effort: string) => {
				const client = this.plugin.getClient();
				if (!this.controller?.getSessionId() || !client) return;
				void client.setConfigOption(this.controller.getSessionId()!, 'effort', effort).then(() => this.controller.loadToolbarOptions()).catch(() => {});
			},
			onSend: () => this.input.triggerSend(),
			onStop: () => this.input.triggerStop(),
		});

		// ── Create controller ──
		const deps: ControllerDeps = {
			renderer: this.renderer,
			input: this.input,
			toolbar: this.toolbar,
			inlineEditPanel: this.inlineEditPanel,
			permissionBanner: this.permissionBanner,
			mention: this.mention,
			resolver: this.resolver,
			syncEngine: this.syncEngine,
			sessionStore: this.sessionStore,
			welcomeView: this.welcomeView,
			plugin: this.plugin,
		};

		const savedSessionId = this.sessionStore.activeId;
		const callbacks: ControllerCallbacks = {
			onShowWelcome: (connected: boolean) => {
				if (this.messagesEl.children.length === 0) {
					this.welcomeView.show(connected);
				}
			},
			onHideWelcome: () => this.welcomeView.hide(),
			onShowReconnectBtn: () => this.showReconnectBtn(),
			onHideReconnectBtn: () => this.hideReconnectBtn(),
			onShowNewMessagesBtn: () => this.showNewMessagesBtn(),
			onHideNewMessagesBtn: () => this.hideNewMessagesBtn(),
			onScrollToBottom: () => this.renderer.forceScrollToBottom(),
			onClearUI: () => {
				this.closeAutocomplete();
				this.currentRefs = [];
				this.pendingImageParts = [];
				if (this.dragDropManager) this.dragDropManager.resetBytes();
				this.manualRefs.clear();
				this.lastAutoRefId = null;
				this.mention.clear();
			},
			onClearChips: () => this.contextChipsEl.empty(),
			onClearPendingImageChips: () => this.clearPendingImageChips(),
			onAutoRefActiveFile: () => this.autoRefActiveFile(),
		};

		this.controller = new CopsidianViewController(deps, callbacks);

		// Restore session ID into controller state
		if (savedSessionId) {
			this.controller.state.sessionId = savedSessionId;
		}
		this.controller.state.autoScrollEnabled = this.plugin.settings.autoScrollEnabled ?? true;

		// Session dropdown
		this.newSessionBtnEl.onclick = () => this.newSession();
		this.sessionButtonEl.onclick = () => this.toggleSessions();
		this.sessionDropdownMgr = new SessionDropdown(
			this.contentEl,
			this.sessionButtonEl,
			this.sessionStore,
			() => this.controller.getSessionId(),
			{
				onSwitch: async (sessionId: string) => {
					this.closeSessionDropdown();
					await this.controller.switchSession(sessionId);
				},
				onDelete: async (sessionId: string) => {
					this.closeSessionDropdown();
					await this.controller.deleteSession(sessionId);
				},
				onNewSession: async () => this.newSession(),
				onFork: async (sessionId: string) => {
					await this.controller.forkSession(sessionId);
					this.closeSessionDropdown();
				},
				onResume: async (sessionId: string) => {
					await this.controller.resumeSession(sessionId);
					this.closeSessionDropdown();
				},
			},
			() => this.plugin.getClient()?.getAgentCapabilities() ?? null,
		);

		// Init connection
		const connectedClient = this.plugin.getClient();
		this.controller.state.isConnected = connectedClient?.isConnected() ?? false;
		if (this.controller.state.isConnected) {
			this.controller.bindClientHandlers();
			void this.controller.syncRuntimeSession(this.controller.getSessionId()).catch((e) => {
				console.error('[copsidian] session sync:', e);
			});
		} else if (this.plugin.settings.autoConnect) {
			void this.controller.ensureClientConnected();
		}

		// Restore previous messages if any
		await this.controller.restoreSession();

		// Load toolbar options when an ACP client is already available.
		this.controller.loadToolbarOptions();

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
			onCopyLastMessage: () => this.controller.copyLastAssistantMessage(),
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
		await this.controller.cancelActiveGeneration();
		this.clearAutoRefs();
		this.controller.resetConversationView();
		if (this.messagesEl.children.length === 0) {
			this.welcomeView.show(this.plugin.getClient() !== null);
		}
	}

	// ── Smart Auto-scroll ──

	private setupSmartScroll(): void {
		this.scrollHandler = () => {
			const { scrollTop, clientHeight, scrollHeight } = this.messagesEl;
			const nearBottom = scrollTop + clientHeight >= scrollHeight - 50;

			if (!nearBottom && this.controller.state.autoScrollEnabled) {
				this.controller.state.autoScrollEnabled = false;
				this.showNewMessagesBtn();
			} else if (nearBottom && !this.controller.state.autoScrollEnabled) {
				this.controller.state.autoScrollEnabled = true;
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
			this.controller.state.autoScrollEnabled = true;
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
		this.controller.state.autoScrollEnabled = enabled;
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

	// ── Reconnect button (view-owned DOM) ──

	private showReconnectBtn(): void {
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
			await this.controller.reconnect();
			this.hideReconnectBtn();
		} catch {
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

	private async newSession(): Promise<void> {
		await this.controller.newSession();
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

	private async send(text: string): Promise<void> {
		await this.controller.send(text, this.currentRefs);
	}

	private async stopGeneration(): Promise<void> {
		await this.controller.stopGeneration();
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
			for (const cmd of this.controller.state.availableCommands) {
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
		await this.send(prompt);
	}
}
