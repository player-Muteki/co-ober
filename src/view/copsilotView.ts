import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import type CopsilotPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { ContextRef, PromptPart } from '../types';
import { t } from '../i18n/index';
import { ChatRenderer } from './renderer';
import { ChatInput } from '../chat/input';
import { InputToolbar } from '../chat/toolbar';
import type { UsageInfo } from '../types';
import { ContextMention } from '../context/mention';
import { ContextResolver } from '../context/resolver';
import { SyncEngine } from '../sync/engine';
import { createSessionStore } from '../chat/session';
import type { SessionStore } from '../chat/session';
import { SessionDropdown } from './sessionDropdown';
import { commandRegistry } from '../commands/registry';
import { Autocomplete } from './autocomplete';
import { DragDropManager } from './dragDropManager';
import { PermissionBanner } from './permissionBanner';
import { InlineEditPanel } from './inlineEditPanel';
import { WelcomeView } from './welcomeView';
import { KeybindingManager } from './keybindingManager';
import { CopsilotViewController } from './copsilotViewController';
import type { ControllerCallbacks, ControllerDeps } from './copsilotViewController';

interface MarkdownFileView {
	getViewType(): string;
	file?: TFile | null;
}

export class CopsilotView extends ItemView {
	private static clipIdCounter = 0;
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
	private controller!: CopsilotViewController;

	// Context arc meter (in header)
	private meterEl!: HTMLDivElement;
	private meterArcFill!: SVGCircleElement;
	private meterPctEl!: HTMLSpanElement;

	// Event listener references for cleanup on close
	private scrollHandler: (() => void) | null = null;

	private get doc(): Document { return this.contentEl?.ownerDocument ?? activeDocument; }

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: CopsilotPlugin,
	) { super(leaf); }

	override getViewType(): string { return VIEW_TYPE; }
	override getDisplayText(): string { return t().appName; }
	override getIcon(): string { return 'terminal-square'; }

	override async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.addClass('copsilot-view');

		// Init core modules
		this.mention = new ContextMention(this.plugin.app);
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
		const header = el.createDiv({ cls: 'copsilot-header' });

		this.headerTitleEl = header.createDiv({ text: t().appName, cls: 'copsilot-header-title' });

		// Context arc meter (right of title)
		this.meterEl = header.createDiv({ cls: 'copsilot-arc-meter' });
		const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 40 24');
		svg.setAttribute('class', 'copsilot-arc-svg');
		const R = 18;
		const C = 20;
		const ARC_LEN = Math.PI * R;
		const track = this.doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		track.setAttribute('d', `M ${C - R} ${C} A ${R} ${R} 0 0 1 ${C + R} ${C}`);
		track.setAttribute('class', 'copsilot-arc-track');
		svg.appendChild(track);
		const defs = this.doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const clipPath = this.doc.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
		const arcClipId = `arc-clip-${CopsilotView.clipIdCounter++}`;
		clipPath.setAttribute('id', arcClipId);
		const clipRect = this.doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
		clipRect.setAttribute('y', '20');
		clipRect.setAttribute('width', '40');
		clipRect.setAttribute('height', '24');
		clipPath.appendChild(clipRect);
		defs.appendChild(clipPath);
		svg.appendChild(defs);
		this.meterArcFill = this.doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
		this.meterArcFill.setAttribute('cx', String(C));
		this.meterArcFill.setAttribute('cy', String(C));
		this.meterArcFill.setAttribute('r', String(R));
		this.meterArcFill.setAttribute('class', 'copsilot-arc-fill');
		this.meterArcFill.setAttribute('stroke-dasharray', `0 ${ARC_LEN}`);
		this.meterArcFill.setAttribute('clip-path', `url(#${arcClipId})`);
		svg.appendChild(this.meterArcFill);
		this.meterEl.appendChild(svg);
		this.meterPctEl = this.meterEl.createSpan({ cls: 'copsilot-arc-pct' });
		this.meterPctEl.setText('—');
		this.meterEl.addClass('empty');

		const actions = header.createDiv({ cls: 'copsilot-header-actions' });
		this.newSessionBtnEl = actions.createEl('button', { text: t().header.new, cls: 'mod-icon' });
		this.sessionButtonEl = actions.createEl('button', { text: '⋯', cls: 'mod-icon' });

		// ── Messages ──
		this.messagesEl = el.createDiv({ cls: 'copsilot-messages' });
		this.renderer = new ChatRenderer(this.messagesEl, this.plugin.app, () => this.controller?.state.autoScrollEnabled ?? true);

		this.permissionBanner = new PermissionBanner(this.messagesEl);
		this.inlineEditPanel = new InlineEditPanel(this.contentEl);
		this.welcomeView = new WelcomeView(this.messagesEl, () => this.plugin.getClient()?.getAgentCapabilities() ?? null);

		// ── Context chips ──
		this.contextChipsEl = el.createDiv({ cls: 'copsilot-context-chips' });

		// ── Input ──
		this.inputAreaEl = el.createDiv({ cls: 'copsilot-input-area' });
		this.input = new ChatInput(this.inputAreaEl, {
			onSend: (text: string) => { void this.send(text); },
			onStop: () => { void this.stopGeneration(); },
			onCycleMode: (direction) => {
				if (direction === 1) this.toolbar.cycleMode();
				else this.toolbar.cycleModeReverse();
			},
			onToggleMention: () => this.showAC('@'),
			onToggleSlash: () => this.showAC('/'),
			onAddRef: (ref: ContextRef) => this.addChip(ref, 'manual'),
			onRemoveRef: (id: string) => this.removeChip(id),
		});
		this.autocomplete = new Autocomplete(this.inputAreaEl, {
			onSelect: (value: string, mode: '@' | '/') => this.handleACSelect(value, mode),
		});

		// ── Toolbar (below input) ──
		const tbEl = el.createDiv({ cls: 'copsilot-toolbar' });
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
			onPermissionChange: (mode: string) => {
				this.plugin.settings.permissionMode = mode as import('../types').PermissionLevel;
				void this.plugin.savePluginData();
				const client = this.plugin.getClient();
				if (client) client.permissionMode = mode as import('../types').PermissionLevel;
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
			updateContextMeter: (usage) => this.updateContextMeter(usage),
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

		this.controller = new CopsilotViewController(deps, callbacks);

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

		// Init connection - always try to connect when view opens
		const connectedClient = this.plugin.getClient();
		this.controller.state.isConnected = connectedClient?.isConnected() ?? false;
		if (this.controller.state.isConnected) {
			this.controller.bindClientHandlers();
			void this.controller.syncRuntimeSession(this.controller.getSessionId()).catch((e) => {
				console.error('[copsilot] session sync:', e);
			});
		} else {
			// Always try to connect when view opens, not just when autoConnect is true
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
					cls: 'copsilot-chip',
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

	override async onClose(): Promise<void> {
		await this.controller?.stopGeneration();
		this.controller?.dispose();
		this.input?.dispose();
		this.toolbar?.dispose();
		this.permissionBanner?.dispose();
		this.renderer?.dispose();
		this.closeSessionDropdown();
		this.closeAutocomplete();
		this.keybindingMgr?.unregister();
		this.unregisterEventListeners();
		this.contextChipsEl?.remove();
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
			cls: 'copsilot-new-messages-btn',
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
			cls: 'copsilot-reconnect-btn',
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
		this.contextChipsEl.querySelectorAll('.copsilot-chip').forEach((el) => {
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
		const chip = this.contextChipsEl.createDiv({ cls: 'copsilot-chip' });
		chip.dataset.refId = ref.id;
		chip.title = ref.path;
		const label = ref.path !== ref.name ? `${ref.name} (${ref.path})` : ref.name;
		chip.createSpan({ text: `@${label}` });
		const x = chip.createSpan({ cls: 'chip-remove', text: '×' });
		x.onclick = (e: MouseEvent) => { e.stopPropagation(); this.removeChip(ref.id); };
	}

	private removeChip(id: string): void {
		this.currentRefs = this.currentRefs.filter(r => r.id !== id);
		if (this.mention.hasRef(id)) this.mention.removeRef(id);
		this.manualRefs.delete(id);
		this.contextChipsEl.querySelectorAll('.copsilot-chip').forEach(el => {
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
		const allItems: Array<{ value: string; label: string; description?: string; category?: string; badge?: string }> = [];

		if (mode === '@') {
			const notes = this.mention.listAllNotes();
			const selectedRefs = this.mention.getAllRefs();
			const selectedPaths = new Set(selectedRefs.map(r => r.id));
			for (const n of notes) {
				const folder = n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : '';
				allItems.push({
					value: n.path,
					label: `${folder ? folder + '/' : ''}@${n.name}`,
					description: n.name,
					category: folder || 'root',
					badge: selectedPaths.has(n.path) ? '✓' : undefined,
				});
			}
		} else {
			// Use the command registry (builtins + ACP synced)
			const all = commandRegistry.getAll();
			for (const cmd of all) {
				allItems.push({
					value: cmd.trigger,
					label: `/${cmd.trigger}`,
					description: cmd.description,
					category: cmd.type === 'builtin' ? cmd.category : 'agent',
					badge: cmd.type === 'builtin' ? undefined : cmd.type.toUpperCase(),
				});
			}
			// Fallback: show ACP available commands not yet in registry
			if (all.length === 0) {
				for (const cmd of this.controller.state.availableCommands) {
					allItems.push({ value: cmd.name, label: `/${cmd.name}`, description: cmd.description });
				}
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

	// ── Context arc meter (in header) ──

	updateContextMeter(usage: UsageInfo | null): void {
		const R = 18;
		const ARC_LEN = Math.PI * R;

		if (!usage || (!usage.contextTokens && usage.totalTokens <= 0)) {
			this.meterEl.addClass('empty');
			this.meterEl.removeClass('warning', 'critical');
			this.meterPctEl.setText('—');
			this.meterArcFill.setAttribute('stroke-dasharray', `0 ${ARC_LEN}`);
			this.meterEl.removeAttribute('data-tooltip');
			return;
		}

		this.meterEl.removeClass('empty');

		const used = usage.contextTokens ?? usage.totalTokens ?? 0;
		const contextWindow = usage.contextWindow ?? 0;
		const pct = contextWindow > 0 ? Math.min(100, Math.round((used / contextWindow) * 100)) : 0;

		const filled = (pct / 100) * ARC_LEN;
		this.meterArcFill.setAttribute('stroke-dasharray', `${filled} ${ARC_LEN}`);

		this.meterPctEl.setText(`${pct}%`);

		this.meterEl.removeClass('warning', 'critical');
		if (pct >= 90) {
			this.meterEl.addClass('critical');
		} else if (pct >= 75) {
			this.meterEl.addClass('warning');
		}

		const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
		const tooltip = [
			`Context: ${fmt(used)} / ${fmt(contextWindow)} tokens`,
			`Input: ${fmt(usage.inputTokens)}`,
			usage.thoughtTokens ? `Thinking: ${fmt(usage.thoughtTokens)}` : '',
			`Output: ${fmt(usage.outputTokens)}`,
			pct >= 80 ? '⚠ Approaching limit — run /compact' : '',
		].filter(Boolean).join('\n');
		this.meterEl.setAttribute('data-tooltip', tooltip);
	}
}