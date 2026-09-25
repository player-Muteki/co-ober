import { ItemView, Notice, WorkspaceLeaf, TFile, setIcon } from 'obsidian';
import type CoOberPlugin from '../main';
import { VIEW_TYPE } from '../types';
import type { ContextRef, PromptPart, StoredDraft } from '../types';
import { t } from '../i18n/index';
import {
  SCROLL_NEAR_BOTTOM_THRESHOLD,
  CONTEXT_METER_WARNING_PCT,
  CONTEXT_METER_CRITICAL_PCT,
  K_FORMAT_THRESHOLD,
} from '../constants';
import { ChatRenderer, contextPercentage } from './renderer';
import { ChatInput } from '../chat/input';
import { InputToolbar } from '../chat/toolbar';
import type { UsageInfo } from '../types';
import { ContextMention } from '../context/mention';
import { ContextResolver } from '../context/resolver';
import { SyncEngine } from '../sync/engine';
import type { SessionStore } from '../chat/session';
import { SessionDropdown } from './sessionDropdown';
import { listNativeSessions, searchNativeSessions } from '../opencode/NativeSessionReader';
import { applyPermissionTier } from '../client/permissionTier';
import { resolveCommandPath } from '../utils/commandResolution';
import { commandRegistry } from '../commands/registry';
import { FileCommandStorage } from '../commands/storage/FileCommandStorage';
import { Autocomplete } from './autocomplete';
import { DragDropManager } from './dragDropManager';
import { PermissionBanner } from './permissionBanner';
import { InlineEditPanel } from './inlineEditPanel';
import { SideChatPanel, type SideChatAsk } from './sideChatPanel';
import { WelcomeView } from './welcomeView';
import { KeybindingManager } from './keybindingManager';
import { TabBar } from './tabBar';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps, TabPanel } from './CoOberViewController';

interface MarkdownFileView {
  getViewType(): string;
  file?: TFile | null;
}

/** One tab's message surface: its scroll box, renderer and scroll listener. */
interface TabPanelRecord {
  el: HTMLDivElement;
  renderer: ChatRenderer;
  onScroll: () => void;
}

/** A composer image awaiting send: the part plus what removal needs. */
interface ImageEntry {
  part: PromptPart;
  data: string;
  name: string;
  size: number;
}

/** Per-tab composer memory: the draft text with its note and image chips. */
interface ComposerDraft {
  text: string;
  refs: ContextRef[];
  manualRefs: Set<string>;
  lastAutoRefId: string | null;
  images: ImageEntry[];
}

/**
 * The storable half of a draft: text plus note references (their bodies are
 * re-read from the vault at send). An empty box stores nothing; staged images
 * are counted so the restore can say what it left behind.
 */
function storedDraft(draft: ComposerDraft): StoredDraft | undefined {
  const refs = draft.refs.map(({ id, type, name, path }) => ({ id, type, name, path }));
  const manual = [...draft.manualRefs];
  if (!draft.text.trim() && refs.length === 0 && draft.images.length === 0) return undefined;
  const stored: StoredDraft = { text: draft.text };
  if (refs.length > 0) stored.refs = refs;
  if (manual.length > 0) stored.manual = manual;
  if (draft.images.length > 0) stored.images = draft.images.length;
  return stored;
}

export class CoOberView extends ItemView {
  private static clipIdCounter = 0;
  private tabStackEl!: HTMLDivElement;
  private tabBar: TabBar | null = null;
  // Aliases for the active tab's panel — kept in sync on every tab switch.
  private messagesEl!: HTMLDivElement;
  private renderer!: ChatRenderer;
  private panels = new Map<string, TabPanelRecord>();
  private newMessagesBtns = new Map<string, HTMLButtonElement | null>();
  private drafts = new Map<string, ComposerDraft>();
  private contextChipsEl!: HTMLDivElement;
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
  private keybindingMgr!: KeybindingManager;
  private dragDropManager!: DragDropManager;
  private permissionBanner!: PermissionBanner;
  private fileCommandSource: FileCommandStorage | null = null;
  private inlineEditPanel!: InlineEditPanel;
  /** One /btw panel per tab that asked for a scratch thread; only one is visible. */
  private sideChatPanels = new Map<string, SideChatPanel>();
  private pendingImageParts: ImageEntry[] = [];
  private lastAutoRefId: string | null = null;
  private headerTitleEl: HTMLDivElement | null = null;
  private newSessionBtnEl: HTMLButtonElement | null = null;
  private controller!: CoOberViewController;
  private readonly handlePersistenceOutcome = (failed: boolean): void => {
    this.reportPersistence(failed);
  };

  // Context arc meter (in header)
  private meterEl!: HTMLDivElement;
  private meterArcFill!: SVGCircleElement;
  private meterPctEl!: HTMLSpanElement;

  // Event listener references for cleanup on close
  private pasteHandler: ((e: ClipboardEvent) => void) | null = null;
  private imageFileInputEl: HTMLInputElement | null = null;

  private get doc(): Document {
    return this.contentEl?.ownerDocument ?? activeDocument;
  }

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: CoOberPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }
  override getDisplayText(): string {
    return t().appName;
  }
  override getIcon(): string {
    return 'terminal-square';
  }

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass('co-ober-view');

    // Init core modules
    this.mention = new ContextMention(this.plugin.app);
    this.resolver = new ContextResolver(this.plugin.app.vault, this.plugin.settings.maxNoteSize);
    this.syncEngine = new SyncEngine(this.plugin.app.vault, this.plugin.settings.syncRules);
    this.sessionStore = this.plugin.sessionStore;

    // Register file-based commands from .opencode/commands/*.md
    // (unregistered in onClose: the registry is a singleton, re-registering
    // on every reopen would stack duplicate vault watchers.)
    this.fileCommandSource = new FileCommandStorage(this.plugin.app.vault);
    commandRegistry.registerSource(this.fileCommandSource);

    // Restore active session
    const savedId = this.sessionStore.activeId;
    if (savedId) {
      const saved = this.sessionStore.get(savedId);
      if (saved) {
        const sessionId = saved.opencodeSessionId ?? savedId;
        this.sessionStore.getOrCreate(sessionId);
        this.sessionStore.setActive(sessionId);
      }
    }

    // ── Header ──
    const header = el.createDiv({ cls: 'co-ober-header' });

    this.headerTitleEl = header.createDiv({ text: t().appName, cls: 'co-ober-header-title' });

    // Context arc meter (right of title)
    this.meterEl = header.createDiv({ cls: 'co-ober-arc-meter' });
    this.meterEl.setAttribute('role', 'meter');
    this.meterEl.setAttribute('aria-label', t().usage.contextMeterAria);
    const svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 40 24');
    svg.setAttribute('class', 'co-ober-arc-svg');
    const R = 18;
    const C = 20;
    const ARC_LEN = Math.PI * R;
    const track = this.doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    track.setAttribute('d', `M ${C - R} ${C} A ${R} ${R} 0 0 1 ${C + R} ${C}`);
    track.setAttribute('class', 'co-ober-arc-track');
    svg.appendChild(track);
    const defs = this.doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const clipPath = this.doc.createElementNS('http://www.w3.org/2000/svg', 'clipPath');
    const arcClipId = `arc-clip-${CoOberView.clipIdCounter++}`;
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
    this.meterArcFill.setAttribute('class', 'co-ober-arc-fill');
    this.meterArcFill.setAttribute('stroke-dasharray', `0 ${ARC_LEN}`);
    this.meterArcFill.setAttribute('clip-path', `url(#${arcClipId})`);
    svg.appendChild(this.meterArcFill);
    this.meterEl.appendChild(svg);
    this.meterPctEl = this.meterEl.createSpan({ cls: 'co-ober-arc-pct' });
    this.meterPctEl.setText('—');
    this.meterEl.addClass('empty');

    const actions = header.createDiv({ cls: 'co-ober-header-actions' });
    this.newSessionBtnEl = actions.createEl('button', { cls: 'mod-icon' });
    setIcon(this.newSessionBtnEl, 'plus-circle');
    this.newSessionBtnEl.setAttribute('aria-label', t().header.newSession);
    this.newSessionBtnEl.title = t().header.newSession;
    this.sessionButtonEl = actions.createEl('button', { cls: 'mod-icon' });
    setIcon(this.sessionButtonEl, 'history');
    this.sessionButtonEl.setAttribute('aria-label', t().header.sessionHistory);
    this.sessionButtonEl.title = t().header.sessionHistory;

    // ── Tab strip (one badge per open conversation) ──
    this.tabBar = new TabBar(el, {
      onSelect: (tabId) => this.controller?.switchToTab(tabId),
      onClose: (tabId) => void this.controller?.closeTab(tabId),
      onNew: () => void this.controller?.newSession(true),
    });

    // ── Tab stack (message panels live here, one per open conversation) ──
    this.tabStackEl = el.createDiv({ cls: 'co-ober-tab-stack' });
    this.permissionBanner = new PermissionBanner(this.tabStackEl);
    this.inlineEditPanel = new InlineEditPanel(this.contentEl);
    this.welcomeView = new WelcomeView(this.tabStackEl, () => this.plugin.getClient()?.getAgentCapabilities() ?? null);

    // ── Context chips ──
    this.contextChipsEl = el.createDiv({ cls: 'co-ober-context-chips' });

    // ── Queue indicator ──
    const queueIndicatorEl = el.createDiv({ cls: 'co-ober-queue-indicator' });

    // ── Input ──
    this.inputAreaEl = el.createDiv({ cls: 'co-ober-input-area' });
    this.input = new ChatInput(this.inputAreaEl, {
      onSend: (text: string) => {
        void this.send(text);
      },
      onStop: () => {
        void this.stopGeneration();
      },
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
    const tbEl = el.createDiv({ cls: 'co-ober-toolbar' });
    this.toolbar = new InputToolbar(tbEl, {
      onAgentChange: (agent: string) => {
        const client = this.plugin.getClient();
        if (!this.controller?.getSessionId() || !client) return;
        void client
          .setMode(this.controller.getSessionId()!, agent)
          .then(() => this.controller.loadToolbarOptions())
          .catch((e: unknown) => this.reportSettingFailure(e));
      },
      onModelChange: (model: string) => {
        const client = this.plugin.getClient();
        if (!this.controller?.getSessionId() || !client) return;
        void client
          .setModel(this.controller.getSessionId()!, model)
          .then(() => this.controller.loadToolbarOptions())
          .catch((e: unknown) => this.reportSettingFailure(e));
      },
      onEffortChange: (effort: string) => {
        const client = this.plugin.getClient();
        if (!this.controller?.getSessionId() || !client) return;
        void client
          .setConfigOption(this.controller.getSessionId()!, 'effort', effort)
          .then(() => this.controller.loadToolbarOptions())
          .catch((e: unknown) => this.reportSettingFailure(e));
      },
      onPermissionChange: (mode: string) => {
        this.plugin.settings.permissionMode = mode as import('../types').PermissionLevel;
        void this.plugin.savePluginData();
        const client = this.plugin.getClient();
        if (client) {
          client.permissionMode = mode as import('../types').PermissionLevel;
          applyPermissionTier(client, this.plugin.settings.permissionMode, this.plugin.settings);
        }
      },
      onSend: () => this.input.triggerSend(),
      onStop: () => this.input.triggerStop(),
      onAttachImage: () => this.openImagePicker(),
    });

    // ── Create controller ──
    const deps: ControllerDeps = {
      input: this.input,
      toolbar: this.toolbar,
      inlineEditPanel: this.inlineEditPanel,
      permissionBanner: this.permissionBanner,
      mention: this.mention,
      resolver: this.resolver,
      syncEngine: this.syncEngine,
      sessionStore: this.sessionStore,
      welcomeView: this.welcomeView,
      runtime: this.plugin,
      updateContextMeter: (usage) => this.updateContextMeter(usage),
      createTabPanel: (tabId) => this.createTabPanel(tabId),
      disposeTabPanel: (tabId) => this.disposeTabPanel(tabId),
      onActiveTabChanged: (prevTabId, tabId) => this.onActiveTabChanged(prevTabId, tabId),
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
        this.pendingImageParts.length = 0;
        if (this.dragDropManager) this.dragDropManager.resetBytes();
        this.manualRefs.clear();
        this.lastAutoRefId = null;
        this.mention.clear();
      },
      onClearChips: () => this.contextChipsEl.empty(),
      getPendingImageParts: () => this.pendingImageParts.map((e) => e.part),
      onClearPendingImageChips: () => this.clearPendingImageChips(),
      onAutoRefActiveFile: () => this.autoRefActiveFile(),
      onOpenSessions: () => {
        void this.toggleSessions();
      },
      onOpenSideChat: (ask, question, tabId) => this.showSideChat(ask, question, tabId),
      onCloseSideChat: (tabId) => this.sideChatPanels.get(tabId)?.close(),
      onTabsChanged: () => this.refreshTabBar(),
      onCollectDrafts: () => this.collectDrafts(),
      onRestoreDrafts: (drafts) => this.installDrafts(drafts),
    };

    this.controller = new CoOberViewController(deps, callbacks);
    // Only this view's tabs should hear about the shared write, and only while
    // it is open: a detached view would paint into panels that are gone.
    this.plugin.onPersistenceOutcome = this.handlePersistenceOutcome;
    // The controller constructor opened the first tab panel and set the
    // active-panel aliases; the welcome view follows the active panel.
    this.welcomeView.reparent(this.messagesEl);

    // Store queue indicator reference on controller
    this.controller.queueIndicatorEl = queueIndicatorEl;

    // Rebuild yesterday's strip: tabs become panels first, the stored front
    // tab comes forward, and only it reads its transcript back (see
    // restoreActiveTab). A pre-tab session survives as a single shell.
    const shell = this.sessionStore.tabShell();
    const shells = shell.openTabs.length > 0
      ? shell.openTabs
      : savedSessionId
        ? [{ tabId: 'tab-restored', sessionId: savedSessionId }]
        : [];
    this.controller.restoreTabShells(shells, shell.activeTabId);

    // Session dropdown
    this.newSessionBtnEl.onclick = () => this.newSession();
    this.sessionButtonEl.onclick = () => this.toggleSessions();
    this.sessionDropdownMgr = new SessionDropdown(
      this.contentEl,
      this.sessionButtonEl,
      this.sessionStore,
      () => this.controller.getSessionId(),
      {
        onSwitch: async (sessionId: string, source?: 'local' | 'opencode') => {
          this.closeSessionDropdown();
          await this.controller.switchSession(sessionId, source);
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
        onRename: async (sessionId: string, newTitle: string) => {
          await this.controller.renameSession(sessionId, newTitle);
        },
        onTogglePin: async (sessionId: string, pinned: boolean) => {
          this.sessionStore.setPinned(sessionId, pinned);
          await this.sessionStore.save();
        },
      },
      () => this.plugin.getClient()?.getAgentCapabilities() ?? null,
      async () => listNativeSessions(this.plugin.getVaultCwd()),
      async (query) => searchNativeSessions(this.plugin.getVaultCwd(), query),
    );

    // Init connection: auto-connect when the setting is on, otherwise leave
    // the manual reconnect button as the entry point.
    const connectedClient = this.plugin.getClient();
    this.controller.state.isConnected = connectedClient?.isConnected() ?? false;
    if (this.controller.state.isConnected) {
      this.controller.bindClientHandlers();
      void this.controller.syncRuntimeSession(this.controller.getSessionId()).catch((e) => {
        console.error('[co-ober] session sync:', e);
        this.controller.notifyLostSession(e);
      });
    } else if (this.plugin.settings.autoConnect) {
      // Spawn-attempting a binary that is not anywhere on disk only yields a
      // generic failure notice; name the missing command and offer the button.
      const cmd = this.plugin.settings.opencodePath;
      if (resolveCommandPath(cmd) === null) {
        new Notice(t().notice.binaryNotFound.replace('{cmd}', cmd));
        this.showReconnectBtn();
      } else {
        void this.controller.ensureClientConnected();
      }
    } else {
      this.showReconnectBtn();
    }

    // Paint the conversation in front (and only that one) back onto its panel.
    await this.controller.restoreActiveTab();
    this.refreshTabBar();

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
      onSwitchTab: (index) => this.controller.switchToTabByIndex(index),
    });
    this.keybindingMgr.register();

    // Setup drag and drop (on the tab stack: every panel is a drop target)
    this.dragDropManager = new DragDropManager(
      this.tabStackEl,
      this.tabStackEl,
      {
        onAddNoteRef: (ref) => this.addChip(ref, 'manual'),
        onAddImagePart: (data, mimeType, size, name) => {
          // Keep the exact entry identity: two chips carrying byte-identical
          // images must not collapse into each other on removal.
          const part: PromptPart = { type: 'image', mimeType, data };
          const entry = { part, data, name, size };
          this.pendingImageParts.push(entry);
          this.createImageChip(entry);
        },
        onRemoveImagePart: (_data, _size) => {},
      },
      () => this.plugin.getClient()?.getAgentCapabilities() ?? null,
    );
    this.dragDropManager.setup();

    // Paste images into the composer
    this.pasteHandler = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files?.length || !this.dragDropManager) return;
      const hasImage = Array.from(files).some((f) => f.type.startsWith('image/'));
      if (!hasImage) return;
      e.preventDefault();
      void this.dragDropManager.handleFiles(files);
    };
    this.input.textareaEl.addEventListener('paste', this.pasteHandler);
  }

  /** Pass the plugin's write outcome on to the tabs that would show it. */
  reportPersistence(failed: boolean): void {
    this.controller?.reportPersistence(failed);
  }

  override async onClose(): Promise<void> {
    if (this.plugin.onPersistenceOutcome === this.handlePersistenceOutcome) {
      this.plugin.onPersistenceOutcome = null;
    }
    if (this.fileCommandSource) {
      commandRegistry.unregisterSource(this.fileCommandSource);
      this.fileCommandSource = null;
    }
    // Last chance to keep what was typed: the tab on screen still holds its
    // draft in the textarea, and dispose below takes the panels with it.
    this.controller?.persistTabShell();
    try {
      await this.sessionStore.save();
    } catch {
      // Closing the panel must not fail over a write; unload retries.
    }
    await this.controller?.cancelAllStreams();
    await this.controller?.dispose();
    this.input?.dispose();
    this.toolbar?.dispose();
    this.permissionBanner?.dispose();
    this.welcomeView?.dispose();
    this.inlineEditPanel?.dispose();
    for (const panel of [...this.sideChatPanels.values()]) panel.close();
    this.sideChatPanels.clear();
    for (const tabId of [...this.panels.keys()]) this.disposeTabPanel(tabId);
    this.tabBar?.dispose();
    this.tabBar = null;
    this.closeSessionDropdown();
    this.closeAutocomplete();
    this.keybindingMgr?.unregister();
    this.unregisterEventListeners();
    this.contextChipsEl?.remove();
  }

  private unregisterEventListeners(): void {
    if (this.dragDropManager) {
      this.dragDropManager.teardown();
    }
    if (this.pasteHandler && this.input) {
      this.input.textareaEl.removeEventListener('paste', this.pasteHandler);
      this.pasteHandler = null;
    }
    if (this.imageFileInputEl) {
      this.imageFileInputEl.remove();
      this.imageFileInputEl = null;
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

  // ── Tab panels ──

  /** Repaint the strip from the controller's live tab list. */
  refreshTabBar(): void {
    const controller = this.controller;
    if (!controller || !this.tabBar) return;
    this.tabBar.render(controller.tabDescriptors(), controller.maxOpenTabs());
  }

  /** Builds one conversation surface; the controller calls this per runtime. */
  private createTabPanel(tabId: string): TabPanel {
    const panelEl = this.tabStackEl.createDiv({ cls: 'co-ober-messages co-ober-tab-panel' });
    const renderer = new ChatRenderer(
      panelEl,
      this.plugin.app,
      () => this.controller?.runtimeForTab(tabId)?.state.autoScrollEnabled ?? true,
    );
    renderer.setRewindHandlers({
      onRegenerate: (ordinal) => {
        void this.controller.rewindUserTurn(ordinal);
      },
      onEditResend: (ordinal, text) => {
        void this.controller.rewindUserTurn(ordinal, text);
      },
    });
    const onScroll = (): void => {
      const rt = this.controller?.runtimeForTab(tabId);
      if (!rt) return;
      const { scrollTop, clientHeight, scrollHeight } = panelEl;
      const nearBottom = scrollTop + clientHeight >= scrollHeight - SCROLL_NEAR_BOTTOM_THRESHOLD;
      if (!nearBottom && rt.state.autoScrollEnabled) {
        rt.state.autoScrollEnabled = false;
        this.showNewMessagesBtn(tabId);
      } else if (nearBottom && !rt.state.autoScrollEnabled) {
        rt.state.autoScrollEnabled = true;
        this.hideNewMessagesBtn(tabId);
      }
    };
    panelEl.addEventListener('scroll', onScroll);
    // The first panel opens visible (it is the active tab by construction);
    // later panels are created backgrounded and stay hidden until activated.
    const first = this.panels.size === 0;
    this.panels.set(tabId, { el: panelEl, renderer, onScroll });
    if (!first) panelEl.addClass('co-ober-tab-panel-hidden');
    else {
      this.messagesEl = panelEl;
      this.renderer = renderer;
    }
    return { renderer };
  }

  private disposeTabPanel(tabId: string): void {
    const rec = this.panels.get(tabId);
    if (!rec) return;
    rec.el.removeEventListener('scroll', rec.onScroll);
    rec.renderer.dispose();
    rec.el.remove();
    this.panels.delete(tabId);
    this.newMessagesBtns.get(tabId)?.remove();
    this.newMessagesBtns.delete(tabId);
    this.drafts.delete(tabId);
  }

  private onActiveTabChanged(prevTabId: string | null, tabId: string): void {
    const next = this.panels.get(tabId);
    if (!next) return;
    if (prevTabId && prevTabId !== tabId) {
      this.saveDraft(prevTabId);
      this.panels.get(prevTabId)?.el.addClass('co-ober-tab-panel-hidden');
      this.hideNewMessagesBtn(prevTabId);
    }
    next.el.removeClass('co-ober-tab-panel-hidden');
    this.messagesEl = next.el;
    this.renderer = next.renderer;
    // Each scratch thread stays with the tab it was asked from: switch away and
    // it is only out of sight, switch back and its answers are still there.
    for (const [owner, panel] of this.sideChatPanels) {
      if (owner === tabId) panel.show();
      else panel.hide();
    }
    // Hide before the emptiness check: the welcome element itself lives inside
    // the panel, so a visible welcome would make every panel look non-empty.
    this.welcomeView.hide();
    this.welcomeView.reparent(next.el);
    this.restoreDraft(tabId);
    if (next.el.children.length === 0) {
      this.welcomeView.show(this.plugin.getClient() !== null);
    }
    // The outgoing tab's button is hidden on switch; a tab the reader scrolled
    // up in must come back offering the jump to latest — and only after the
    // emptiness check, since the button is a panel child too.
    const incoming = this.controller?.runtimeForTab(tabId);
    if (incoming && !incoming.state.autoScrollEnabled) this.showNewMessagesBtn(tabId);
  }

  private saveDraft(tabId: string): void {
    this.drafts.set(tabId, {
      text: this.input.textareaEl.value,
      refs: [...this.currentRefs],
      manualRefs: new Set(this.manualRefs),
      lastAutoRefId: this.lastAutoRefId,
      images: [...this.pendingImageParts],
    });
  }

  private restoreDraft(tabId: string): void {
    const draft = this.drafts.get(tabId);
    this.input.textareaEl.value = draft?.text ?? '';
    this.currentRefs = draft ? [...draft.refs] : [];
    this.manualRefs = draft ? new Set(draft.manualRefs) : new Set();
    this.lastAutoRefId = draft?.lastAutoRefId ?? null;
    this.pendingImageParts = draft ? [...draft.images] : [];
    this.rebuildChips();
  }

  /**
   * Composer text for every open tab. Only the tab on screen lives in the
   * textarea, so it is folded into its own entry before the sweep.
   */
  private collectDrafts(): Record<string, StoredDraft | undefined> {
    const active = this.controller?.activeTabId();
    if (active) this.saveDraft(active);
    const collected: Record<string, StoredDraft | undefined> = {};
    for (const [tabId, draft] of this.drafts) {
      const stored = storedDraft(draft);
      if (stored) collected[tabId] = stored;
    }
    return collected;
  }

  /**
   * Yesterday's unsent messages, memoized per tab. The tab in front is painted
   * immediately; a background tab gets its text when it is next looked at.
   */
  private installDrafts(drafts: Record<string, StoredDraft>): void {
    let droppedImages = 0;
    for (const [tabId, stored] of Object.entries(drafts)) {
      droppedImages += stored.images ?? 0;
      this.drafts.set(tabId, {
        text: stored.text,
        refs: (stored.refs ?? []).map((ref) => ({ ...ref })),
        manualRefs: new Set(stored.manual ?? []),
        lastAutoRefId: null,
        images: [],
      });
    }
    if (droppedImages > 0) {
      new Notice(t().draft.imagesDropped.replace('{count}', String(droppedImages)));
    }
    const active = this.controller?.activeTabId();
    if (active && drafts[active]) this.restoreDraft(active);
  }

  /** Re-renders both chip kinds for the restored draft; entries keep their identity. */
  private rebuildChips(): void {
    this.contextChipsEl
      .querySelectorAll('.co-ober-chip[data-ref-id], .co-ober-chip[data-kind="image"]')
      .forEach((el) => el.remove());
    for (const ref of this.currentRefs) this.createNoteChip(ref);
    for (const entry of this.pendingImageParts) this.createImageChip(entry);
  }

  private createImageChip(entry: ImageEntry): void {
    const chip = this.contextChipsEl.createDiv({
      cls: 'co-ober-chip',
      text: `🖼 ${entry.name}`,
    });
    chip.dataset.kind = 'image';
    chip.onclick = () => {
      const index = this.pendingImageParts.indexOf(entry);
      if (index >= 0) this.pendingImageParts.splice(index, 1);
      this.dragDropManager.onRemoveImagePart(entry.data, entry.size);
      chip.remove();
    };
  }

  // ── Smart Auto-scroll ──

  private showNewMessagesBtn(tabId: string = this.controller?.activeTabId() ?? ''): void {
    const panel = this.panels.get(tabId);
    if (!panel) return;
    // renderer.clear() detaches the button along with the message wraps;
    // an isConnected check lets it come back instead of leaking as a
    // dangling reference that suppresses the button forever.
    if (this.newMessagesBtns.get(tabId)?.isConnected) return;
    const btn = panel.el.createEl('button', {
      cls: 'co-ober-new-messages-btn',
    });
    setIcon(btn, 'arrow-down');
    btn.setAttribute('aria-label', t().message.jumpToLatest);
    btn.title = t().message.jumpToLatest;
    btn.onclick = () => {
      const rt = this.controller?.runtimeForTab(tabId);
      if (rt) rt.state.autoScrollEnabled = true;
      this.hideNewMessagesBtn(tabId);
      panel.renderer.forceScrollToBottom();
    };
    this.newMessagesBtns.set(tabId, btn);
  }

  private hideNewMessagesBtn(tabId: string = this.controller?.activeTabId() ?? ''): void {
    this.newMessagesBtns.get(tabId)?.remove();
    this.newMessagesBtns.set(tabId, null);
  }

  setAutoScrollEnabled(enabled: boolean): void {
    const controller = this.controller;
    if (!controller) return;
    // Auto-scroll describes the surface, not one conversation: every open tab
    // follows the setting, and tabs opened later seed from it.
    for (const tabId of controller.listTabIds()) {
      const rt = controller.runtimeForTab(tabId);
      if (rt) rt.state.autoScrollEnabled = enabled;
      if (enabled) this.hideNewMessagesBtn(tabId);
    }
  }

  refreshLocale(): void {
    this.headerTitleEl?.setText(t().appName);
    if (this.newSessionBtnEl) {
      this.newSessionBtnEl.setAttribute('aria-label', t().header.newSession);
      this.newSessionBtnEl.title = t().header.newSession;
    }
    if (this.sessionButtonEl) {
      this.sessionButtonEl.setAttribute('aria-label', t().header.sessionHistory);
      this.sessionButtonEl.title = t().header.sessionHistory;
    }
    for (const btn of this.newMessagesBtns.values()) {
      btn?.setAttribute('aria-label', t().message.jumpToLatest);
      if (btn) btn.title = t().message.jumpToLatest;
    }
    if (this.reconnectBtn) {
      this.reconnectBtn.textContent = this.reconnectBtn.disabled ? t().reconnect.connecting : t().reconnect.text;
    }
    this.meterEl?.setAttribute('aria-label', t().usage.contextMeterAria);
    this.contextChipsEl?.querySelectorAll('.chip-remove').forEach((el) => {
      el.setAttribute('aria-label', t().input.removeChip);
    });
  }

  // ── Reconnect button (view-owned DOM) ──

  /** Lazily mount the /btw panel belonging to one tab and forward the question. */
  private showSideChat(ask: SideChatAsk, question: string, tabId: string): void {
    let panel = this.sideChatPanels.get(tabId);
    if (!panel) {
      panel = new SideChatPanel({
        containerEl: this.contentEl,
        ask,
        // "Main busy" is the tab this thread was forked from, not whichever
        // conversation happens to be on screen.
        isMainBusy: () => this.controller?.runtimeForTab(tabId)?.busy ?? false,
        abort: () => this.controller?.abortSideChat(tabId),
        onClose: () => {
          this.sideChatPanels.delete(tabId);
          const rt = this.controller?.runtimeForTab(tabId);
          if (rt) this.controller?.endSideChat(rt);
        },
      });
      this.sideChatPanels.set(tabId, panel);
    }
    panel.open(question);
  }

  /** A rejected mode/model/effort change must not leave the toolbar showing a lie. */
  private reportSettingFailure(error: unknown): void {
    console.error('[co-ober] toolbar setting failed:', error);
    const detail = error instanceof Error ? error.message : String(error);
    new Notice(`${t().toolbar.applyFailed}: ${detail}`);
    this.controller?.loadToolbarOptions();
  }

  private showReconnectBtn(): void {
    if (this.reconnectBtn) return;
    this.reconnectBtn = this.contentEl.createEl('button', {
      cls: 'co-ober-reconnect-btn',
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
    this.pendingImageParts.length = 0;
    if (this.dragDropManager) this.dragDropManager.resetBytes();
    this.contextChipsEl.querySelectorAll('.co-ober-chip').forEach((el) => {
      if ((el as HTMLDivElement).dataset.kind === 'image') el.remove();
    });
  }

  private openImagePicker(): void {
    const doc = this.doc;
    if (!this.imageFileInputEl) {
      this.imageFileInputEl = doc.createElement('input');
      this.imageFileInputEl.type = 'file';
      this.imageFileInputEl.accept = 'image/*';
      this.imageFileInputEl.multiple = true;
      this.imageFileInputEl.style.display = 'none';
      doc.body.appendChild(this.imageFileInputEl);
    }
    const input = this.imageFileInputEl;
    input.onchange = () => {
      const files = input.files;
      if (files?.length && this.dragDropManager) void this.dragDropManager.handleFiles(files);
      input.value = '';
    };
    input.click();
  }

  private clearAutoRefs(): void {
    if (!this.lastAutoRefId) return;
    const existing = this.currentRefs.find((r) => r.id === this.lastAutoRefId);
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
    if (this.currentRefs.some((r) => r.id === ref.id)) {
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
    this.createNoteChip(ref);
  }

  private createNoteChip(ref: ContextRef): HTMLDivElement {
    const chip = this.contextChipsEl.createDiv({ cls: 'co-ober-chip' });
    chip.dataset.refId = ref.id;
    chip.title = ref.path;
    const label = ref.path !== ref.name ? `${ref.name} (${ref.path})` : ref.name;
    chip.createSpan({ text: `@${label}` });
    const x = chip.createSpan({ cls: 'chip-remove', text: '×' });
    x.setAttribute('role', 'button');
    x.setAttribute('tabindex', '0');
    x.setAttribute('aria-label', t().input.removeChip);
    x.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      this.removeChip(ref.id);
    };
    x.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.removeChip(ref.id);
      }
    };
    return chip;
  }

  private removeChip(id: string): void {
    this.currentRefs = this.currentRefs.filter((r) => r.id !== id);
    if (this.mention.hasRef(id)) this.mention.removeRef(id);
    this.manualRefs.delete(id);
    this.contextChipsEl.querySelectorAll('.co-ober-chip').forEach((el) => {
      if ((el as HTMLDivElement).dataset.refId === id) el.remove();
    });
  }

  private autoRefActiveFile(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
    const activeLeaf = this.plugin.app.workspace.getMostRecentLeaf();
    const activeView = activeLeaf?.view as MarkdownFileView | undefined;
    const firstMarkdownView = leaves[0]?.view as MarkdownFileView | undefined;
    const file = activeLeaf?.view?.getViewType() === 'markdown' ? activeView?.file : firstMarkdownView?.file;
    if (!file || file.extension !== 'md') return;
    if (this.manualRefs.has(file.path)) return;
    this.addChip({ id: file.path, type: 'note', name: file.basename, path: file.path }, 'auto');
    this.lastAutoRefId = file.path;
  }

  private setupActiveFileTracking(): void {
    this.registerEvent(
      this.plugin.app.vault.on('modify', (file) => this.controller?.invalidateNoteCache(file.path)),
    );
    this.registerEvent(
      this.plugin.app.vault.on('delete', (file) => this.controller?.invalidateNoteCache(file.path)),
    );
    this.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
        if (!leaf) return;
        const view = leaf.view as MarkdownFileView;
        if (view?.getViewType?.() !== 'markdown') return;
        const file = view.file;
        if (!file || file.extension !== 'md') return;
        const existing = this.currentRefs.find((r) => r.id === this.lastAutoRefId);
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
    const allItems: Array<{
      value: string;
      label: string;
      description?: string;
      category?: string;
      badge?: string;
      argumentHint?: string;
    }> = [];

    if (mode === '@') {
      const notes = this.mention.listAllNotes();
      const selectedRefs = this.mention.getAllRefs();
      const selectedPaths = new Set(selectedRefs.map((r) => r.id));
      for (const n of notes) {
        allItems.push({
          value: n.path,
          label: `@${n.name}`,
          badge: selectedPaths.has(n.path) ? '✓' : undefined,
        });
      }
    } else {
      // Use the command registry (builtins + ACP synced + file commands)
      const all = commandRegistry.getAll();
      const badgeLabel: Record<string, string> = {
        builtin: t().badge.builtin,
        acp: t().badge.acp,
        file: t().badge.custom,
        mcp: t().badge.mcp,
        skill: t().badge.skill,
      };
      for (const cmd of all) {
        allItems.push({
          value: cmd.trigger,
          label: `/${cmd.trigger}`,
          description: cmd.description,
          category: cmd.source === 'builtin' ? cmd.category : 'agent',
          badge: badgeLabel[cmd.source] ?? cmd.source.toUpperCase(),
          argumentHint: cmd.argumentHint,
        });
      }
      // For ACP commands that arrive mid-stream via onCommandsUpdate:
      // the registry already picks them up, so the loop above covers them.
      // The fallback below only triggers when the registry is empty (first load).
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
      const note = allNotes.find((n) => n.path === value || n.name === value);
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

    if (!usage || !usage.contextTokens) {
      this.meterEl.addClass('empty');
      this.meterEl.removeClass('warning', 'critical');
      this.meterPctEl.setText('—');
      this.meterEl.setAttribute('aria-valuenow', '0');
      this.meterArcFill.setAttribute('stroke-dasharray', `0 ${ARC_LEN}`);
      this.meterEl.removeAttribute('data-tooltip');
      return;
    }

    this.meterEl.removeClass('empty');

    const used = usage.contextTokens;
    const contextWindow = usage.contextWindow ?? 0;
    const pct = contextPercentage(usage) ?? 0;

    const filled = (pct / 100) * ARC_LEN;
    this.meterArcFill.setAttribute('stroke-dasharray', `${filled} ${ARC_LEN}`);
    this.meterEl.setAttribute('aria-valuenow', String(pct));

    this.meterPctEl.setText(`${pct}%`);

    this.meterEl.removeClass('warning', 'critical');
    if (pct >= CONTEXT_METER_CRITICAL_PCT) {
      this.meterEl.addClass('critical');
    } else if (pct >= CONTEXT_METER_WARNING_PCT) {
      this.meterEl.addClass('warning');
    }

    const fmt = (n: number) => (n >= K_FORMAT_THRESHOLD ? `${(n / K_FORMAT_THRESHOLD).toFixed(1)}k` : String(n));
    const tooltip = [
      `${t().usage.context}: ${fmt(used)} / ${fmt(contextWindow)} ${t().usage.tokensUnit}`,
      `${t().usage.input}: ${fmt(usage.inputTokens)}`,
      usage.thoughtTokens ? `${t().usage.thinking}: ${fmt(usage.thoughtTokens)}` : '',
      `${t().usage.output}: ${fmt(usage.outputTokens)}`,
      pct >= 80 ? t().usage.approachingLimit : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.meterEl.setAttribute('data-tooltip', tooltip);
  }
}
