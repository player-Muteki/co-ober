import { Plugin, Notice } from 'obsidian';
import { AgentRuntime } from './client/agent';
import { AcpClient } from './client/acp';
import { CoOberView } from './view/CoOberView';
import { CoOberSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import type { CoOberSettings, SerializedSession, SerializedMessage, PluginData } from './types';
import { getVaultPath } from './utils/vault';
import { setLocale, t } from './i18n/index';

export default class CoOberPlugin extends Plugin {
  settings: CoOberSettings = DEFAULT_SETTINGS;
  client: AgentRuntime | null = null;
  sessions: Map<string, SerializedSession> = new Map();
  activeSessionId: string | null = null;
  private clientReadyResolvers: Array<(ready: boolean) => void> = [];
  private _clientReady = false;
  private connecting: Promise<boolean> | null = null;

  /** Resolves when the first successful connection is established. */
  waitForClient(): Promise<boolean> {
    if (this._clientReady) return Promise.resolve(true);
    return new Promise((resolve) => this.clientReadyResolvers.push(resolve));
  }

  private resolveClientWaiters(ready: boolean): void {
    for (const resolve of this.clientReadyResolvers) resolve(ready);
    this.clientReadyResolvers = [];
  }

  override async onload(): Promise<void> {
    await this.loadPluginData();
    setLocale(this.settings.language);

    this.registerView(VIEW_TYPE, (leaf) => new CoOberView(leaf, this));
    this.deduplicateCoOberLeaves();
    this.addRibbonIcon('terminal-square', 'Open Co-Ober', () => this.activateView());
    this.addSettingTab(new CoOberSettingsTab(this));
    this.addCommand({
      id: 'open',
      name: 'Open',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'ai-edit-selection',
      name: 'AI Edit Selection',
      editorCallback: (editor, view) => this.aiEditSelection(editor, view),
    });
  }

  override onunload(): void { void this.client?.disconnect(); }

  // ── Unified storage ──

  override async loadData(): Promise<PluginData | null> {
    const saved: unknown = await super.loadData();
    if (!saved) return null;

    const hasPluginData = typeof saved === 'object'
      && saved !== null
      && ('settings' in saved || 'sessions' in saved || 'activeSessionId' in saved);

    if (hasPluginData) {
      const data = saved as Partial<PluginData>;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) },
        sessions: data.sessions ?? [],
        activeSessionId: data.activeSessionId ?? null,
      };
    }

    return {
      settings: { ...DEFAULT_SETTINGS, ...(saved as Partial<CoOberSettings>) },
      sessions: [],
      activeSessionId: null,
    };
  }

  override async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
  }

  private buildPluginData(): PluginData {
    return {
      settings: this.settings,
      sessions: [...this.sessions.values()],
      activeSessionId: this.activeSessionId,
    };
  }

  async savePluginData(): Promise<void> {
    // Defer prune so it doesn't block the save IO.
    setTimeout(() => this.pruneSessions(), 0);
    await super.saveData(this.buildPluginData());
  }

  private pruneSessions(): void {
    const maxMessages = this.settings.maxSessionMessages ?? 200;
    const retentionDays = this.settings.sessionRetentionDays ?? 30;
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const activeId = this.activeSessionId;
    for (const [id, session] of this.sessions) {
      // Remove old sessions (even with messages if past retention)
      if (id !== activeId && session.updatedAt < cutoffTime) {
        this.sessions.delete(id);
        continue;
      }

      // Truncate large sessions
      if (session.messages.length > maxMessages) {
        const keepCount = Math.floor(maxMessages / 2);
        const truncated: SerializedMessage[] = [
          ...session.messages.slice(0, keepCount),
          {
            role: 'system',
            content: `[${session.messages.length - keepCount * 2} earlier messages truncated]`,
            type: 'text',
            timestamp: session.messages[keepCount]?.timestamp ?? Date.now(),
          },
          ...session.messages.slice(-keepCount),
        ];
        session.messages = truncated;
      }
    }
  }

  async loadPluginData(): Promise<void> {
    this.settings = DEFAULT_SETTINGS;
    this.sessions.clear();
    this.activeSessionId = null;

    const pluginData = await this.loadData();
    if (!pluginData) return;

    this.settings = { ...DEFAULT_SETTINGS, ...(pluginData.settings ?? {}) };
    for (const s of (pluginData.sessions ?? [])) {
      this.sessions.set(s.sessionId, s);
    }
    this.activeSessionId = pluginData.activeSessionId ?? null;
  }

  // ── Client ──

  async aiEditSelection(editor: import('obsidian').Editor, _view: import('obsidian').MarkdownView | import('obsidian').MarkdownFileInfo): Promise<void> {
    const selected = editor.getSelection();
    if (!selected || selected.trim().length === 0) {
      new Notice(t().notice.noSelection);
      return;
    }
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const coOberView = leaf?.view as CoOberView | undefined;
    if (coOberView) {
      await coOberView.requestInlineEdit(selected, editor);
    }
  }

  async activateView(): Promise<void> {
    const existing = this.deduplicateCoOberLeaves();
    if (existing) {
      await existing.setViewState({ type: VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(existing);
      this.deduplicateCoOberLeaves();
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(true) ?? this.app.workspace.getLeaf(true);

    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
    this.deduplicateCoOberLeaves();
  }

  private deduplicateCoOberLeaves(): import('obsidian').WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const [first, ...duplicates] = leaves;
    for (const leaf of duplicates) {
      leaf.detach();
    }
    return first ?? null;
  }

  async initClient(): Promise<boolean> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectClient();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectClient(): Promise<boolean> {
    this.resolveClientWaiters(false);
    try {
      const acp = new AcpClient(this.settings.opencodePath, getVaultPath(this.app));
      await acp.connect();
      this.client = new AgentRuntime(acp);
      this.client.permissionMode = this.settings.permissionMode;
      this.client.idleTimeoutMs = this.settings.idleTimeoutMs ?? 300000;
      this._clientReady = true;
      this.resolveClientWaiters(true);
      new Notice(t().notice.connected);
      return true;
    } catch (e) {
      this._clientReady = false;
      this.client = null;
      this.resolveClientWaiters(false);
      console.error('[co-ober] Connect failed:', e);
      new Notice(t().notice.connectFailed);
      return false;
    }
  }

  getClient(): AgentRuntime | null { return this.client; }
}
