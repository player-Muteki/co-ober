import type {
  NormalizedUpdate,
  ContextRef,
  PromptPart,
  SessionConfigOption,
  ModeOption,
  ModelOption,
  AcpResponse,
  SerializedMessage,
  UsageInfo,
} from '../types';
import type { CoOberSettings } from '../types';
import type { OpencodeClient } from '../client';
import { SessionReplayCollector } from '../client/sessionReplay';
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
import type { WelcomeView } from './welcomeView';
import type { PermissionBanner } from './permissionBanner';
import type { InlineEditPanel } from './inlineEditPanel';
import { buildSystemPrompt } from '../context/injection';
import { buildHistoryBlock } from '../context/historyRewind';
import { buildTranscriptMarkdown, sanitizeNoteName } from '../chat/transcript';
import { AcpTimeoutError, AcpProcessExitError, AcpAbortError, AcpSessionMissingError } from '../client/AcpErrors';
import { readNativeSessionUsage } from '../opencode/NativeSessionReader';
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

export class CoOberViewController {
  private sessionMutex = new Mutex();
  readonly state = new ChatState();
  private streamCtrl!: StreamController;
  private busy = false;
  private sendStartTime = 0;
  private genId = 0;
  private promptQueue: Array<{ text: string; refs: ContextRef[] }> = [];
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
      run: async () => {
        // Handled by the session dropdown UI, not text input.
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
          this.deps.renderer.removeAssistantPlaceholder();
          this.deps.renderer.addError(t().error.reconnected);
        }
      },
      onReconnectFailed: () => {
        this.deps.renderer.addError(t().error.reconnectFailed);
        this.handleDisconnect();
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

  /** Inform the user when the agent dropped a session (e.g. after an agent restart). */
  private notifyLostSession(err: unknown): boolean {
    if (err instanceof AcpSessionMissingError) {
      this.deps.renderer.addSystemMessage(t().session.runtimeSessionLost);
      return true;
    }
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
    let idx = 0;
    for (const msg of session.messages) {
      const restoreId = `restore-${msg.timestamp}-${idx++}`;
      if (msg.role === 'user') {
        this.deps.renderer.addUserMessage(msg.content, msg.timestamp, msg.images);
      } else if (msg.role === 'assistant') {
        if (msg.contentBlocks && msg.contentBlocks.length > 0) {
          this.deps.renderer.renderStructuredMessage(msg);
        } else if (msg.type === 'thinking') {
          this.deps.renderer.appendThinking(msg.content, restoreId, msg.timestamp);
        } else {
          this.deps.renderer.appendText(msg.content, restoreId, msg.timestamp);
        }
      }
    }
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
    this.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    await this.cancelActiveGeneration();
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
    const forkedId = await client.forkSession(sessionId, this.getVaultCwd());
    this.state.sessionId = forkedId;
    this.deps.sessionStore.getOrCreate(forkedId);
    this.deps.sessionStore.setActive(forkedId);
    await this.deps.sessionStore.save();
  }

  async resumeSession(sessionId: string): Promise<void> {
    const client = this.deps.runtime.getClient();
    if (!client) return;
    const collector = new SessionReplayCollector();
    await client.resumeSession(sessionId, this.getVaultCwd(), (u) => collector.handle(u));
    this.state.sessionId = sessionId;
    this.deps.sessionStore.getOrCreate(sessionId);
    this.deps.sessionStore.setActive(sessionId);
    await this.adoptReplay(sessionId, collector.finish());
    await this.deps.sessionStore.save();
    await this.refreshNativeUsage(sessionId);
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

  private async executeAgentCall(
    text: string,
    refs: ContextRef[],
    config: {
      addUserMessage?: boolean;
      saveMessage?: boolean;
      buildPartsWithRefs?: ContextRef[];
      history?: SerializedMessage[];
      onAfterResponse?: (response: AcpResponse | undefined) => Promise<void>;
      onFinally?: () => void;
      retryFn?: (text: string, refs?: ContextRef[]) => Promise<void>;
    },
  ): Promise<void> {
    // Claim the busy flag synchronously, before any await: two Enter
    // presses in the same tick must not both pass send()'s busy check.
    const currentGen = ++this.genId;
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
      return;
    }
    const c = this.deps.runtime.getClient();
    if (!c || !sessionId) {
      releaseBusy();
      return;
    }

    this.deps.input.setStreaming(true);
    this.deps.toolbar.setSending(true);
    this.sendStartTime = Date.now();
    const imageParts = this.callbacks.getPendingImageParts();
    this.callbacks.onClearPendingImageChips();
    const images = imageParts
      .filter((p) => p.type === 'image' && typeof p.mimeType === 'string' && typeof p.data === 'string')
      .map((p) => ({ mimeType: p.mimeType as string, data: p.data as string }));
    if (config.addUserMessage !== false)
      this.deps.renderer.addUserMessage(text, undefined, images.length > 0 ? images : undefined);
    if (config.saveMessage !== false)
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
      parts.push(...imageParts);
      const response = await c.sendMessage(sessionId, parts, (ch: NormalizedUpdate) => {
        if (this.genId !== currentGen || !this.busy || this.state.sessionId !== sessionId) return;
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
        this.applyResponseMeta(response._meta);
        this.deps.updateContextMeter(this.state.usage);
      } else {
        this.applyResponseMeta(response?._meta);
      }
      if (config.onAfterResponse) await config.onAfterResponse(response);
    } catch (e: unknown) {
      if (!this.state.isConnected && !(e instanceof AcpProcessExitError)) return;
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
      // Turn over: buffered tool calls that never received a final
      // update must render with a terminal state instead of vanishing.
      this.streamCtrl.finalizeBufferedToolCalls();
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

  /**
   * Pull authoritative cost/token totals for a session from the OpenCode
   * database. Silently no-ops when the database is unavailable.
   */
  private async refreshNativeUsage(sessionId: string): Promise<void> {
    const usage = await readNativeSessionUsage(sessionId);
    if (!usage || this.state.sessionId !== sessionId) return;
    this.state.usage = {
      totalTokens: usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thoughtTokens: usage.reasoningTokens || undefined,
      cost: { amount: usage.cost, currency: 'USD' },
      contextWindow: this.state.usage?.contextWindow,
      contextTokens: usage.contextTokens,
    };
    this.deps.updateContextMeter(this.state.usage);
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
      this.updateQueueIndicator();
      await this.send(next.text, next.refs);
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
    // Append "Interrupted" indicator to the current assistant response
    this.deps.renderer.appendInterruptIndicator();
    this.deps.renderer.flushTextRender().catch(() => {});
    this.busy = false;
    this.state.isStreaming = false;
    // Stop means "pause everything", not "lose the queue": put queued
    // messages back into the input so the user keeps their text.
    if (this.promptQueue.length > 0) {
      const queued = this.promptQueue.splice(0).map((q) => q.text);
      const ta = this.deps.input.textareaEl;
      const existing = ta.value.trim();
      ta.value = existing ? `${existing}\n${queued.join('\n')}` : queued.join('\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      this.deps.input.focus();
    }
    this.updateQueueIndicator();
  }

  /**
   * Update the queue indicator showing queued message count.
   * Shown when messages are queued during streaming, hidden when queue is empty.
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
      indicatorEl.addClass('co-ober-visible');
    } else {
      indicatorEl.removeClass('co-ober-visible');
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

  async buildParts(text: string, refs: ContextRef[], historyBlock?: string): Promise<PromptPart[]> {
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
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    const efforts = [
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
          opt.options.map((o) => ({ value: o.value, label: o.name })),
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
    this.deps.welcomeView.hide();
    this.deps.renderer.clear();
    this.streamCtrl.reset();
    ++this.genId;
    this.promptQueue = [];
    this.updateQueueIndicator();
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

function buildNotesBlock(resolved: Array<{ name: string; content: string }>): string {
  if (resolved.length === 0) return '';
  const blocks = resolved.map((r) => `=== NOTE: [[${r.name}]] ===\n${r.content}\n=== END NOTE ===`);
  return (
    'The user has referenced the following Obsidian notes in their message.\n' +
    'You should consider their content as relevant context for your response:\n\n' +
    blocks.join('\n\n')
  );
}
