import type {
  NormalizedUpdate,
  ContextRef,
  PromptPart,
  SessionConfigOption,
  ModeOption,
  ModelOption,
  AcpResponse,
  SerializedMessage,
  SerializedSession,
  UsageInfo,
} from '../types';
import type { CoOberSettings } from '../types';
import type { OpencodeClient } from '../client';
import { SessionReplayCollector } from '../client/sessionReplay';
import { t, onLocaleChange } from '../i18n/index';
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
import { normalizeEffortLabel } from '../chat/effortLabel';
import { Mutex } from '../utils/mutex';
import type { WelcomeView } from './welcomeView';
import type { PermissionBanner } from './permissionBanner';
import type { InlineEditPanel } from './inlineEditPanel';
import type { SideChatAsk } from './sideChatPanel';
import { buildSystemPrompt } from '../context/injection';
import { expandWikilinkRefs } from '../context/wikilinks';
import { buildHistoryBlock } from '../context/historyRewind';
import { buildTranscriptMarkdown, sanitizeNoteName } from '../chat/transcript';
import { AcpTimeoutError, AcpProcessExitError, AcpAbortError, AcpSessionMissingError } from '../client/AcpErrors';
import {
  readNativeMessageStats,
  readNativeSessionTodos,
  readNativeSessionUsage,
  readNativeToolErrors,
  readNativeTurnStats,
  type NativeMessageStat,
  type NativeTurnStat,
} from '../opencode/NativeSessionReader';
import { Notice } from 'obsidian';
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
  getPendingImageParts(): PromptPart[];
  onClearPendingImageChips(): void;
  onAutoRefActiveFile(): void;
  /** Open the session dropdown (used by /resume without arguments). */
  onOpenSessions?(): void;
  /** Show the side-chat panel wired to a questioner for the forked session. */
  onOpenSideChat?(ask: SideChatAsk, question: string): void;
  /** Hide the side-chat panel (main session was switched or reset). */
  onCloseSideChat?(): void;
}

export interface ControllerRuntime {
  readonly settings: CoOberSettings;
  getClient(): OpencodeClient | null;
  initClient(): Promise<boolean>;
  getVaultCwd(): string;
  /** Write a markdown note into the vault, creating parent folders as needed. */
  createNote(path: string, content: string): Promise<void>;
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
  runtime: ControllerRuntime;
  updateContextMeter: (usage: import('../types').UsageInfo | null) => void;
}

/** Per-turn knobs for executeAgentCall. */
export interface AgentCallConfig {
  addUserMessage?: boolean;
  saveMessage?: boolean;
  buildPartsWithRefs?: ContextRef[];
  history?: SerializedMessage[];
  onAfterResponse?: (response: AcpResponse | undefined) => Promise<void>;
  onFinally?: () => void;
  retryFn?: (text: string, refs?: ContextRef[]) => Promise<void>;
}

export class CoOberViewController {
  private sessionMutex = new Mutex();
  readonly state = new ChatState();
  private streamCtrl!: StreamController;
  private busy = false;
  private sendStartTime = 0;
  private genId = 0;
  private unsubscribeLocale: (() => void) | null = null;
  private promptQueue: Array<{ text: string; refs: ContextRef[] }> = [];
  /** Turn content captured for a user-initiated retry (see retryTurn). */
  private pendingRetry: { text: string; imageParts: PromptPart[] } | null = null;
  private sideChatSessionId: string | null = null;
  queueIndicatorEl: HTMLDivElement | null = null;

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
    // Builtin titles/descriptions are captured at registration time, so
    // re-register them whenever the locale changes.
    this.unsubscribeLocale = onLocaleChange(() => this.registerBuiltinCommands());
  }

  private registerBuiltinCommands(): void {
    const registry = commandRegistry;
    const client = () => this.deps.runtime.getClient();
    const caps = () => client()?.getAgentCapabilities?.();

    registry.registerBuiltin({
      id: 'compact',
      trigger: 'compact',
      aliases: ['summarize'],
      title: t().slashTitles.compact,
      description: t().slash.compact,
      category: 'session',
      source: 'builtin',
      run: async () => {
        await this.compactSession();
      },
    });
    registry.registerBuiltin({
      id: 'new',
      trigger: 'new',
      title: t().slashTitles.new,
      description: t().slash.new,
      category: 'session',
      source: 'builtin',
      run: async () => {
        await this.createNewSession();
      },
    });
    registry.registerBuiltin({
      id: 'clear',
      trigger: 'clear',
      title: t().slashTitles.clear,
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
      title: t().slashTitles.help,
      description: t().slash.help,
      category: 'view',
      source: 'builtin',
      run: async () => {
        const cmds = registry.getAll();
        const helpText = cmds
          .map((c) => `- **/${c.trigger}**${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.description}`)
          .join('\n');
        this.deps.renderer.addUserMessage('/help');
        this.deps.renderer.addSystemMessage(`### ${t().slash.helpHeader}\n\n${helpText}`);
      },
    });
    registry.registerBuiltin({
      id: 'add-dir',
      trigger: 'add-dir',
      title: t().slashTitles.addDir,
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
      title: t().slashTitles.resume,
      description: t().slash.resume,
      category: 'session',
      source: 'builtin',
      enabled: () => caps()?.sessionCapabilities?.resume ?? false,
      run: async (args: string) => {
        const id = args.trim();
        if (id) {
          await this.resumeSession(id);
          return;
        }
        if (this.callbacks.onOpenSessions) this.callbacks.onOpenSessions();
        else this.deps.renderer.addSystemMessage(t().slash.resumeHint);
      },
    });
    registry.registerBuiltin({
      id: 'fork',
      trigger: 'fork',
      title: t().slashTitles.fork,
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
      id: 'btw',
      trigger: 'btw',
      title: t().slashTitles.btw,
      description: t().slash.btw,
      argumentHint: '[question]',
      category: 'session',
      source: 'builtin',
      enabled: () => caps()?.sessionCapabilities?.fork ?? false,
      run: async (args: string) => {
        await this.startSideChat(args.trim());
      },
    });
    registry.registerBuiltin({
      id: 'export',
      trigger: 'export',
      title: t().slashTitles.export,
      description: t().slash.export,
      category: 'session',
      source: 'builtin',
      run: async () => {
        await this.exportSessionToNote();
      },
    });
    registry.registerBuiltin({
      id: 'copy',
      trigger: 'copy',
      title: t().slashTitles.copy,
      description: t().slash.copy,
      category: 'session',
      source: 'builtin',
      run: async () => {
        this.copyTranscript();
      },
    });
    registry.registerBuiltin({
      id: 'model',
      trigger: 'model',
      title: t().slashTitles.model,
      description: t().slash.model,
      argumentHint: '<model-id>',
      category: 'agent',
      source: 'builtin',
      enabled: () => client() !== null && this.state.sessionId !== null,
      run: async (args: string) => {
        const modelId = args.trim();
        if (!modelId) {
          this.deps.renderer.addSystemMessage(
            `${t().slash.availableModels}\n${this.state.availableModels.map((m) => `- \`${m.modelId}\`: ${m.name}`).join('\n')}`,
          );
          return;
        }
        const c = client();
        if (!c || !this.state.sessionId) return;
        await c.setModel(this.state.sessionId, modelId);
        this.deps.renderer.addSystemMessage(`${t().slash.modelSwitched} \`${modelId}\``);
      },
    });
    registry.registerBuiltin({
      id: 'mode',
      trigger: 'mode',
      title: t().slashTitles.mode,
      description: t().slash.mode,
      argumentHint: '<mode-id>',
      category: 'agent',
      source: 'builtin',
      enabled: () => client() !== null && this.state.sessionId !== null,
      run: async (args: string) => {
        const modeId = args.trim();
        if (!modeId) {
          this.deps.renderer.addSystemMessage(
            `${t().slash.availableModes}\n${this.state.availableModes.map((m) => `- \`${m.id}\`: ${m.name}`).join('\n')}`,
          );
          return;
        }
        const c = client();
        if (!c || !this.state.sessionId) return;
        await c.setMode(this.state.sessionId, modeId);
        this.deps.renderer.addSystemMessage(`${t().slash.modeSwitched} \`${modeId}\``);
      },
    });
  }

  getVaultCwd(): string {
    return this.deps.runtime.getVaultCwd();
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

  async dispose(): Promise<void> {
    this.unsubscribeLocale?.();
    this.unsubscribeLocale = null;
    this.dropQueuedPrompts();
    this.endSideChat();
    await this.streamCtrl.dispose();
    this.noteContentCache.clear();
    this.cacheSessionId = null;
  }

  // ── Connection ──

  async ensureClientConnected(): Promise<boolean> {
    const existing = this.deps.runtime.getClient();
    if (existing?.isConnected()) {
      this.state.isConnected = true;
      this.bindClientHandlers();
      this.callbacks.onHideReconnectBtn();
      this.deps.welcomeView.updateStatus(true);
      await this.syncSavedSessionAndLoadToolbar();
      return true;
    }

    const connected = await this.deps.runtime.initClient();
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
        this.notifyLostSession(e);
      }
    }
    this.loadToolbarOptions();
  }

  bindClientHandlers(): void {
    const client = this.deps.runtime.getClient();
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
          this.notifyLostSession(e);
        }
        this.loadToolbarOptions();
        if (this.busy) {
          ++this.genId;
          this.busy = false;
          this.state.isStreaming = false;
          this.deps.input.setStreaming(false);
          this.deps.toolbar.setSending(false);
          this.deps.renderer.finalizeCurrentThinking();
          this.deps.renderer.removeAssistantPlaceholder();
          this.deps.renderer.addError(t().error.reconnected);
        }
      },
      onReconnectFailed: () => {
        this.deps.renderer.addError(t().error.reconnectFailed);
        this.handleDisconnect();
      },
      onPermissionUnreadable: () => {
        this.deps.renderer.addError(t().permission.unreadable);
      },
      onElicitationComplete: (elicitationId) => {
        this.deps.permissionBanner.resolveExternally(elicitationId);
      },
      onPermissionRequest: async (req) =>
        client.permissionMode === 'safe'
          ? this.deps.permissionBanner.show(req)
          : (client.requestPermission?.(req) ??
            Promise.resolve(
              req.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always')
                ?.optionId ?? 'reject_once',
            )),
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
    this.deps.input.setStreaming(false);
    this.deps.toolbar.setSending(false);
    this.deps.welcomeView.updateStatus(false);
    this.callbacks.onShowReconnectBtn();
  }

  async reconnect(): Promise<void> {
    try {
      const connected = await this.deps.runtime.initClient();
      if (!connected) throw new Error(t().reconnect.failed);
      this.bindClientHandlers();
      try {
        await this.syncRuntimeSession(this.state.sessionId);
      } catch (e) {
        console.error('[co-ober] session resync:', e);
        this.notifyLostSession(e);
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

  async syncRuntimeSession(sessionId: string | null, onReplayUpdate?: (u: NormalizedUpdate) => void): Promise<void> {
    if (!sessionId) return;
    return this.sessionMutex.runExclusive(async () => {
      const client = this.deps.runtime.getClient();
      if (!client) return;
      if (client.getCurrentSessionId() === sessionId) return;
      const caps = client.getAgentCapabilities?.();
      if (caps && caps.loadSession === false) {
        // Agents without session/load can still hand a stored session back —
        // but resume reconnects WITHOUT replaying history, unlike session/load.
        if (caps.sessionCapabilities?.resume) {
          await client.resumeSession(sessionId, this.getVaultCwd(), onReplayUpdate);
          return;
        }
        // Neither path exists: say so instead of silently keeping the client
        // bound to a different session than state.sessionId.
        const message = t().session.syncUnsupported;
        console.warn(`[co-ober] cannot re-attach session ${sessionId}: ${message}`);
        this.deps.renderer.addSystemMessage(message);
        return;
      }
      await client.loadSession(sessionId, this.getVaultCwd(), this.deps.runtime.settings.mcpServers, onReplayUpdate);
    });
  }

  /** Persist the agent-replayed transcript when we have no local mirror yet (e.g. native OpenCode sessions). */
  private async adoptReplay(sessionId: string, replayed: SerializedMessage[]): Promise<void> {
    if (replayed.length === 0) return;
    const session = this.deps.sessionStore.getOrCreate(sessionId);
    if (session.messages.length > 0) return;
    session.messages.push(...replayed);
    session.updatedAt = Date.now();
    await this.deps.sessionStore.save();
  }

  /** Surface a session-sync failure: a dropped session gets a neutral note, any other error gets a visible line. */
  notifyLostSession(err: unknown): boolean {
    if (err instanceof AcpSessionMissingError) {
      this.deps.renderer.addSystemMessage(t().session.runtimeSessionLost);
      return true;
    }
    // Any other resync failure means the transcript the user sees may be
    // stale — say so instead of leaving it in the console.
    this.deps.renderer.addError(
      `${t().session.syncFailed}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  async cancelActiveGeneration(): Promise<void> {
    const client = this.deps.runtime.getClient();
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
    const c = this.deps.runtime.getClient();
    if (!c) return;

    try {
      await this.cancelActiveGeneration();
      this.resetConversationView();
      await this.sessionMutex.runExclusive(async () => {
        const sid = await c.createSession(this.getVaultCwd(), this.deps.runtime.settings.mcpServers);
        this.state.sessionId = sid;
        await applyDefaultSessionSettings(c, sid, this.deps.runtime.settings);
      });
      if (this.state.sessionId) {
        this.deps.sessionStore.getOrCreate(this.state.sessionId);
        this.deps.sessionStore.setActive(this.state.sessionId);
      }
      await this.deps.sessionStore.save();
      this.loadToolbarOptions();
      this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
      this.callbacks.onAutoRefActiveFile();
    } catch (e) {
      console.error('[co-ober] newSession:', e);
      this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
    }
  }

  async restoreSession(): Promise<void> {
    if (!this.state.sessionId) return;
    const session = this.deps.sessionStore.get(this.state.sessionId);
    if (!session) return;
    const gen = this.genId;
    const sid = this.state.sessionId;
    await this.enrichMessagesFromNative(session);
    // A session switch during enrichment resets the view and repoints
    // sessionId; painting this transcript then would render A's messages
    // into B's freshly cleared panel.
    if (this.genId !== gen || this.state.sessionId !== sid) return;
    let idx = 0;
    for (const msg of session.messages) {
      const restoreId = `restore-${msg.timestamp}-${idx++}`;
      if (msg.role === 'user') {
        this.deps.renderer.addUserMessage(msg.content, msg.timestamp, msg.images);
      } else if (msg.role === 'system') {
        this.deps.renderer.addSystemMessage(msg.content);
      } else if (msg.role === 'assistant') {
        if (msg.contentBlocks && msg.contentBlocks.length > 0) {
          this.deps.renderer.renderStructuredMessage(msg);
        } else if (msg.type === 'thinking') {
          this.deps.renderer.appendThinking(msg.content, restoreId, msg.timestamp);
        } else {
          this.deps.renderer.appendText(msg.content, restoreId, msg.timestamp, msg.usage, msg.turnStats);
        }
      }
    }
    this.deps.renderer.collapseTurns?.();
    await this.refreshNativePlan(session.sessionId);
  }

  async ensureRuntimeSession(): Promise<string | null> {
    if (!(await this.ensureClientConnected())) return null;
    const client = this.deps.runtime.getClient();
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
        const sid = await client.createSession(this.getVaultCwd(), this.deps.runtime.settings.mcpServers);
        this.state.sessionId = sid;
        await applyDefaultSessionSettings(client, sid, this.deps.runtime.settings);
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
      this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // ── Session dropdown actions ──

  async switchSession(sessionId: string, source?: 'local' | 'opencode'): Promise<void> {
    // Cancel first: the agent-side cancel targets state.sessionId, so
    // repointing it before cancelling skips the still-running turn and
    // sends a no-op cancel to the session we are switching into.
    await this.cancelActiveGeneration();
    this.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    this.callbacks.onClearUI();
    this.resetConversationView();
    try {
      const collector = new SessionReplayCollector();
      await this.syncRuntimeSession(sessionId, (u) => collector.handle(u));
      await this.adoptReplay(sessionId, collector.finish());
      if (source === 'opencode') {
        this.deps.renderer.addSystemMessage(t().session.loadedNative);
      }
    } catch (e) {
      console.error('[co-ober] session switch sync:', e);
      if (source === 'opencode') {
        this.deps.renderer.addError(
          e instanceof AcpSessionMissingError ? t().session.nativeSessionMissing : t().session.loadNativeFailed,
        );
      }
    }
    await this.restoreSession();
    if (source === 'opencode') await this.refreshNativeUsage(sessionId);
    this.deps.sessionStore.setActive(sessionId);
    await this.deps.sessionStore.save();
    this.loadToolbarOptions();
    this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
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
    const client = this.deps.runtime.getClient();
    if (!client) return;
    try {
      const source = this.deps.sessionStore.get(sessionId);
      const forkedId = await client.forkSession(sessionId, this.getVaultCwd());
      this.resetConversationView();
      this.state.sessionId = forkedId;
      const forked = this.deps.sessionStore.getOrCreate(forkedId);
      if (source && forked.messages.length === 0) {
        forked.messages.push(...source.messages.map((m) => ({ ...m })));
        forked.title = source.title;
        forked.updatedAt = Date.now();
      }
      this.deps.sessionStore.setActive(forkedId);
      await this.deps.sessionStore.save();
      const collector = new SessionReplayCollector();
      await this.syncRuntimeSession(forkedId, (u) => collector.handle(u));
      await this.adoptReplay(forkedId, collector.finish());
      await this.restoreSession();
      this.loadToolbarOptions();
      this.callbacks.onShowWelcome(true);
    } catch (e) {
      console.error('[co-ober] fork session:', e);
      this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Side chat (/btw) ──

  /**
   * Fork the current conversation into a scratch thread and hand a bound
   * questioner to the view's side-chat panel. The main session is never
   * touched: no transcript, store or toolbar state changes here.
   */
  async startSideChat(question: string): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) {
      this.deps.renderer.addError(t().sideChat.notConnected);
      return;
    }
    if (client.getAgentCapabilities?.()?.sessionCapabilities?.fork !== true) {
      this.deps.renderer.addError(t().sideChat.forkUnsupported);
      return;
    }
    if (this.busy) {
      this.deps.renderer.addSystemMessage(t().sideChat.busy);
      return;
    }
    try {
      if (!this.sideChatSessionId) {
        const parent = await this.ensureRuntimeSession();
        if (!parent) return;
        this.sideChatSessionId = await client.forkSession(parent, this.getVaultCwd());
      }
      this.callbacks.onOpenSideChat?.(this.buildSideChatAsk(), question);
    } catch (e) {
      console.error('[co-ober] side chat fork:', e);
      this.deps.renderer.addError(t().sideChat.failed.replace('{error}', e instanceof Error ? e.message : String(e)));
    }
  }

  private buildSideChatAsk(): SideChatAsk {
    return async (text, onChunk) => {
      const client = this.deps.runtime.getClient();
      const sideId = this.sideChatSessionId;
      if (!client || !sideId) throw new Error(t().sideChat.notConnected);
      return client.sendMessage(sideId, [{ type: 'text', text }], onChunk);
    };
  }

  /** Close and release the side session; the panel's onClose hook calls this. */
  endSideChat(): void {
    const sideId = this.sideChatSessionId;
    this.sideChatSessionId = null;
    if (!sideId) return;
    const client = this.deps.runtime.getClient();
    if (client?.getAgentCapabilities?.()?.sessionCapabilities?.close) {
      void client.closeSession(sideId).catch((e) => console.error('[co-ober] close side session:', e));
    }
  }

  /** Cancel a still-streaming side-chat turn; the panel calls this when closed mid-answer. */
  abortSideChat(): void {
    const sideId = this.sideChatSessionId;
    if (!sideId) return;
    const client = this.deps.runtime.getClient();
    if (!client) return;
    void client.cancel(sideId).catch((e) => console.warn('[co-ober] side chat cancel:', e));
  }

  async resumeSession(sessionId: string): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) return;
    // Mirror switchSession: cancel the in-flight turn first (cancel targets
    // state.sessionId), then swap the screen — a resumed transcript must
    // replace what is on screen, not just the store behind it.
    await this.cancelActiveGeneration();
    this.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    this.callbacks.onClearUI();
    this.resetConversationView();
    const collector = new SessionReplayCollector();
    try {
      await this.sessionMutex.runExclusive(async () => {
        await client.resumeSession(sessionId, this.getVaultCwd(), (u) => collector.handle(u));
      });
      await this.adoptReplay(sessionId, collector.finish());
    } catch (e) {
      console.error('[co-ober] session resume:', e);
      this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
    }
    await this.restoreSession();
    // The transcript swap cleared state usage (it belonged to the outgoing
    // session); hand refreshNativeUsage the resumed session's own currency
    // hint from its enriched rows so it can't flatly fall back to USD.
    const costCurrencyFromMessages = (this.deps.sessionStore.get(sessionId)?.messages ?? [])
      .map((m) => m.usage?.costCurrency)
      .find((c): c is string => typeof c === 'string' && c.length > 0);
    await this.refreshNativeUsage(sessionId, costCurrencyFromMessages);
    await this.refreshNativePlan(sessionId);
    this.deps.sessionStore.setActive(sessionId);
    await this.deps.sessionStore.save();
    this.loadToolbarOptions();
    this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
    this.callbacks.onAutoRefActiveFile();
  }

  // ── Rewind (regenerate / edit-and-resend) ──

  /**
   * Drop everything from the ordinal-th user turn onward, then re-send that
   * question — verbatim (regenerate) or edited — into a fresh agent session.
   * ACP has no server-side truncate, so the retained turns are replayed to
   * the new agent session as a context-only text block instead.
   */
  async rewindUserTurn(ordinal: number, newText?: string): Promise<void> {
    if (this.busy) {
      this.deps.renderer.addSystemMessage(t().rewind.busy);
      return;
    }
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) return;

    let seen = 0;
    let idx = -1;
    for (let i = 0; i < session.messages.length; i++) {
      if (session.messages[i].role !== 'user') continue;
      seen++;
      if (seen === ordinal) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;

    const text = (newText ?? session.messages[idx].content).trim();
    if (!text) return;

    const history = session.messages.slice(0, idx);
    // Only truncate the local transcript after the fresh agent session is
    // confirmed; otherwise a failed renew would silently drop context.
    let renewed: string | null;
    try {
      renewed = await this.renewAgentSession();
    } catch (e) {
      console.error('[co-ober] rewind session renew:', e);
      renewed = null;
    }
    if (!renewed) {
      this.deps.renderer.addSystemMessage(t().rewind.renewFailed);
      return;
    }
    session.messages.splice(idx);
    session.updatedAt = Date.now();
    await this.deps.sessionStore.save();

    this.resetConversationView();
    await this.restoreSession();
    await this.executeAgentCall(text, [], {
      buildPartsWithRefs: [],
      history,
      retryFn: (t2, r) => this.send(t2, r ?? []),
    });
  }

  /** Rotate to a fresh agent session while keeping the local transcript under the new id. */
  private async renewAgentSession(): Promise<string | null> {
    const client = this.deps.runtime.getClient();
    if (!client) return null;
    const oldId = this.state.sessionId;
    const newId = await this.sessionMutex.runExclusive(async () => {
      const sid = await client.createSession(this.getVaultCwd(), this.deps.runtime.settings.mcpServers);
      await applyDefaultSessionSettings(client, sid, this.deps.runtime.settings);
      return sid;
    });
    if (oldId && client.getAgentCapabilities()?.sessionCapabilities?.close) {
      client.closeSession(oldId).catch((e) => console.error('[co-ober] close rewound session:', e));
    }
    if (oldId) this.deps.sessionStore.rekey(oldId, newId);
    this.state.sessionId = newId;
    this.deps.sessionStore.setActive(newId);
    await this.deps.sessionStore.save();
    this.loadToolbarOptions();
    return newId;
  }

  // ── Sending ──

  /**
   * Replay a failed turn through its original retry path while handing the
   * next executeAgentCall the parts captured on the first attempt. Cleared in
   * finally so a retry that gets enqueued (a new turn started meanwhile)
   * never leaves stale images behind.
   */
  private async retryTurn(
    config: AgentCallConfig,
    text: string,
    refs: ContextRef[],
    imageParts: PromptPart[],
  ): Promise<void> {
    if (!config.retryFn) return;
    this.pendingRetry = { text, imageParts };
    try {
      await config.retryFn(text, refs);
    } finally {
      this.pendingRetry = null;
    }
  }

  private async executeAgentCall(
    text: string,
    refs: ContextRef[],
    config: AgentCallConfig,
  ): Promise<void> {
    // Claim the busy flag synchronously, before any await: two Enter
    // presses in the same tick must not both pass send()'s busy check.
    const currentGen = ++this.genId;
    this.streamCtrl.beginTurn();
    this.busy = true;
    this.state.isStreaming = true;
    this.deps.input.setStreaming(true);
    this.deps.toolbar.setSending(true);
    this.sendStartTime = Date.now();
    this.callbacks.onHideWelcome();
    const releaseBusy = (): void => {
      this.busy = false;
      this.state.isStreaming = false;
      this.deps.input.setStreaming(false);
      this.deps.toolbar.setSending(false);
    };

    let sessionId: string | null;
    try {
      sessionId = await this.ensureRuntimeSession();
    } catch (e) {
      releaseBusy();
      this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
      // Release queued prompts too, or the queue stalls forever.
      config.onFinally?.();
      return;
    }
    const c = this.deps.runtime.getClient();
    if (!c || !sessionId) {
      releaseBusy();
      config.onFinally?.();
      return;
    }

    this.deps.input.setStreaming(true);
    this.deps.toolbar.setSending(true);
    this.sendStartTime = Date.now();
    // A retry replays the parts captured on the failed attempt: the chips
    // were cleared then, and the user bubble + persisted message already
    // exist from that attempt, so re-adding either would corrupt the turn.
    const savedRetry = this.pendingRetry && this.pendingRetry.text === text ? this.pendingRetry : null;
    this.pendingRetry = null;
    const imageParts = savedRetry ? savedRetry.imageParts : this.callbacks.getPendingImageParts();
    if (!savedRetry) this.callbacks.onClearPendingImageChips();
    const images = imageParts
      .filter((p) => p.type === 'image' && typeof p.mimeType === 'string' && typeof p.data === 'string')
      .map((p) => ({ mimeType: p.mimeType as string, data: p.data as string }));
    if (!savedRetry && config.addUserMessage !== false)
      this.deps.renderer.addUserMessage(text, undefined, images.length > 0 ? images : undefined);
    if (!savedRetry && config.saveMessage !== false)
      this.streamCtrl.saveMessage('user', text, 'text', undefined, images.length > 0 ? images : undefined);
    this.deps.renderer.addAssistantPlaceholder();

    try {
      await this.syncRuntimeSession(sessionId);
      if (this.state.sessionId !== sessionId || !this.busy) return;
      const parts = config.buildPartsWithRefs
        ? await this.buildParts(
            text,
            config.buildPartsWithRefs,
            config.history ? buildHistoryBlock(config.history) : undefined,
          )
        : [{ type: 'text' as const, text }];
      if (this.state.sessionId !== sessionId || !this.busy) return;
      // Capabilities can change across reconnects; re-check before sending.
      const caps = c.getAgentCapabilities?.();
      parts.push(...(caps?.promptCapabilities?.image === false ? [] : imageParts));
      const response = await c.sendMessage(sessionId, parts, (ch: NormalizedUpdate) => {
        if (this.genId !== currentGen || !this.busy || this.state.sessionId !== sessionId) return;
        this.streamCtrl.handleChunk(ch);
      });
      // If this turn was superseded (new prompt, session switch), a newer
      // generation owns the transcript — don't clobber its state.
      if (this.genId === currentGen && this.state.sessionId === sessionId) {
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
          this.applyResponseMeta(response._meta);
          this.deps.updateContextMeter(this.state.usage);
        } else {
          this.applyResponseMeta(response?._meta);
        }
        this.surfaceStopReason(response);
        if (config.onAfterResponse) await config.onAfterResponse(response);
      }
    } catch (e: unknown) {
      if (!this.state.isConnected && !(e instanceof AcpProcessExitError)) {
        // A disconnect surfaces its own banner; keep a trace of the swallowed turn error.
        console.warn('[co-ober] turn error swallowed while disconnected:', e);
        return;
      }
      if (this.state.sessionId === sessionId) {
        if (e instanceof AcpAbortError) {
          // User cancelled, don't show error
        } else if (e instanceof AcpTimeoutError) {
          this.deps.renderer.addError(t().error.timeout, 'retry', () =>
            this.retryTurn(config, text, refs, imageParts),
          );
        } else if (e instanceof AcpProcessExitError) {
          this.deps.renderer.addError(t().error.processExit, 'restart', async () => {
            await this.reconnect();
            await this.retryTurn(config, text, refs, imageParts);
          });
        } else {
          this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      if (this.genId === currentGen) {
        // Turn over: buffered tool calls that never received a final
        // update must render with a terminal state instead of vanishing.
        // Only safe while this generation still owns the transcript; a
        // newer turn has its own placeholder and tool-call buffers.
        this.streamCtrl.finalizeBufferedToolCalls();
        // A turn whose last update was a thought must not leave the live
        // thinking block (and its running timer) un-finalized.
        this.deps.renderer.finalizeCurrentThinking();
        this.deps.renderer.removeAssistantPlaceholder();
        this.busy = false;
        this.state.isStreaming = false;
        this.deps.input.setStreaming(false);
        this.deps.toolbar.setSending(false);
        this.deps.input.focus();
        config.onFinally?.();
        // The agent may have rewritten its todo list this turn; resync the
        // plan panel — but skip when the stream already delivered a plan
        // after this turn started, so the refresh can't overwrite it.
        if ((this.state.lastPlanUpdateAt ?? 0) < this.sendStartTime) {
          void this.refreshNativePlan(sessionId).catch(() => {});
        }
        // Fold the finished turn: thinking/tool steps behind a summary header.
        this.deps.renderer.collapseTurns?.();
      }
    }
  }

  /**
   * Make non-successful turn endings visible: a refusal or a truncated
   * response must not render as a normal completed answer.
   */
  private surfaceStopReason(response: AcpResponse | undefined): void {
    const reason = response?.stopReason;
    // Lines are also persisted (like the compaction boundary) so the badge
    // survives a reload instead of evaporating with the live DOM.
    const note = (text: string, asError: boolean): void => {
      if (asError) this.deps.renderer.addError(text);
      else this.deps.renderer.addSystemMessage(text);
      this.streamCtrl.persistSystemNote(text);
    };
    if (reason === 'refusal') {
      note(t().stopReason.refusal, true);
    } else if (reason === 'max_tokens') {
      note(t().stopReason.maxTokens, false);
    } else if (reason === 'max_turn_requests') {
      note(t().stopReason.maxTurnRequests, false);
    } else if (reason === 'tool_calls') {
      // The turn ended awaiting tool results the client was to supply — the
      // answer is truncated even though nothing errored.
      note(t().stopReason.toolCalls, false);
    } else if (reason && reason !== 'end_turn' && reason !== 'cancelled' && reason !== 'interrupted') {
      // Outside the known enum: better a verbatim badge than a silent turn
      // that looks like it completed normally.
      note(t().stopReason.unknown.replace('{reason}', reason), false);
    }
    // 'cancelled' / 'interrupted' are user-initiated; no banner needed.
  }

  /**
   * Stamp the just-finished turn's token totals onto the newest assistant
   * message that has no usage yet, so the footer survives a reload. Native
   * OpenCode sessions get authoritative numbers from the database on restore;
   * this covers the ACP-response path (and seeds the footer before enrichment).
   */
  private persistTurnUsage(usage: UsageInfo): void {
    const sessionId = this.state.sessionId;
    if (!sessionId) return;
    const session = this.deps.sessionStore.get(sessionId);
    if (!session) return;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      if (msg.role !== 'assistant' || msg.type === 'thinking' || msg.usage) continue;
      msg.usage = {
        totalTokens: usage.totalTokens || undefined,
        inputTokens: usage.inputTokens || undefined,
        outputTokens: usage.outputTokens || undefined,
        cost: usage.cost?.amount,
        costCurrency: usage.cost?.currency,
      };
      void this.deps.sessionStore.save();
      return;
    }
  }

  /**
   * Pull authoritative cost/token totals for a session from the OpenCode
   * database. Silently no-ops when the database is unavailable.
   */
  private async refreshNativeUsage(sessionId: string, currencyHint?: string): Promise<void> {
    const usage = await readNativeSessionUsage(sessionId);
    if (!usage || this.state.sessionId !== sessionId) return;
    this.state.usage = {
      totalTokens: usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thoughtTokens: usage.reasoningTokens || undefined,
      // The native DB has no currency column; keep whatever currency the
      // agent's own usage frames (or the resumed transcript's rows) reported
      // before falling back to USD.
      cost: { amount: usage.cost, currency: currencyHint ?? this.state.usage?.cost?.currency ?? 'USD' },
      contextWindow: this.state.usage?.contextWindow,
      contextTokens: usage.contextTokens,
    };
    this.deps.updateContextMeter(this.state.usage);
  }

  /**
   * Re-read the OpenCode-native todo table so the plan panel survives session
   * restore. Silently no-ops when the database or todos are unavailable.
   */
  private async refreshNativePlan(sessionId: string): Promise<void> {
    const todos = await readNativeSessionTodos(sessionId);
    if (todos.length === 0 || this.state.sessionId !== sessionId) return;
    this.deps.renderer.setPlanEntries(todos);
  }

  /**
   * Enrich a restored transcript with per-message cost/token footers, turn
   * throughput and tool errors from the OpenCode database. Silently no-ops
   * when unavailable.
   */
  private async enrichMessagesFromNative(session: SerializedSession): Promise<void> {
    const [stats, toolErrors, turnStats] = await Promise.all([
      readNativeMessageStats(session.sessionId),
      readNativeToolErrors(session.sessionId),
      readNativeTurnStats(session.sessionId),
    ]);
    let changed = false;
    if (stats.length > 0) changed = this.attachNativeUsage(session, stats);
    if (turnStats.length > 0) changed = this.attachNativeTurnStats(session, turnStats) || changed;
    if (Object.keys(toolErrors).length > 0) changed = this.attachNativeToolErrors(session, toolErrors) || changed;
    if (!changed) return;
    try {
      await this.deps.sessionStore.save();
    } catch (e) {
      // enrichment is cosmetic; a failed persist must not break restore
      console.warn('[co-ober] native enrichment save failed:', e);
    }
  }

  private attachNativeUsage(session: SerializedSession, stats: NativeMessageStat[]): boolean {
    const assistants = session.messages.filter((m) => m.role === 'assistant');
    if (assistants.length === 0) return false;
    const toUsage = (s: NativeMessageStat) => ({
      cost: s.cost,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      totalTokens: s.totalTokens,
    });
    const byId = new Map(stats.map((s) => [s.messageId, s]));
    let changed = false;
    if (assistants.some((m) => m.nativeMessageId && byId.has(m.nativeMessageId))) {
      const claimed = new Set<string>();
      const claim = (msg: SerializedMessage) => {
        const nativeId = msg.nativeMessageId;
        if (!nativeId || msg.usage || claimed.has(nativeId)) return;
        const stat = byId.get(nativeId);
        if (!stat) return;
        claimed.add(nativeId);
        msg.usage = toUsage(stat);
        changed = true;
      };
      // Thinking and text buckets can share one native message id; give the
      // stat to the text bucket first because only it renders a usage footer.
      for (const msg of assistants) if (msg.type !== 'thinking') claim(msg);
      for (const msg of assistants) claim(msg);
      return changed;
    }
    // Legacy transcripts carry no native message ids; match positionally only
    // when the counts line up one-to-one, otherwise the mapping is guesswork.
    if (stats.length !== assistants.length) return false;
    assistants.forEach((msg, i) => {
      if (!msg.usage) {
        msg.usage = toUsage(stats[i]);
        changed = true;
      }
    });
    return changed;
  }

  /**
   * Attach native turn throughput to the closing assistant message of each
   * turn. Only id-matched transcripts qualify; positional guessing would
   * attribute someone else's wall clock.
   */
  private attachNativeTurnStats(session: SerializedSession, turnStats: NativeTurnStat[]): boolean {
    const byId = new Map(turnStats.map((s) => [s.messageId, s]));
    let changed = false;
    for (const msg of session.messages) {
      if (msg.role !== 'assistant' || msg.type === 'thinking' || msg.turnStats) continue;
      const nativeId = msg.nativeMessageId;
      if (!nativeId) continue;
      const stat = byId.get(nativeId);
      if (!stat) continue;
      msg.turnStats = { outputTokens: stat.outputTokens, durationMs: stat.durationMs };
      changed = true;
    }
    return changed;
  }

  private attachNativeToolErrors(session: SerializedSession, toolErrors: Record<string, string>): boolean {
    let changed = false;
    for (const msg of session.messages) {
      for (const block of msg.contentBlocks ?? []) {
        if (block.type !== 'tool_use' || !block.toolCallId || block.toolError) continue;
        const error = toolErrors[block.toolCallId];
        if (!error) continue;
        block.toolError = error;
        if (block.toolStatus !== 'completed') block.toolStatus = 'failed';
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Apply context usage reported in the prompt response `_meta`
   * (`used`/`size`/`cost`), which agents send outside usage_update chunks.
   */
  private applyResponseMeta(meta: Record<string, unknown> | undefined): void {
    if (!meta) return;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const used = num(meta.used);
    const size = num(meta.size);
    const costObj = meta.cost && typeof meta.cost === 'object' ? (meta.cost as Record<string, unknown>) : undefined;
    const costAmount = num(costObj?.amount);
    if (used === undefined && size === undefined && costAmount === undefined) return;
    const usage: UsageInfo = this.state.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    if (used !== undefined) usage.contextTokens = used;
    if (size !== undefined) usage.contextWindow = size;
    if (costAmount !== undefined) {
      usage.cost = { amount: costAmount, currency: typeof costObj?.currency === 'string' ? costObj.currency : 'USD' };
    }
    this.state.usage = usage;
    this.deps.updateContextMeter(usage);
  }

  async send(text: string, refs: ContextRef[]): Promise<void> {
    if (this.busy) {
      this.promptQueue.push({ text, refs });
      this.updateQueueIndicator();
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
          this.persistTurnUsage(this.state.usage);
        }
        if (inlineEdit && this.deps.inlineEditPanel.pendingState === inlineEdit) {
          const session = this.deps.sessionStore.get(this.state.sessionId ?? '');
          if (session) {
            const lastMsg = session.messages
              .slice()
              .reverse()
              .find((m) => m.role === 'assistant');
            if (lastMsg) {
              this.deps.inlineEditPanel.showDiffFromResponse(inlineEdit.original, lastMsg.content);
            }
          }
          this.deps.inlineEditPanel.pendingState = null;
        }
        void this.maybeAutoTitle().catch((e) => console.error('[co-ober] auto title:', e));
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
      const head = this.promptQueue.shift()!;
      let text = head.text;
      // Consecutive plain prompts pile up while the agent is busy; merge them
      // into one turn so the agent sees the follow-ups as a single message.
      if (isPlainPrompt(head)) {
        while (this.promptQueue.length > 0 && isPlainPrompt(this.promptQueue[0])) {
          text += `\n\n${this.promptQueue.shift()!.text}`;
        }
      }
      this.updateQueueIndicator();
      try {
        await this.send(text, head.refs);
      } catch (e) {
        // One failing queued command must not strand the rest of the queue.
        console.error('[co-ober] queued prompt failed:', e);
        this.deps.renderer.addError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  async stopGeneration(): Promise<void> {
    const c = this.deps.runtime.getClient();
    if (!c || !this.state.sessionId || (!this.busy && !this.state.isStreaming)) return;
    // Increment genId FIRST so the in-flight executeAgentCall's finally block
    // skips stale state updates (busy=false, onFinally).
    ++this.genId;
    this.deps.input.setStreaming(false);
    this.deps.toolbar.setSending(false);
    try {
      // Cancel the backend RPC before resetting local state,
      // so the in-flight handler stops processing chunks immediately.
      await c.cancel(this.state.sessionId);
    } catch (e) {
      console.error('[co-ober] cancel:', e);
    }
    // Buffered pending/in_progress tool calls belonged to the interrupted
    // turn: render them terminal now so they neither vanish nor ghost into
    // the next turn (its finally is skipped by the genId bump above).
    this.streamCtrl.finalizeBufferedToolCalls();
    // Stop during a thought: close the live thinking block before the
    // interrupt marker, so its timer stops and the label finalizes.
    this.deps.renderer.finalizeCurrentThinking();
    // Append "Interrupted" indicator to the current assistant response
    this.deps.renderer.appendInterruptIndicator();
    this.deps.renderer.flushTextRender().catch(() => {});
    this.busy = false;
    this.state.isStreaming = false;
    // Stop means "pause everything", not "lose the queue": plain prompts go
    // back into the input so the user keeps their text. Entries carrying
    // @-mention/image refs stay queued — the textarea cannot represent refs,
    // and dropping them would silently lose context.
    const paused = this.promptQueue.splice(0);
    const restorable = paused.filter(isPlainPrompt);
    this.promptQueue.push(...paused.filter((q) => !isPlainPrompt(q)));
    if (restorable.length > 0) {
      const ta = this.deps.input.textareaEl;
      const existing = ta.value.trim();
      const queued = restorable.map((q) => q.text);
      // Blank-line separation: a single \n would weld independent prompts
      // into one message the next send submits as a combined prompt.
      const restored = queued.join('\n\n');
      ta.value = existing ? `${existing}\n\n${restored}` : restored;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      this.deps.input.focus();
    }
    this.updateQueueIndicator();
  }

  /**
   * Update the queue indicator: count header plus one removable row per
   * queued prompt so the user can see and prune what will be sent next.
   */
  private updateQueueIndicator(): void {
    const indicatorEl = this.queueIndicatorEl;
    if (!indicatorEl) return;

    indicatorEl.empty();

    if (this.promptQueue.length > 0) {
      const text =
        this.promptQueue.length === 1
          ? t().queue.one
          : t().queue.many.replace('{count}', String(this.promptQueue.length));
      indicatorEl.createSpan({ cls: 'co-ober-queue-text', text });
      this.promptQueue.forEach((entry, index) => {
        const item = indicatorEl.createDiv({ cls: 'co-ober-queue-item' });
        item.createSpan({ cls: 'co-ober-queue-item-text', text: queuePreview(entry.text) });
        const remove = item.createEl('button', {
          cls: 'co-ober-queue-remove',
          text: '×',
          attr: { 'aria-label': t().queue.remove, title: t().queue.remove },
        });
        remove.onclick = () => {
          this.promptQueue.splice(index, 1);
          this.updateQueueIndicator();
        };
      });
      indicatorEl.addClass('co-ober-visible');
    } else {
      indicatorEl.removeClass('co-ober-visible');
    }
  }

  /** Discarding queued prompts (session reset, view close) must never be silent. */
  private dropQueuedPrompts(): void {
    if (this.promptQueue.length === 0) return;
    new Notice(t().queue.dropped.replace('{count}', String(this.promptQueue.length)));
    this.promptQueue = [];
    this.updateQueueIndicator();
  }

  /** Number of prompts waiting for the current turn to finish (tests / UI hooks). */
  queuedCount(): number {
    return this.promptQueue.length;
  }

  /** Cache note content by path (LRU) to avoid re-reading the same file. */
  private noteContentCache = new Map<string, { name: string; content: string }>();
  private cacheSessionId: string | null = null;

  private setCacheEntry(path: string, entry: { name: string; content: string }): void {
    if (this.noteContentCache.has(path)) this.noteContentCache.delete(path);
    else if (this.noteContentCache.size >= NOTECACHE_MAX_SIZE) {
      // Map iteration order is insertion order, so the first key is the LRU entry.
      const oldest = this.noteContentCache.keys().next().value;
      if (oldest !== undefined) this.noteContentCache.delete(oldest);
    }
    this.noteContentCache.set(path, entry);
  }

  /** Drop a cached note after the vault reports the file changed or was removed. */
  invalidateNoteCache(path: string): void {
    this.noteContentCache.delete(path);
  }

  async buildParts(text: string, refs: ContextRef[], historyBlock?: string): Promise<PromptPart[]> {
    const parts: PromptPart[] = [];

    // Clear stale cache on session change
    if (this.cacheSessionId && this.cacheSessionId !== this.state.sessionId) {
      this.noteContentCache.clear();
    }
    this.cacheSessionId = this.state.sessionId;

    let vaultNotes: ContextRef[] = [];
    try {
      vaultNotes = this.deps.mention.listAllNotes();
    } catch {
      // wikilink expansion is best-effort
    }
    const allRefs = expandWikilinkRefs(text, refs, vaultNotes);

    // Agents that report no embedded-context support get the plain user text;
    // inlined note bodies are skipped instead of bloating the prompt.
    const embedAllowed =
      this.deps.runtime.getClient()?.getAgentCapabilities?.()?.promptCapabilities?.embeddedContext !== false;

    const resolved: Array<{ name: string; content: string }> = [];
    if (embedAllowed) {
      for (const ref of allRefs) {
        const cached = this.noteContentCache.get(ref.path);
        if (cached) {
          // Touch: keep the recently-used entry at the fresh end of the LRU.
          this.noteContentCache.delete(ref.path);
          this.noteContentCache.set(ref.path, cached);
          resolved.push(cached);
          continue;
        }
        const result = await this.deps.resolver.resolveNote(ref.path);
        if (result) {
          resolved.push(result);
          this.setCacheEntry(ref.path, result);
        }
      }
    }
    const activeAgent = getValidActiveCustomAgent(
      this.deps.runtime.settings.activeCustomAgentId,
      this.deps.runtime.settings.customAgents,
      this.deps.runtime.settings.customSkills,
    );
    const customAgentPrompt = buildCustomAgentPrompt(activeAgent, this.deps.runtime.settings.customSkills);
    const customInstructions = [this.deps.runtime.settings.systemPrompt, customAgentPrompt]
      .filter(Boolean)
      .join('\n\n');
    const sysPrompt = buildSystemPrompt(customInstructions);
    const notesBlock = buildNotesBlock(resolved);
    const combined = [sysPrompt, notesBlock].filter(Boolean).join('\n\n');
    if (combined) parts.push({ type: 'text', text: combined });
    if (historyBlock) parts.push({ type: 'text', text: historyBlock });

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

  /** Rename a local session mirror title (the OpenCode session keeps its own name). */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) return;
    if (this.deps.sessionStore.rename(sessionId, clean)) {
      await this.deps.sessionStore.save();
    }
  }

  /**
   * After the very first exchange, replace the timestamped default title with
   * one derived from the user's opening message. Only fires while the session
   * has exactly one user turn, so manual renames are never revisited.
   */
  private async maybeAutoTitle(): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    const session = this.deps.sessionStore.get(sid);
    if (!session) return;
    const userMsgs = session.messages.filter((m) => m.role === 'user');
    if (userMsgs.length !== 1) return;
    if (!session.messages.some((m) => m.role === 'assistant')) return;
    const title = deriveSessionTitle(userMsgs[0].content);
    if (!title || title === session.title) return;
    if (this.deps.sessionStore.rename(sid, title)) {
      await this.deps.sessionStore.save();
    }
  }

  async exportSessionToNote(): Promise<void> {
    const id = this.state.sessionId;
    const session = id ? this.deps.sessionStore.get(id) : undefined;
    if (!session || session.messages.length === 0) {
      this.deps.renderer.addSystemMessage(t().export.noSession);
      return;
    }
    const markdown = buildTranscriptMarkdown(session);
    const folder = this.deps.runtime.settings.defaultNoteFolder?.trim() ?? '';
    const name = `${sanitizeNoteName(session.title)} ${this.exportTimestamp()}.md`;
    const path = folder ? `${folder}/${name}` : name;
    try {
      await this.deps.runtime.createNote(path, markdown);
      this.deps.renderer.addSystemMessage(t().export.saved.replace('{path}', path));
    } catch (e) {
      this.deps.renderer.addSystemMessage(
        t().export.failed.replace('{error}', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  copyTranscript(): void {
    const id = this.state.sessionId;
    const session = id ? this.deps.sessionStore.get(id) : undefined;
    if (!session || session.messages.length === 0) {
      this.deps.renderer.addSystemMessage(t().export.noSession);
      return;
    }
    void navigator.clipboard.writeText(buildTranscriptMarkdown(session)).then(() => {
      this.deps.renderer.addSystemMessage(t().copy.transcript);
    });
  }

  private exportTimestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    // Time component keeps repeated same-day exports from overwriting each other
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
    );
  }

  // ── Toolbar sync ──

  loadToolbarOptions(): void {
    const c = this.deps.runtime.getClient();
    if (!c) return;

    const snapshot = c.getSessionSnapshot();
    this.state.configOptions = snapshot.configOptions;
    this.state.availableCommands = snapshot.availableCommands;
    this.state.availableModels = snapshot.availableModels;
    this.state.availableModes = snapshot.availableModes;
    this.state.currentModeId = snapshot.currentModeId;

    const configMap = new Map(snapshot.configOptions.map((opt) => [opt.id, opt]));
    const modeConfig = configMap.get('mode');
    const modelConfig = configMap.get('model');
    const effortConfig = configMap.get('effort');

    const agents = snapshot.availableModes.map((mode) => ({ value: mode.id, label: mode.name }));
    const models = this.filterCommonModelOptions(
      snapshot.availableModels.map((model) => ({ value: model.modelId, label: model.name })),
    );
    const ef = t().toolbar.effort;
    const efforts = effortConfig && effortConfig.options.length > 0
      ? effortConfig.options.map((o) => ({ value: o.value, label: normalizeEffortLabel(o.value, o.name) }))
      : [
          { value: 'default', label: ef.default },
          { value: 'low', label: ef.low },
          { value: 'medium', label: ef.medium },
          { value: 'high', label: ef.high },
        ];

    this.deps.toolbar.updateAgents(
      agents,
      snapshot.currentModeId ?? modeConfig?.currentValue ?? this.deps.runtime.settings.defaultAgent,
    );
    this.deps.toolbar.updateModels(
      models,
      snapshot.currentModelId ?? modelConfig?.currentValue ?? this.deps.runtime.settings.defaultModel,
    );
    this.state.currentModelId = snapshot.currentModelId ?? modelConfig?.currentValue ?? null;
    this.deps.toolbar.updateEffort(efforts, effortConfig?.currentValue ?? this.deps.runtime.settings.defaultEffort);
    this.deps.toolbar.updatePermission(this.deps.runtime.settings.permissionMode);
    // Mirror the send-path rule (images are stripped unless supported) so the
    // attach button is only offered when an image could actually be sent.
    const caps = c.getAgentCapabilities?.();
    this.deps.toolbar.setImageAttachEnabled(caps?.promptCapabilities?.image !== false);
  }

  applyConfigOptions(opts: SessionConfigOption[]): void {
    for (const opt of opts) {
      if (opt.id === 'model') {
        this.deps.toolbar.updateModels(
          this.filterCommonModelOptions(opt.options.map((o) => ({ value: o.value, label: o.name }))),
          opt.currentValue,
        );
      }
      if (opt.id === 'effort') {
        this.deps.toolbar.updateEffort(
          opt.options.map((o) => ({ value: o.value, label: normalizeEffortLabel(o.value, o.name) })),
          opt.currentValue,
        );
      }
      if (opt.id === 'mode') {
        this.deps.toolbar.updateAgents(
          opt.options.map((o) => ({ value: o.value, label: o.name })),
          opt.currentValue,
        );
      }
    }
  }

  applyModeUpdate(modeId: string | null, modes: ModeOption[]): void {
    this.deps.toolbar.updateAgents(
      modes.map((m) => ({ value: m.id, label: m.name })),
      modeId ?? undefined,
    );
  }

  applyModelUpdate(modelId: string | null, models: ModelOption[]): void {
    this.deps.toolbar.updateModels(
      this.filterCommonModelOptions(models.map((m) => ({ value: m.modelId, label: m.name }))),
      modelId ?? undefined,
    );
  }

  filterCommonModelOptions(options: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
    return filterCommonModelOptions(
      options,
      this.deps.runtime.settings.commonModels,
      this.deps.runtime.settings.defaultModel,
    );
  }

  // ── Reset ──

  resetConversationView(): void {
    this.deps.inlineEditPanel.clearState();
    this.deps.permissionBanner.dismiss();
    this.endSideChat();
    this.callbacks.onCloseSideChat?.();
    this.deps.welcomeView.hide();
    this.deps.renderer.clear();
    this.streamCtrl.reset();
    ++this.genId;
    this.dropQueuedPrompts();
    this.busy = false;
    this.state.isStreaming = false;
    this.state.usage = null;
    this.deps.updateContextMeter(null);
    this.deps.input.setStreaming(false);
    this.deps.toolbar.setSending(false);
    this.callbacks.onClearUI();
    this.callbacks.onClearChips();
    this.callbacks.onClearPendingImageChips();
  }
}

const QUEUE_PREVIEW_MAX = 48;

function queuePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > QUEUE_PREVIEW_MAX ? `${collapsed.slice(0, QUEUE_PREVIEW_MAX - 1)}…` : collapsed;
}

function isPlainPrompt(entry: { text: string; refs: ContextRef[] }): boolean {
  return entry.refs.length === 0 && parseSlashCommand(entry.text) === null;
}

/** Session-title candidate from the first user message; empty for slash commands. */
export function deriveSessionTitle(text: string): string {
  if (parseSlashCommand(text)) return '';
  return queuePreview(text);
}

export { normalizeEffortLabel } from '../chat/effortLabel';

function buildNotesBlock(resolved: Array<{ name: string; content: string }>): string {
  if (resolved.length === 0) return '';
  const blocks = resolved.map((r) => `=== NOTE: [[${r.name}]] ===\n${r.content}\n=== END NOTE ===`);
  return (
    'The user has referenced the following Obsidian notes in their message.\n' +
    'You should consider their content as relevant context for your response:\n\n' +
    blocks.join('\n\n')
  );
}
