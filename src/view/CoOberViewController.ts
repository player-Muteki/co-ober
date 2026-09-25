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
import type { CoOberSettings, StoredDraft, TabShell } from '../types';
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
import { SessionRuntime } from '../chat/sessionRuntime';
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
import { AcpTimeoutError, AcpProcessExitError, AcpAbortError, AcpSessionMissingError, AcpStreamCapacityError } from '../client/AcpErrors';
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
import type { CommandScope } from '../commands/registry';
import { parseSlashCommand } from '../commands/executor';
import {
  NOTECACHE_MAX_SIZE,
  MAX_CONCURRENT_STREAMS,
  MIN_OPEN_TABS,
  MAX_OPEN_TABS,
  DEFAULT_OPEN_TABS,
} from '../constants';

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
  onOpenSideChat?(ask: SideChatAsk, question: string, tabId: string): void;
  /** Tear the side-chat panel belonging to one tab down. */
  onCloseSideChat?(tabId: string): void;
  /** The tab strip changed shape or state; the bar should re-render. */
  onTabsChanged?(): void;
  /** Unsent composer text per open tab, keyed by live tab id. */
  onCollectDrafts?(): Record<string, StoredDraft | undefined>;
  /** Hand the stored drafts back, re-keyed to the tabs that were just opened. */
  onRestoreDrafts?(drafts: Record<string, StoredDraft>): void;
}

/** One badge of the tab strip. */
export interface TabDescriptor {
  tabId: string;
  index: number;
  title: string;
  streaming: boolean;
  queued: boolean;
  unread: boolean;
  active: boolean;
}

export interface ControllerRuntime {
  readonly settings: CoOberSettings;
  getClient(): OpencodeClient | null;
  initClient(): Promise<boolean>;
  getVaultCwd(): string;
  /** Write a markdown note into the vault, creating parent folders as needed. */
  createNote(path: string, content: string): Promise<void>;
}

/** A tab's message surface, created by the view when the controller opens a tab. */
export interface TabPanel {
  renderer: ChatRenderer;
}

export interface ControllerDeps {
  /** Fallback surface for hosts without per-tab panels; createTabPanel wins. */
  renderer?: ChatRenderer;
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
  /** Create (and let the view show/hide) a message panel for a new tab. */
  createTabPanel?(tabId: string): TabPanel;
  /** Tear down the panel created for a closed tab. */
  disposeTabPanel?(tabId: string): void;
  /** Fired after the active tab flips: the view swaps panels, drafts and welcome. */
  onActiveTabChanged?(prevTabId: string | null, tabId: string): void;
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
  /** A drained turn replays the image parts it carried, not the live chips. */
  capturedImageParts?: PromptPart[];
}

export class CoOberViewController {
  private sessionMutex = new Mutex();
  private runtimes = new Map<string, SessionRuntime>();
  private activeRuntime!: SessionRuntime;
  private tabSeq = 0;
  private persistFailed = false;
  private unsubscribeLocale: (() => void) | null = null;
  queueIndicatorEl: HTMLDivElement | null = null;

  // Single-tab API surface: these proxy to the active tab so existing
  // consumers (view, commands, tests) keep addressing one conversation.
  get state(): ChatState {
    return this.activeRuntime.state;
  }
  private get streamCtrl(): StreamController {
    return this.activeRuntime.streamCtrl;
  }
  private get busy(): boolean {
    return this.activeRuntime.busy;
  }
  private set busy(v: boolean) {
    this.activeRuntime.busy = v;
  }
  /** Message surface of the active tab — what user-visible output targets. */
  private get renderer(): ChatRenderer {
    return this.activeRuntime.renderer;
  }

  constructor(
    private deps: ControllerDeps,
    private callbacks: ControllerCallbacks,
  ) {
    this.activeRuntime = this.openRuntime(null);

    // Register builtin slash commands
    this.registerBuiltinCommands();
    // Builtin titles/descriptions are captured at registration time, so
    // re-register them whenever the locale changes.
    this.unsubscribeLocale = onLocaleChange(() => this.registerBuiltinCommands());
  }

  // ── Tab runtime management ──

  private openRuntime(sessionId: string | null): SessionRuntime {
    const tabId = `tab-${++this.tabSeq}`;
    const renderer = this.deps.createTabPanel?.(tabId)?.renderer ?? this.deps.renderer;
    if (!renderer) throw new Error('CoOberViewController requires createTabPanel or a renderer dep');
    const rt = new SessionRuntime(tabId, sessionId, renderer);
    rt.state.autoScrollEnabled = this.deps.runtime.settings.autoScrollEnabled ?? true;
    rt.streamCtrl = new StreamController({
      state: rt.state,
      renderer: rt.renderer,
      syncEngine: this.deps.syncEngine,
      sessionStore: this.deps.sessionStore,
      getSessionId: () => rt.sessionId,
      onConfigUpdate: (opts) => this.applyConfigOptions(opts, rt),
      onModeUpdate: (modeId, modes) => this.applyModeUpdate(modeId, modes, rt),
      onModelsUpdate: (modelId, models) => this.applyModelUpdate(modelId, models, rt),
      onCommandsUpdate: (commands) => {
        // The slash menu is one shared surface; only the tab in view speaks
        // through it. A background tab's list stays in its own state and is
        // re-projected when that tab comes forward (loadToolbarOptions).
        if (rt === this.activeRuntime) commandRegistry.updateAcpCommands(commands);
      },
      onUsageUpdate: () => {
        if (rt === this.activeRuntime) this.deps.updateContextMeter(rt.state.usage);
      },
      onSyncFailure: (message) => rt.renderer.addError(message),
      onPersistFailure: () => this.reportPersistence(true),
    });
    this.runtimes.set(tabId, rt);
    return rt;
  }

  private isActiveTab(rt: SessionRuntime): boolean {
    return rt === this.activeRuntime;
  }

  listTabIds(): string[] {
    return [...this.runtimes.keys()];
  }

  runtimeForTab(tabId: string): SessionRuntime | undefined {
    return this.runtimes.get(tabId);
  }

  /**
   * The tab a dispatched slash command belongs to. A scope naming a tab that is
   * already gone means the command lost its conversation while it waited, so it
   * runs nowhere — rather than against whichever tab happens to be on screen.
   */
  private scopeRuntime(scope?: CommandScope): SessionRuntime | null {
    if (!scope) return this.activeRuntime;
    return this.runtimes.get(scope.tabId) ?? null;
  }

  activeTabId(): string {
    return this.activeRuntime.tabId;
  }

  tabIndexOf(rt: SessionRuntime): number {
    return this.listTabIds().indexOf(rt.tabId);
  }

  switchToTab(tabId: string): void {
    const rt = this.runtimes.get(tabId);
    if (rt) this.activateRuntime(rt);
  }

  private activateRuntime(rt: SessionRuntime): void {
    if (this.activeRuntime === rt) return;
    const prev = this.activeRuntime;
    prev?.renderer.setActive(false);
    this.activeRuntime = rt;
    rt.renderer.setActive(true);
    rt.unread = false;
    this.deps.onActiveTabChanged?.(prev?.tabId ?? null, rt.tabId);
    if (rt.sessionId) this.deps.sessionStore.setActive(rt.sessionId);
    this.loadToolbarOptions();
    this.updateQueueIndicator();
    // A tab restored from disk is only painted once the user actually looks
    // at it; until then its panel stays empty and cheap.
    void this.ensurePainted(rt);
    this.notifyTabsChanged();
    this.persistTabShell();
  }

  /** Close one tab: cancels only its own stream, disposes only its panel. */
  async closeTab(tabId: string): Promise<void> {
    const rt = this.runtimes.get(tabId);
    if (!rt) return;
    const client = this.deps.runtime.getClient();
    if (rt.busy) {
      ++rt.genId;
      rt.busy = false;
      rt.state.isStreaming = false;
      rt.streamCtrl.finalizeBufferedToolCalls();
      if (client && rt.sessionId) {
        try {
          await client.cancel(rt.sessionId);
        } catch (e) {
          console.error('[co-ober] cancel closed tab:', e);
        }
      }
    }
    const wasActive = rt === this.activeRuntime;
    // Prompts waiting in a closed tab are gone; say so like every other drop.
    this.dropQueuedPrompts(rt);
    // Its scratch thread goes with it: a fork nobody can reach again would
    // stay open on the agent side for the rest of the session.
    this.endSideChat(rt);
    this.callbacks.onCloseSideChat?.(tabId);
    this.runtimes.delete(tabId);
    this.deps.disposeTabPanel?.(tabId);
    await rt.streamCtrl.dispose();
    if (wasActive) {
      const next = [...this.runtimes.values()].pop();
      if (next) {
        this.activateRuntime(next);
      } else {
        this.activeRuntime = this.openRuntime(null);
        this.updateQueueIndicator();
        this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
        this.callbacks.onAutoRefActiveFile();
      }
    }
    this.notifyTabsChanged();
    this.persistTabShell();
  }

  // ── Tab strip ──

  /** What each badge of the strip shows, in strip order. */
  tabDescriptors(): TabDescriptor[] {
    return this.listTabIds().map((tabId, index) => {
      const rt = this.runtimes.get(tabId) as SessionRuntime;
      const title = rt.sessionId ? this.deps.sessionStore.get(rt.sessionId)?.title : undefined;
      return {
        tabId,
        index,
        title: title?.trim() ? title : t().tabs.untitled,
        streaming: rt.busy,
        queued: rt.promptQueue.length > 0,
        unread: rt.unread,
        active: rt === this.activeRuntime,
      };
    });
  }

  maxOpenTabs(): number {
    const raw = this.deps.runtime.settings.maxOpenTabs ?? DEFAULT_OPEN_TABS;
    return Math.min(MAX_OPEN_TABS, Math.max(MIN_OPEN_TABS, Math.trunc(raw)));
  }

  canOpenTab(): boolean {
    return this.runtimes.size < this.maxOpenTabs();
  }

  /** True when no tab can be opened; a full strip says so instead of failing quietly. */
  private tabLimitReached(): boolean {
    if (this.canOpenTab()) return false;
    new Notice(t().tabs.limitReached.replace('{max}', String(this.maxOpenTabs())));
    return true;
  }

  switchToTabByIndex(index: number): void {
    const tabId = this.listTabIds()[index];
    if (tabId) this.switchToTab(tabId);
  }

  /** Paint a restored tab's stored transcript the first time the user looks at it. */
  async ensurePainted(rt: SessionRuntime): Promise<void> {
    if (!rt.needsRestore || rt.painted) return;
    rt.needsRestore = false;
    if (!rt.sessionId) return;
    if (!this.deps.sessionStore.get(rt.sessionId)) {
      // Retention pruned the conversation the tab pointed at; an empty panel
      // with no explanation reads like a bug.
      rt.renderer.addSystemMessage(t().tabs.dangling);
      return;
    }
    await this.restoreSession(rt);
  }

  /** Startup hook: the tab in front gets its transcript immediately. */
  restoreActiveTab(): Promise<void> {
    return this.ensurePainted(this.activeRuntime);
  }

  /**
   * Rebuild yesterday's strip. Every shell opens as a panel first, so ordering
   * is stable, and only then does the stored front tab come forward — a tab
   * that is not in front stays unpainted until it is clicked.
   */
  restoreTabShells(shells: TabShell[], activeTabId: string | null): void {
    if (shells.length === 0) return;
    const byShellTabId = new Map<string, SessionRuntime>();
    const adopted = this.activeRuntime;
    adopted.sessionId = shells[0].sessionId;
    adopted.needsRestore = true;
    byShellTabId.set(shells[0].tabId, adopted);
    for (const shell of shells.slice(1)) {
      const rt = this.openRuntime(shell.sessionId);
      rt.needsRestore = true;
      byShellTabId.set(shell.tabId, rt);
    }
    const front = (activeTabId ? byShellTabId.get(activeTabId) : undefined) ?? adopted;
    if (front !== adopted) this.activateRuntime(front);
    const drafts: Record<string, StoredDraft> = {};
    for (const shell of shells) {
      const rt = shell.draft ? byShellTabId.get(shell.tabId) : undefined;
      if (rt) drafts[rt.tabId] = shell.draft!;
    }
    if (Object.keys(drafts).length > 0) this.callbacks.onRestoreDrafts?.(drafts);
    this.notifyTabsChanged();
    this.persistTabShell();
  }

  private notifyTabsChanged(): void {
    this.callbacks.onTabsChanged?.();
  }

  /** Which conversations — and which half-typed messages — sit in which tabs. */
  persistTabShell(): void {
    const drafts = this.callbacks.onCollectDrafts?.() ?? {};
    const shells: TabShell[] = this.listTabIds().map((tabId) => {
      const shell: TabShell = {
        tabId,
        sessionId: this.runtimes.get(tabId)?.sessionId ?? null,
      };
      const draft = drafts[tabId];
      if (draft) shell.draft = draft;
      return shell;
    });
    this.deps.sessionStore.setTabShell(shells, this.activeRuntime.tabId);
  }

  /**
   * A failed write to data.json loses every tab at once, so every tab says so —
   * once per streak. The plugin owns the streak because it owns the write; a
   * swallowed error that never reaches the caller would otherwise leave the
   * transcripts looking saved.
   */
  reportPersistence(failed: boolean): void {
    if (failed === this.persistFailed) return;
    this.persistFailed = failed;
    if (!failed) return;
    for (const rt of this.runtimes.values()) rt.renderer.addSystemMessage(t().session.notSaved);
  }

  /** Cancel every in-flight stream (view close); tabs' queues are not restored. */
  async cancelAllStreams(): Promise<void> {
    const client = this.deps.runtime.getClient();
    for (const rt of this.runtimes.values()) {
      if (!rt.busy) continue;
      ++rt.genId;
      rt.busy = false;
      rt.state.isStreaming = false;
      rt.streamCtrl.finalizeBufferedToolCalls();
      if (client && rt.sessionId) {
        try {
          await client.cancel(rt.sessionId);
        } catch (e) {
          console.error('[co-ober] cancel on close:', e);
        }
      }
    }
    this.deps.input.setStreaming(false);
    this.deps.toolbar.setSending(false);
  }

  private setConnectedFlags(v: boolean): void {
    for (const rt of this.runtimes.values()) rt.state.isConnected = v;
  }

  private streamSlotsFree(client: OpencodeClient | null): boolean {
    const count = client?.activeStreamCount?.();
    return count === undefined || count < MAX_CONCURRENT_STREAMS;
  }

  /**
   * After any turn release: every idle tab with queued prompts gets a drain
   * attempt, bounded by the shared stream budget. Fire-and-forget — a full
   * budget leaves heads parked until the next release.
   */
  private tryDrainAnyQueue(): void {
    const client = this.deps.runtime.getClient();
    for (const rt of this.runtimes.values()) {
      if (rt.busy || rt.promptQueue.length === 0) continue;
      if (!this.streamSlotsFree(client)) break;
      void this.drainQueue(rt).catch((e) => console.error('[co-ober] queue drain:', e));
    }
  }

  private registerBuiltinCommands(): void {
    const registry = commandRegistry;
    const client = () => this.deps.runtime.getClient();
    const caps = () => client()?.getAgentCapabilities?.();
    // `scope` is the tab the command was typed into. Every body below runs
    // against that tab — a command drained out of a queue fires long after the
    // user may have clicked elsewhere, and must not rewrite that other tab.

    registry.registerBuiltin({
      id: 'compact',
      trigger: 'compact',
      aliases: ['summarize'],
      title: t().slashTitles.compact,
      description: t().slash.compact,
      category: 'session',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (rt) await this.compactSession(rt);
      },
    });
    registry.registerBuiltin({
      id: 'new',
      trigger: 'new',
      title: t().slashTitles.new,
      description: t().slash.new,
      category: 'session',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (rt) await this.createNewSession(rt);
      },
    });
    registry.registerBuiltin({
      id: 'clear',
      trigger: 'clear',
      title: t().slashTitles.clear,
      description: t().slash.clear,
      category: 'view',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt) return;
        // Cancel while the turn is still marked busy, then hand the tab to the
        // one reset path: a cleared tab must drop its stream controller, its
        // painted markers and its queue, or stale frames keep landing on it.
        await this.cancelActiveGeneration(rt);
        rt.state.clear();
        this.resetRuntimeView(rt);
        if (this.isActiveTab(rt)) this.callbacks.onShowWelcome(true);
      },
    });
    registry.registerBuiltin({
      id: 'help',
      trigger: 'help',
      title: t().slashTitles.help,
      description: t().slash.help,
      category: 'view',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt) return;
        const cmds = registry.getAll();
        const helpText = cmds
          .map((c) => `- **/${c.trigger}**${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.description}`)
          .join('\n');
        rt.renderer.addUserMessage('/help');
        rt.renderer.addSystemMessage(`### ${t().slash.helpHeader}\n\n${helpText}`);
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
      run: async (args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        const c = client();
        if (!c || !rt?.state.sessionId) return;
        const path = args.trim() || this.getVaultCwd();
        await this.sendTextToAgent(`/add-dir ${path}`, undefined, rt);
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
      run: async (args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt) return;
        const id = args.trim();
        if (id) {
          await this.resumeSession(id, rt);
          return;
        }
        // The picker is a screen surface; a tab that is not on screen gets the
        // hint in its own transcript instead of opening a dialog for someone
        // else's conversation.
        if (this.isActiveTab(rt) && this.callbacks.onOpenSessions) this.callbacks.onOpenSessions();
        else rt.renderer.addSystemMessage(t().slash.resumeHint);
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
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt?.state.sessionId) return;
        await this.forkSession(rt.state.sessionId);
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
      run: async (args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (rt) await this.startSideChat(args.trim(), rt);
      },
    });
    registry.registerBuiltin({
      id: 'export',
      trigger: 'export',
      title: t().slashTitles.export,
      description: t().slash.export,
      category: 'session',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (rt) await this.exportSessionToNote(rt);
      },
    });
    registry.registerBuiltin({
      id: 'copy',
      trigger: 'copy',
      title: t().slashTitles.copy,
      description: t().slash.copy,
      category: 'session',
      source: 'builtin',
      run: async (_args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (rt) this.copyTranscript(rt);
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
      run: async (args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt) return;
        const modelId = args.trim();
        if (!modelId) {
          rt.renderer.addSystemMessage(
            `${t().slash.availableModels}\n${rt.state.availableModels.map((m) => `- \`${m.modelId}\`: ${m.name}`).join('\n')}`,
          );
          return;
        }
        const c = client();
        if (!c || !rt.state.sessionId) return;
        await c.setModel(rt.state.sessionId, modelId);
        rt.renderer.addSystemMessage(`${t().slash.modelSwitched} \`${modelId}\``);
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
      run: async (args: string, scope?: CommandScope) => {
        const rt = this.scopeRuntime(scope);
        if (!rt) return;
        const modeId = args.trim();
        if (!modeId) {
          rt.renderer.addSystemMessage(
            `${t().slash.availableModes}\n${rt.state.availableModes.map((m) => `- \`${m.id}\`: ${m.name}`).join('\n')}`,
          );
          return;
        }
        const c = client();
        if (!c || !rt.state.sessionId) return;
        await c.setMode(rt.state.sessionId, modeId);
        rt.renderer.addSystemMessage(`${t().slash.modeSwitched} \`${modeId}\``);
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
    for (const rt of this.runtimes.values()) this.dropQueuedPrompts(rt);
    for (const rt of this.runtimes.values()) this.endSideChat(rt);
    for (const rt of this.runtimes.values()) await rt.streamCtrl.dispose();
    this.noteContentCache.clear();
  }

  // ── Connection ──

  async ensureClientConnected(): Promise<boolean> {
    const existing = this.deps.runtime.getClient();
    if (existing?.isConnected()) {
      this.setConnectedFlags(true);
      this.bindClientHandlers();
      this.callbacks.onHideReconnectBtn();
      this.deps.welcomeView.updateStatus(true);
      await this.syncSavedSessionAndLoadToolbar();
      return true;
    }

    const connected = await this.deps.runtime.initClient();
    this.setConnectedFlags(connected);
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
    for (const rt of this.runtimes.values()) {
      if (!rt.state.sessionId) continue;
      try {
        await this.syncRuntimeSession(rt.state.sessionId, undefined, rt);
      } catch (e) {
        console.error('[co-ober] session sync on connect:', e);
        this.notifyLostSession(e, rt);
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
        this.setConnectedFlags(true);
        this.deps.welcomeView.updateStatus(true);
        this.callbacks.onHideReconnectBtn();
        for (const rt of this.runtimes.values()) {
          if (!rt.state.sessionId) continue;
          try {
            await this.syncRuntimeSession(rt.state.sessionId, undefined, rt);
          } catch (e) {
            console.error('[co-ober] session resync:', e);
            this.notifyLostSession(e, rt);
          }
        }
        this.loadToolbarOptions();
        for (const rt of this.runtimes.values()) {
          if (!rt.busy) continue;
          ++rt.genId;
          rt.busy = false;
          rt.state.isStreaming = false;
          rt.streamCtrl.finalizeBufferedToolCalls();
          if (rt === this.activeRuntime) {
            this.deps.input.setStreaming(false);
            this.deps.toolbar.setSending(false);
            this.renderer.finalizeCurrentThinking();
            this.renderer.removeAssistantPlaceholder();
            this.renderer.addError(t().error.reconnected);
          }
          void this.tryDrainAnyQueue();
        }
      },
      onReconnectFailed: () => {
        this.renderer.addError(t().error.reconnectFailed);
        this.handleDisconnect();
      },
      onPermissionUnreadable: () => {
        this.renderer.addError(t().permission.unreadable);
      },
      onElicitationComplete: (elicitationId) => {
        this.deps.permissionBanner.resolveExternally(elicitationId);
      },
      onPermissionRequest: async (req) => {
        if (client.permissionMode !== 'safe') {
          return (
            client.requestPermission?.(req) ??
            Promise.resolve(
              req.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always')
                ?.optionId ?? 'reject_once',
            )
          );
        }
        const rt = this.findRuntimeBySession(req.sessionId);
        const origin =
          rt && rt !== this.activeRuntime
            ? {
                label: t().permission.originTab.replace('{index}', String(this.tabIndexOf(rt) + 1)),
                onFocus: () => this.activateRuntime(rt),
              }
            : undefined;
        return this.deps.permissionBanner.show(req, origin);
      },
    });
  }

  private findRuntimeBySession(sessionId: string | null | undefined): SessionRuntime | undefined {
    if (!sessionId) return undefined;
    for (const rt of this.runtimes.values()) {
      if (rt.state.sessionId === sessionId) return rt;
    }
    return undefined;
  }

  handleDisconnect(): void {
    this.setConnectedFlags(false);
    for (const rt of this.runtimes.values()) {
      rt.streamCtrl.reset();
      ++rt.genId;
      rt.busy = false;
      rt.state.isStreaming = false;
      rt.state.usage = null;
    }
    this.deps.permissionBanner.dismiss();
    this.renderer.removeAssistantPlaceholder();
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
      for (const rt of this.runtimes.values()) {
        if (!rt.state.sessionId) continue;
        try {
          await this.syncRuntimeSession(rt.state.sessionId, undefined, rt);
        } catch (e) {
          console.error('[co-ober] session resync:', e);
          this.notifyLostSession(e, rt);
        }
      }
      this.loadToolbarOptions();
      this.setConnectedFlags(true);
      this.deps.welcomeView.updateStatus(true);
      this.callbacks.onHideReconnectBtn();
    } catch (e) {
      console.error('[co-ober] reconnect failed:', e);
      throw e;
    }
  }

  // ── Session lifecycle ──

  async syncRuntimeSession(
    sessionId: string | null,
    onReplayUpdate?: (u: NormalizedUpdate) => void,
    rt: SessionRuntime = this.activeRuntime,
  ): Promise<void> {
    if (!sessionId) return;
    return this.sessionMutex.runExclusive(async () => {
      const client = this.deps.runtime.getClient();
      if (!client) return;
      // "Already loaded" is per session, not a single current-session pointer:
      // with several tabs open the client may legitimately hold many.
      const loaded = client.isSessionLoaded
        ? client.isSessionLoaded(sessionId)
        : client.getCurrentSessionId() === sessionId;
      if (loaded) return;
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
        rt.renderer.addSystemMessage(message);
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
  notifyLostSession(err: unknown, rt: SessionRuntime = this.activeRuntime): boolean {
    if (err instanceof AcpSessionMissingError) {
      rt.renderer.addSystemMessage(t().session.runtimeSessionLost);
      return true;
    }
    // Any other resync failure means the transcript the user sees may be
    // stale — say so instead of leaving it in the console.
    rt.renderer.addError(
      `${t().session.syncFailed}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  async cancelActiveGeneration(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client || !rt.busy || !rt.state.sessionId) return;
    try {
      await client.cancel(rt.state.sessionId);
    } catch (e) {
      console.error('[co-ober] cancel:', e);
    }
  }

  async compactSession(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    // Cancel any active generation, then send /compact through the ACP agent
    await this.cancelActiveGeneration(rt);
    await this.sendTextToAgent('/compact', undefined, rt);
  }

  async createNewSession(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    await this.newSession(false, rt);
  }

  /**
   * A tab may host the next session without a new tab when it holds no
   * in-flight turn and nothing the user could lose (no session, or an empty
   * transcript).
   */
  private canAdoptTab(rt: SessionRuntime): boolean {
    if (rt.busy) return false;
    if (!rt.state.sessionId) return true;
    const session = this.deps.sessionStore.get(rt.state.sessionId);
    return (session?.messages.length ?? 0) === 0;
  }

  private canAdoptActiveTab(): boolean {
    return this.canAdoptTab(this.activeRuntime);
  }

  /**
   * `/new` may reuse the tab it was typed in; the strip's "+" (`forceNewTab`)
   * always opens another one so the conversation in view is never replaced.
   */
  async newSession(forceNewTab = false, homeTab: SessionRuntime = this.activeRuntime): Promise<void> {
    await this.deps.sessionStore.save();
    const connected = await this.ensureClientConnected();
    if (!connected) return;
    const c = this.deps.runtime.getClient();
    if (!c) return;

    // A streaming tab is never stolen: /new opens a fresh tab beside it.
    const adopt = !forceNewTab && this.canAdoptTab(homeTab);
    if (!adopt && this.tabLimitReached()) return;
    const rt = adopt ? homeTab : this.openRuntime(null);
    if (!adopt) this.activateRuntime(rt);
    else this.resetRuntimeView(rt);

    try {
      await this.sessionMutex.runExclusive(async () => {
        const sid = await c.createSession(this.getVaultCwd(), this.deps.runtime.settings.mcpServers);
        rt.state.sessionId = sid;
        await applyDefaultSessionSettings(c, sid, this.deps.runtime.settings);
      });
      if (rt.state.sessionId) {
        this.deps.sessionStore.getOrCreate(rt.state.sessionId);
        if (this.isActiveTab(rt)) this.deps.sessionStore.setActive(rt.state.sessionId);
      }
      await this.deps.sessionStore.save();
      this.loadToolbarOptions(rt);
      if (this.isActiveTab(rt)) {
        this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
        this.callbacks.onAutoRefActiveFile();
      }
      // The badge tooltip and the restored shell both key off the session id,
      // which only exists now that the create succeeded.
      this.notifyTabsChanged();
      this.persistTabShell();
    } catch (e) {
      console.error('[co-ober] newSession:', e);
      rt.renderer.addError(e instanceof Error ? e.message : String(e));
    }
  }

  async restoreSession(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    if (!rt.state.sessionId) return;
    const session = this.deps.sessionStore.get(rt.state.sessionId);
    if (!session) return;
    const gen = rt.genId;
    const sid = rt.state.sessionId;
    await this.enrichMessagesFromNative(session);
    // A session switch during enrichment resets the view and repoints
    // sessionId; painting this transcript then would render A's messages
    // into B's freshly cleared panel.
    if (rt.genId !== gen || rt.state.sessionId !== sid) return;
    let idx = 0;
    for (const msg of session.messages) {
      const restoreId = `restore-${msg.timestamp}-${idx++}`;
      if (msg.role === 'user') {
        rt.renderer.addUserMessage(msg.content, msg.timestamp, msg.images);
      } else if (msg.role === 'system') {
        rt.renderer.addSystemMessage(msg.content);
      } else if (msg.role === 'assistant') {
        if (msg.contentBlocks && msg.contentBlocks.length > 0) {
          rt.renderer.renderStructuredMessage(msg);
        } else if (msg.type === 'thinking') {
          rt.renderer.appendThinking(msg.content, restoreId, msg.timestamp);
        } else {
          rt.renderer.appendText(msg.content, restoreId, msg.timestamp, msg.usage, msg.turnStats);
        }
      }
    }
    rt.renderer.collapseTurns?.();
    rt.painted = true;
    await this.refreshNativePlan(session.sessionId, rt);
  }

  async ensureRuntimeSession(rt: SessionRuntime = this.activeRuntime): Promise<string | null> {
    if (!(await this.ensureClientConnected())) return null;
    const client = this.deps.runtime.getClient();
    if (!client) return null;

    if (rt.state.sessionId) {
      try {
        await this.syncRuntimeSession(rt.state.sessionId, undefined, rt);
      } catch (e) {
        console.error('[co-ober] session sync failed, creating new session:', e);
        rt.state.sessionId = null;
      }
      this.loadToolbarOptions(rt);
      if (rt.state.sessionId) return rt.state.sessionId;
    }

    try {
      await this.sessionMutex.runExclusive(async () => {
        const sid = await client.createSession(this.getVaultCwd(), this.deps.runtime.settings.mcpServers);
        rt.state.sessionId = sid;
        await applyDefaultSessionSettings(client, sid, this.deps.runtime.settings);
      });
      if (rt.state.sessionId) {
        this.deps.sessionStore.getOrCreate(rt.state.sessionId);
        if (this.isActiveTab(rt)) this.deps.sessionStore.setActive(rt.state.sessionId);
      }
      await this.deps.sessionStore.save();
      this.loadToolbarOptions(rt);
      return rt.state.sessionId;
    } catch (e) {
      console.error('[co-ober] session init:', e);
      rt.renderer.addError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // ── Session dropdown actions ──

  async switchSession(sessionId: string, source?: 'local' | 'opencode'): Promise<void> {
    // A session that already lives in a tab only takes focus — looking at a
    // conversation never cancels its stream.
    const existing = this.findRuntimeBySession(sessionId);
    if (existing) {
      if (existing !== this.activeRuntime) this.activateRuntime(existing);
      return;
    }
    // Otherwise the current tab is repurposed when it has nothing to lose,
    // and a background-streaming tab keeps its screen by opening a new one.
    const adopt = this.canAdoptActiveTab();
    if (!adopt && this.tabLimitReached()) return;
    const rt = adopt ? this.activeRuntime : this.openRuntime(sessionId);
    if (adopt) this.resetRuntimeView(rt);
    else this.activateRuntime(rt);
    rt.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    try {
      const collector = new SessionReplayCollector();
      await this.syncRuntimeSession(sessionId, (u) => collector.handle(u), rt);
      await this.adoptReplay(sessionId, collector.finish());
      if (source === 'opencode') {
        rt.renderer.addSystemMessage(t().session.loadedNative);
      }
    } catch (e) {
      console.error('[co-ober] session switch sync:', e);
      if (source === 'opencode') {
        rt.renderer.addError(
          e instanceof AcpSessionMissingError ? t().session.nativeSessionMissing : t().session.loadNativeFailed,
        );
      }
    }
    await this.restoreSession(rt);
    if (source === 'opencode') await this.refreshNativeUsage(sessionId, undefined, rt);
    if (this.isActiveTab(rt)) this.deps.sessionStore.setActive(sessionId);
    await this.deps.sessionStore.save();
    this.loadToolbarOptions();
    if (this.isActiveTab(rt)) {
      this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
      this.callbacks.onAutoRefActiveFile();
    }
    this.notifyTabsChanged();
    this.persistTabShell();
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deps.sessionStore.remove(sessionId);
    await this.deps.sessionStore.save();
    const rt = this.findRuntimeBySession(sessionId);
    if (!rt) return;
    await this.closeTab(rt.tabId);
    // Losing the shown conversation must land the user on a fresh session,
    // exactly like before tabs existed.
    if (!this.activeRuntime.state.sessionId) await this.newSession();
  }

  async forkSession(sessionId: string): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) return;
    // A fork always lands in its own tab, so a full strip refuses the fork
    // rather than silently replacing what is on screen.
    if (this.tabLimitReached()) return;
    try {
      const source = this.deps.sessionStore.get(sessionId);
      const forkedId = await client.forkSession(sessionId, this.getVaultCwd());
      // A fork is a conversation branch: it opens as its own tab so the
      // original stays exactly where it was.
      const rt = this.openRuntime(forkedId);
      this.activateRuntime(rt);
      const forked = this.deps.sessionStore.getOrCreate(forkedId);
      if (source && forked.messages.length === 0) {
        forked.messages.push(...source.messages.map((m) => ({ ...m })));
        forked.title = source.title;
        forked.updatedAt = Date.now();
      }
      this.deps.sessionStore.setActive(forkedId);
      await this.deps.sessionStore.save();
      const collector = new SessionReplayCollector();
      await this.syncRuntimeSession(forkedId, (u) => collector.handle(u), rt);
      await this.adoptReplay(forkedId, collector.finish());
      await this.restoreSession(rt);
      this.loadToolbarOptions();
      this.callbacks.onShowWelcome(true);
      this.notifyTabsChanged();
      this.persistTabShell();
    } catch (e) {
      console.error('[co-ober] fork session:', e);
      this.renderer.addError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Side chat (/btw) ──

  /**
   * Fork the current conversation into a scratch thread and hand a bound
   * questioner to the view's side-chat panel. The main session is never
   * touched: no transcript, store or toolbar state changes here.
   */
  async startSideChat(question: string, rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) {
      rt.renderer.addError(t().sideChat.notConnected);
      return;
    }
    if (client.getAgentCapabilities?.()?.sessionCapabilities?.fork !== true) {
      rt.renderer.addError(t().sideChat.forkUnsupported);
      return;
    }
    if (rt.busy) {
      rt.renderer.addSystemMessage(t().sideChat.busy);
      return;
    }
    try {
      if (!rt.sideChatSessionId) {
        const parent = await this.ensureRuntimeSession(rt);
        if (!parent) return;
        rt.sideChatSessionId = await client.forkSession(parent, this.getVaultCwd());
      }
      this.callbacks.onOpenSideChat?.(this.buildSideChatAsk(rt), question, rt.tabId);
    } catch (e) {
      console.error('[co-ober] side chat fork:', e);
      rt.renderer.addError(t().sideChat.failed.replace('{error}', e instanceof Error ? e.message : String(e)));
    }
  }

  private buildSideChatAsk(rt: SessionRuntime): SideChatAsk {
    return async (text, onChunk) => {
      const client = this.deps.runtime.getClient();
      const sideId = rt.sideChatSessionId;
      if (!client || !sideId) throw new Error(t().sideChat.notConnected);
      return client.sendMessage(sideId, [{ type: 'text', text }], onChunk);
    };
  }

  /** Close and release one tab's side session; the panel's onClose hook calls this. */
  endSideChat(rt: SessionRuntime = this.activeRuntime): void {
    const sideId = rt.sideChatSessionId;
    rt.sideChatSessionId = null;
    if (!sideId) return;
    const client = this.deps.runtime.getClient();
    if (client?.getAgentCapabilities?.()?.sessionCapabilities?.close) {
      void client.closeSession(sideId).catch((e) => console.error('[co-ober] close side session:', e));
    }
  }

  /** Cancel a still-streaming side-chat turn; the panel calls this when closed mid-answer. */
  abortSideChat(tabId?: string): void {
    const rt = tabId ? this.runtimes.get(tabId) : this.activeRuntime;
    const sideId = rt?.sideChatSessionId;
    if (!sideId) return;
    const client = this.deps.runtime.getClient();
    if (!client) return;
    void client.cancel(sideId).catch((e) => console.warn('[co-ober] side chat cancel:', e));
  }

  async resumeSession(sessionId: string, homeTab?: SessionRuntime): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) return;
    const home = homeTab ?? this.activeRuntime;
    // Mirror switchSession's tab semantics: an open session just takes focus;
    // otherwise the current tab is adopted when idle-and-empty, or a new tab
    // leaves the streaming one untouched.
    const existing = this.findRuntimeBySession(sessionId);
    if (existing) {
      if (existing !== this.activeRuntime) this.activateRuntime(existing);
      return;
    }
    const adopt = this.canAdoptTab(home);
    if (!adopt && this.tabLimitReached()) return;
    const rt = adopt ? home : this.openRuntime(sessionId);
    if (adopt) this.resetRuntimeView(rt);
    else this.activateRuntime(rt);
    rt.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    const collector = new SessionReplayCollector();
    try {
      await this.sessionMutex.runExclusive(async () => {
        await client.resumeSession(sessionId, this.getVaultCwd(), (u) => collector.handle(u));
      });
      await this.adoptReplay(sessionId, collector.finish());
    } catch (e) {
      console.error('[co-ober] session resume:', e);
      rt.renderer.addError(e instanceof Error ? e.message : String(e));
    }
    await this.restoreSession(rt);
    // The transcript swap cleared state usage (it belonged to the outgoing
    // session); hand refreshNativeUsage the resumed session's own currency
    // hint from its enriched rows so it can't flatly fall back to USD.
    const costCurrencyFromMessages = (this.deps.sessionStore.get(sessionId)?.messages ?? [])
      .map((m) => m.usage?.costCurrency)
      .find((c): c is string => typeof c === 'string' && c.length > 0);
    await this.refreshNativeUsage(sessionId, costCurrencyFromMessages, rt);
    await this.refreshNativePlan(sessionId, rt);
    if (this.isActiveTab(rt)) this.deps.sessionStore.setActive(sessionId);
    await this.deps.sessionStore.save();
    this.notifyTabsChanged();
    this.persistTabShell();
    this.loadToolbarOptions(rt);
    if (this.isActiveTab(rt)) {
      this.callbacks.onShowWelcome(this.deps.runtime.getClient() !== null);
      this.callbacks.onAutoRefActiveFile();
    }
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
      this.renderer.addSystemMessage(t().rewind.busy);
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
      this.renderer.addSystemMessage(t().rewind.renewFailed);
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
    rt: SessionRuntime,
  ): Promise<void> {
    if (!config.retryFn) return;
    rt.pendingRetry = { text, imageParts };
    try {
      await config.retryFn(text, refs);
    } finally {
      rt.pendingRetry = null;
    }
  }

  private async executeAgentCall(
    text: string,
    refs: ContextRef[],
    config: AgentCallConfig,
    rt: SessionRuntime = this.activeRuntime,
  ): Promise<void> {
    // Claim the busy flag synchronously, before any await: two Enter
    // presses in the same tick must not both pass send()'s busy check.
    // The claim is per-tab — another tab streaming is not this tab's problem.
    const currentGen = ++rt.genId;
    rt.streamCtrl.beginTurn();
    rt.busy = true;
    rt.state.isStreaming = true;
    const active = () => this.isActiveTab(rt);
    if (active()) {
      this.deps.input.setStreaming(true);
      this.deps.toolbar.setSending(true);
      this.callbacks.onHideWelcome();
    }
    this.notifyTabsChanged();
    rt.sendStartTime = Date.now();
    const releaseBusy = (): void => {
      rt.busy = false;
      rt.state.isStreaming = false;
      if (active()) {
        this.deps.input.setStreaming(false);
        this.deps.toolbar.setSending(false);
      }
      this.notifyTabsChanged();
    };

    let sessionId: string | null;
    try {
      sessionId = await this.ensureRuntimeSession(rt);
    } catch (e) {
      releaseBusy();
      rt.renderer.addError(e instanceof Error ? e.message : String(e));
      // Release queued prompts too, or the queue stalls forever.
      config.onFinally?.();
      void this.tryDrainAnyQueue();
      return;
    }
    const c = this.deps.runtime.getClient();
    if (!c || !sessionId) {
      releaseBusy();
      config.onFinally?.();
      void this.tryDrainAnyQueue();
      return;
    }
    // A session switch or reset during successful session creation bumps
    // genId; this continuation must not touch the view or the (now
    // different) session's store — the winner owns state from here on.
    // Runs after the failure branch above: a failed connect also bumps
    // genId (handleDisconnect), and that turn must still release busy and
    // drain the queue.
    if (rt.genId !== currentGen) return;

    if (active()) {
      this.deps.input.setStreaming(true);
      this.deps.toolbar.setSending(true);
    }
    rt.sendStartTime = Date.now();
    // A retry replays the parts captured on the failed attempt: the chips
    // were cleared then, and the user bubble + persisted message already
    // exist from that attempt, so re-adding either would corrupt the turn.
    const savedRetry = rt.pendingRetry && rt.pendingRetry.text === text ? rt.pendingRetry : null;
    rt.pendingRetry = null;
    // Composer chips belong to whichever tab is on screen; a background tab
    // turn can only carry its own retry payload or its own re-parked capture.
    const imageParts =
      savedRetry?.imageParts ?? config.capturedImageParts ?? (active() ? this.callbacks.getPendingImageParts() : []);
    if (!savedRetry && config.capturedImageParts === undefined && active()) this.callbacks.onClearPendingImageChips();
    const images = imageParts
      .filter((p) => p.type === 'image' && typeof p.mimeType === 'string' && typeof p.data === 'string')
      .map((p) => ({ mimeType: p.mimeType as string, data: p.data as string }));
    if (!savedRetry && config.addUserMessage !== false)
      rt.renderer.addUserMessage(text, undefined, images.length > 0 ? images : undefined);
    if (!savedRetry && config.saveMessage !== false)
      rt.streamCtrl.saveMessage('user', text, 'text', undefined, images.length > 0 ? images : undefined);
    rt.renderer.addAssistantPlaceholder();

    try {
      await this.syncRuntimeSession(sessionId, undefined, rt);
      if (rt.state.sessionId !== sessionId || !rt.busy) return;
      const parts = config.buildPartsWithRefs
        ? await this.buildParts(
            text,
            config.buildPartsWithRefs,
            config.history ? buildHistoryBlock(config.history) : undefined,
          )
        : [{ type: 'text' as const, text }];
      if (rt.state.sessionId !== sessionId || !rt.busy) return;
      // Capabilities can change across reconnects; re-check before sending.
      const caps = c.getAgentCapabilities?.();
      parts.push(...(caps?.promptCapabilities?.image === false ? [] : imageParts));
      const response = await c.sendMessage(sessionId, parts, (ch: NormalizedUpdate) => {
        if (rt.genId !== currentGen || !rt.busy || rt.state.sessionId !== sessionId) return;
        rt.streamCtrl.handleChunk(ch);
      });
      // If this turn was superseded (new prompt, session switch), a newer
      // generation owns the transcript — don't clobber its state.
      if (rt.genId === currentGen && rt.state.sessionId === sessionId) {
        if (response?.usage) {
          rt.state.usage = {
            totalTokens: response.usage.totalTokens ?? 0,
            inputTokens: response.usage.inputTokens ?? 0,
            outputTokens: response.usage.outputTokens ?? 0,
            thoughtTokens: response.usage.thoughtTokens,
            cost: rt.state.usage?.cost,
            contextWindow: rt.state.usage?.contextWindow,
            contextTokens: rt.state.usage?.contextTokens,
          };
          this.applyResponseMeta(response._meta, rt);
          if (active()) this.deps.updateContextMeter(rt.state.usage);
        } else {
          this.applyResponseMeta(response?._meta, rt);
        }
        this.surfaceStopReason(response, rt);
        if (config.onAfterResponse) await config.onAfterResponse(response);
      }
    } catch (e: unknown) {
      if (!rt.state.isConnected && !(e instanceof AcpProcessExitError)) {
        // A disconnect surfaces its own banner; keep a trace of the swallowed turn error.
        console.warn('[co-ober] turn error swallowed while disconnected:', e);
        return;
      }
      if (e instanceof AcpStreamCapacityError && config.addUserMessage !== false) {
        // The shared budget is raced between send()'s pre-check and sendMessage,
        // where another tab can claim the last slot first. Any conversational
        // turn that loses re-queues intact — its bubble and images are already
        // committed to this attempt — instead of failing on a race.
        rt.promptQueue.unshift({ text, refs, painted: true, images: imageParts });
        rt.capacityParked = true;
        if (active()) this.updateQueueIndicator(rt);
        return;
      }
      if (rt.state.sessionId === sessionId) {
        if (e instanceof AcpAbortError) {
          // User cancelled, don't show error
        } else if (e instanceof AcpTimeoutError) {
          rt.renderer.addError(t().error.timeout, 'retry', () =>
            this.retryTurn(config, text, refs, imageParts, rt),
          );
        } else if (e instanceof AcpProcessExitError) {
          rt.renderer.addError(t().error.processExit, 'restart', async () => {
            await this.reconnect();
            await this.retryTurn(config, text, refs, imageParts, rt);
          });
        } else {
          rt.renderer.addError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      if (rt.genId === currentGen) {
        // Turn over: buffered tool calls that never received a final
        // update must render with a terminal state instead of vanishing.
        // Only safe while this generation still owns the transcript; a
        // newer turn has its own placeholder and tool-call buffers.
        rt.streamCtrl.finalizeBufferedToolCalls();
        // A turn whose last update was a thought must not leave the live
        // thinking block (and its running timer) un-finalized.
        rt.renderer.finalizeCurrentThinking();
        rt.renderer.removeAssistantPlaceholder();
        rt.busy = false;
        rt.state.isStreaming = false;
        if (active()) {
          this.deps.input.setStreaming(false);
          this.deps.toolbar.setSending(false);
          this.deps.input.focus();
        } else {
          // A turn completed out of sight: flag the tab until it is viewed.
          rt.unread = true;
        }
        this.notifyTabsChanged();
        config.onFinally?.();
        // Shared budget freed — any tab's parked head can now start.
        void this.tryDrainAnyQueue();
        // The agent may have rewritten its todo list this turn; resync the
        // plan panel — but skip when the stream already delivered a plan
        // after this turn started, so the refresh can't overwrite it.
        if ((rt.state.lastPlanUpdateAt ?? 0) < rt.sendStartTime) {
          void this.refreshNativePlan(sessionId, rt).catch(() => {});
        }
        // Fold the finished turn: thinking/tool steps behind a summary header.
        rt.renderer.collapseTurns?.();
      }
    }
  }

  /**
   * Make non-successful turn endings visible: a refusal or a truncated
   * response must not render as a normal completed answer.
   */
  private surfaceStopReason(response: AcpResponse | undefined, rt: SessionRuntime = this.activeRuntime): void {
    const reason = response?.stopReason;
    // Lines are also persisted (like the compaction boundary) so the badge
    // survives a reload instead of evaporating with the live DOM.
    const note = (text: string, asError: boolean): void => {
      if (asError) rt.renderer.addError(text);
      else rt.renderer.addSystemMessage(text);
      rt.streamCtrl.persistSystemNote(text);
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
  private persistTurnUsage(usage: UsageInfo, rt: SessionRuntime = this.activeRuntime): void {
    const sessionId = rt.state.sessionId;
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
  private async refreshNativeUsage(sessionId: string, currencyHint?: string, rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const usage = await readNativeSessionUsage(sessionId);
    if (!usage || rt.state.sessionId !== sessionId) return;
    rt.state.usage = {
      totalTokens: usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thoughtTokens: usage.reasoningTokens || undefined,
      // The native DB has no currency column; keep whatever currency the
      // agent's own usage frames (or the resumed transcript's rows) reported
      // before falling back to USD.
      cost: { amount: usage.cost, currency: currencyHint ?? rt.state.usage?.cost?.currency ?? 'USD' },
      contextWindow: rt.state.usage?.contextWindow,
      contextTokens: usage.contextTokens,
    };
    if (this.isActiveTab(rt)) this.deps.updateContextMeter(rt.state.usage);
  }

  /**
   * Re-read the OpenCode-native todo table so the plan panel survives session
   * restore. Silently no-ops when the database or todos are unavailable.
   */
  private async refreshNativePlan(sessionId: string, rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const todos = await readNativeSessionTodos(sessionId);
    if (todos.length === 0 || rt.state.sessionId !== sessionId) return;
    rt.renderer.setPlanEntries(todos);
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
  private applyResponseMeta(meta: Record<string, unknown> | undefined, rt: SessionRuntime = this.activeRuntime): void {
    if (!meta) return;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const used = num(meta.used);
    const size = num(meta.size);
    const costObj = meta.cost && typeof meta.cost === 'object' ? (meta.cost as Record<string, unknown>) : undefined;
    const costAmount = num(costObj?.amount);
    if (used === undefined && size === undefined && costAmount === undefined) return;
    const usage: UsageInfo = rt.state.usage ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
    if (used !== undefined) usage.contextTokens = used;
    if (size !== undefined) usage.contextWindow = size;
    if (costAmount !== undefined) {
      usage.cost = { amount: costAmount, currency: typeof costObj?.currency === 'string' ? costObj.currency : 'USD' };
    }
    rt.state.usage = usage;
    if (this.isActiveTab(rt)) this.deps.updateContextMeter(usage);
  }

  async send(
    text: string,
    refs: ContextRef[],
    rt: SessionRuntime = this.activeRuntime,
    opts: { paintedHead?: boolean; imagesHead?: PromptPart[] } = {},
  ): Promise<void> {
    if (rt.busy) {
      rt.promptQueue.push({ text, refs });
      if (this.isActiveTab(rt)) this.updateQueueIndicator(rt);
      return;
    }
    if (!this.streamSlotsFree(this.deps.runtime.getClient())) {
      // The shared stream budget is held by other tabs: wait in this tab's
      // queue instead of failing; the next release starts it.
      rt.promptQueue.push({ text, refs });
      if (this.isActiveTab(rt)) this.updateQueueIndicator(rt);
      return;
    }
    const parsed = parseSlashCommand(text);
    if (parsed) {
      const def = commandRegistry.find(parsed.name);
      if (def) {
        if (def.source === 'builtin') {
          rt.renderer.addUserMessage(text);
          rt.streamCtrl.saveMessage('user', text, 'text');
          await def.run(parsed.args, { tabId: rt.tabId });
          return;
        }
        if (def.source === 'file' && def.template) {
          const { templateExpander } = await import('../commands/templateExpander');
          const expanded = templateExpander.buildPrompt(def, parsed.args);
          await this.sendTextToAgent(expanded, refs, rt);
          return;
        }
      }
    }
    const inlineEdit = this.deps.inlineEditPanel.pendingState;
    if (inlineEdit) this.deps.inlineEditPanel.clearState();

    await this.executeAgentCall(
      text,
      refs,
      {
        buildPartsWithRefs: refs,
        // A drained turn already drew and stored its user message; replaying
        // either would double the bubble.
        addUserMessage: opts.paintedHead ? false : undefined,
        saveMessage: opts.paintedHead ? false : undefined,
        capturedImageParts: opts.imagesHead,
        retryFn: (t, r) => this.send(t, r ?? refs, rt),
        onFinally: () => {
          if (rt.state.usage) {
            rt.renderer.showUsage({
              ...rt.state.usage,
              modelId: rt.state.currentModelId ?? undefined,
              elapsedMs: Date.now() - rt.sendStartTime,
            });
            this.persistTurnUsage(rt.state.usage, rt);
          }
          if (inlineEdit && this.deps.inlineEditPanel.pendingState === inlineEdit) {
            const session = this.deps.sessionStore.get(rt.state.sessionId ?? '');
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
          void this.maybeAutoTitle(rt).catch((e) => console.error('[co-ober] auto title:', e));
        },
      },
      rt,
    );
  }

  private async sendTextToAgent(text: string, refs?: ContextRef[], rt: SessionRuntime = this.activeRuntime): Promise<void> {
    await this.executeAgentCall(
      text,
      refs ?? [],
      {
        addUserMessage: false,
        saveMessage: false,
        buildPartsWithRefs: refs && refs.length > 0 ? refs : undefined,
        retryFn: (t, r) => this.sendTextToAgent(t, r, rt),
      },
      rt,
    );
  }

  private async drainQueue(rt: SessionRuntime): Promise<void> {
    while (rt.promptQueue.length > 0 && !rt.busy) {
      // Only start what the shared budget can carry; the rest waits for the
      // next release tick.
      if (!this.streamSlotsFree(this.deps.runtime.getClient())) break;
      const head = rt.promptQueue.shift()!;
      const headPainted = !!head.painted;
      let text = head.text;
      // Consecutive plain prompts pile up while the agent is busy; merge them
      // into one turn so the agent sees the follow-ups as a single message. A
      // turn that is already on screen must not swallow one that is not (its
      // bubble would vanish), and a turn carrying its own images stays alone.
      if (isPlainPrompt(head) && !head.images) {
        while (
          rt.promptQueue.length > 0 &&
          isPlainPrompt(rt.promptQueue[0]) &&
          !rt.promptQueue[0].images &&
          !!rt.promptQueue[0].painted === headPainted
        ) {
          text += `\n\n${rt.promptQueue.shift()!.text}`;
        }
      }
      if (this.isActiveTab(rt)) this.updateQueueIndicator(rt);
      try {
        await this.send(text, head.refs, rt, { paintedHead: headPainted, imagesHead: head.images });
      } catch (e) {
        // One failing queued command must not strand the rest of the queue.
        console.error('[co-ober] queued prompt failed:', e);
        rt.renderer.addError(e instanceof Error ? e.message : String(e));
      }
      if (rt.capacityParked) {
        // The head is parked again until the next release; keep draining here
        // would spin against the same full budget.
        rt.capacityParked = false;
        break;
      }
    }
  }

  async stopGeneration(): Promise<void> {
    const rt = this.activeRuntime;
    const c = this.deps.runtime.getClient();
    if (!c || !rt.state.sessionId || (!rt.busy && !rt.state.isStreaming)) return;
    // Increment genId FIRST so the in-flight executeAgentCall's finally block
    // skips stale state updates (busy=false, onFinally).
    ++rt.genId;
    this.deps.input.setStreaming(false);
    this.deps.toolbar.setSending(false);
    try {
      // Cancel the backend RPC before resetting local state,
      // so the in-flight handler stops processing chunks immediately.
      await c.cancel(rt.state.sessionId);
    } catch (e) {
      console.error('[co-ober] cancel:', e);
    }
    // Buffered pending/in_progress tool calls belonged to the interrupted
    // turn: render them terminal now so they neither vanish nor ghost into
    // the next turn (its finally is skipped by the genId bump above).
    rt.streamCtrl.finalizeBufferedToolCalls();
    // Stop during a thought: close the live thinking block before the
    // interrupt marker, so its timer stops and the label finalizes.
    rt.renderer.finalizeCurrentThinking();
    // Append "Interrupted" indicator to the current assistant response
    rt.renderer.appendInterruptIndicator();
    rt.renderer.flushTextRender().catch(() => {});
    rt.busy = false;
    rt.state.isStreaming = false;
    // Stop means "pause everything", not "lose the queue": plain prompts go
    // back into the input so the user keeps their text. Entries carrying
    // @-mention/image refs stay queued — the textarea cannot represent refs,
    // and dropping them would silently lose context.
    const paused = rt.promptQueue.splice(0);
    const restorable = paused.filter(isPlainPrompt);
    rt.promptQueue.push(...paused.filter((q) => !isPlainPrompt(q)));
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
    this.updateQueueIndicator(rt);
  }

  /**
   * Update the queue indicator: count header plus one removable row per
   * queued prompt so the user can see and prune what will be sent next.
   * The indicator always shows the active tab's queue.
   */
  private updateQueueIndicator(rt: SessionRuntime = this.activeRuntime): void {
    const indicatorEl = this.queueIndicatorEl;
    if (!indicatorEl) return;

    indicatorEl.empty();

    if (rt.promptQueue.length > 0) {
      const text =
        rt.promptQueue.length === 1
          ? t().queue.one
          : t().queue.many.replace('{count}', String(rt.promptQueue.length));
      indicatorEl.createSpan({ cls: 'co-ober-queue-text', text });
      rt.promptQueue.forEach((entry, index) => {
        const item = indicatorEl.createDiv({ cls: 'co-ober-queue-item' });
        item.createSpan({ cls: 'co-ober-queue-item-text', text: queuePreview(entry.text) });
        const remove = item.createEl('button', {
          cls: 'co-ober-queue-remove',
          text: '×',
          attr: { 'aria-label': t().queue.remove, title: t().queue.remove },
        });
        remove.onclick = () => {
          rt.promptQueue.splice(index, 1);
          this.updateQueueIndicator(rt);
        };
      });
      indicatorEl.addClass('co-ober-visible');
    } else {
      indicatorEl.removeClass('co-ober-visible');
    }
  }

  /** Discarding queued prompts (session reset, tab close, view close) must never be silent. */
  private dropQueuedPrompts(rt: SessionRuntime): void {
    if (rt.promptQueue.length === 0) return;
    new Notice(t().queue.dropped.replace('{count}', String(rt.promptQueue.length)));
    rt.promptQueue = [];
    if (this.isActiveTab(rt)) this.updateQueueIndicator(rt);
  }

  /** Number of prompts waiting for the current turn to finish (tests / UI hooks). */
  queuedCount(): number {
    return this.activeRuntime.promptQueue.length;
  }

  /** Cache note content by path (LRU) to avoid re-reading the same file. */
  private noteContentCache = new Map<string, { name: string; content: string }>();

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
  private async maybeAutoTitle(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const sid = rt.state.sessionId;
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

  async exportSessionToNote(rt: SessionRuntime = this.activeRuntime): Promise<void> {
    const id = rt.state.sessionId;
    const session = id ? this.deps.sessionStore.get(id) : undefined;
    if (!session || session.messages.length === 0) {
      rt.renderer.addSystemMessage(t().export.noSession);
      return;
    }
    const markdown = buildTranscriptMarkdown(session);
    const folder = this.deps.runtime.settings.defaultNoteFolder?.trim() ?? '';
    const name = `${sanitizeNoteName(session.title)} ${this.exportTimestamp()}.md`;
    const path = folder ? `${folder}/${name}` : name;
    try {
      await this.deps.runtime.createNote(path, markdown);
      rt.renderer.addSystemMessage(t().export.saved.replace('{path}', path));
    } catch (e) {
      rt.renderer.addSystemMessage(
        t().export.failed.replace('{error}', e instanceof Error ? e.message : String(e)),
      );
    }
  }

  copyTranscript(rt: SessionRuntime = this.activeRuntime): void {
    const id = rt.state.sessionId;
    const session = id ? this.deps.sessionStore.get(id) : undefined;
    if (!session || session.messages.length === 0) {
      rt.renderer.addSystemMessage(t().export.noSession);
      return;
    }
    void navigator.clipboard.writeText(buildTranscriptMarkdown(session)).then(() => {
      rt.renderer.addSystemMessage(t().copy.transcript);
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

  /**
   * Project a tab's session metadata onto its state — and onto the single
   * shared toolbar only when that tab is the one on screen.
   */
  loadToolbarOptions(rt: SessionRuntime = this.activeRuntime): void {
    const c = this.deps.runtime.getClient();
    if (!c) return;

    const sid = rt.state.sessionId;
    const snapshot = sid ? (c.getSessionSnapshotFor?.(sid) ?? c.getSessionSnapshot()) : c.getSessionSnapshot();
    rt.state.configOptions = snapshot.configOptions;
    rt.state.availableCommands = snapshot.availableCommands;
    rt.state.availableModels = snapshot.availableModels;
    rt.state.availableModes = snapshot.availableModes;
    rt.state.currentModeId = snapshot.currentModeId;

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

    rt.state.currentModelId = snapshot.currentModelId ?? modelConfig?.currentValue ?? null;
    if (!this.isActiveTab(rt)) return;
    this.deps.toolbar.updateAgents(
      agents,
      snapshot.currentModeId ?? modeConfig?.currentValue ?? this.deps.runtime.settings.defaultAgent,
    );
    this.deps.toolbar.updateModels(
      models,
      snapshot.currentModelId ?? modelConfig?.currentValue ?? this.deps.runtime.settings.defaultModel,
    );
    this.deps.toolbar.updateEffort(efforts, effortConfig?.currentValue ?? this.deps.runtime.settings.defaultEffort);
    this.deps.toolbar.updatePermission(this.deps.runtime.settings.permissionMode);
    // Mirror the send-path rule (images are stripped unless supported) so the
    // attach button is only offered when an image could actually be sent.
    const caps = c.getAgentCapabilities?.();
    this.deps.toolbar.setImageAttachEnabled(caps?.promptCapabilities?.image !== false);
    // The slash menu is a shared surface too: activating a tab, reconnecting or
    // switching sessions all re-project its own command list onto it.
    commandRegistry.updateAcpCommands(rt.state.availableCommands);
  }

  applyConfigOptions(opts: SessionConfigOption[], rt: SessionRuntime = this.activeRuntime): void {
    // The toolbar is a single shared surface: only the on-screen tab updates it.
    if (!this.isActiveTab(rt)) return;
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

  applyModeUpdate(modeId: string | null, modes: ModeOption[], rt: SessionRuntime = this.activeRuntime): void {
    if (!this.isActiveTab(rt)) return;
    this.deps.toolbar.updateAgents(
      modes.map((m) => ({ value: m.id, label: m.name })),
      modeId ?? undefined,
    );
  }

  applyModelUpdate(modelId: string | null, models: ModelOption[], rt: SessionRuntime = this.activeRuntime): void {
    if (!this.isActiveTab(rt)) return;
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
    this.resetRuntimeView(this.activeRuntime);
  }

  /** Tear one tab's screen down without touching any other tab's turn. */
  private resetRuntimeView(rt: SessionRuntime): void {
    const active = this.isActiveTab(rt);
    // The scratch thread was forked from this tab's conversation, so it is
    // this tab's to release — whether or not it is the one on screen.
    this.endSideChat(rt);
    this.callbacks.onCloseSideChat?.(rt.tabId);
    if (active) {
      this.deps.inlineEditPanel.clearState();
      this.deps.permissionBanner.dismiss();
      this.deps.welcomeView.hide();
    }
    rt.renderer.clear();
    rt.streamCtrl.reset();
    ++rt.genId;
    rt.painted = false;
    // The adopter paints this panel itself; a pending lazy restore must not
    // replay an old transcript into it afterwards.
    rt.needsRestore = false;
    this.dropQueuedPrompts(rt);
    rt.busy = false;
    rt.state.isStreaming = false;
    rt.state.usage = null;
    if (active) {
      this.deps.updateContextMeter(null);
      this.deps.input.setStreaming(false);
      this.deps.toolbar.setSending(false);
      this.callbacks.onClearUI();
      this.callbacks.onClearChips();
      this.callbacks.onClearPendingImageChips();
    }
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
