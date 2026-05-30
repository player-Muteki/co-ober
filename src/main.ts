import { Plugin, Notice } from 'obsidian';
import { AgentRuntime } from './client/agent';
import { AcpClient } from './client/acp';
import { CopsidianView } from './view/copsidianView';
import { CopsidianSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import type { CopsidianSettings, SerializedSession, SerializedMessage, PluginData } from './types';
import { getVaultPath } from './utils/vault';
import { setLocale, t } from './i18n/index';

interface WorkspaceWithSideLeaf {
  ensureSideLeaf?: (
    viewType: string,
    side: 'left' | 'right',
    options?: { active?: boolean; reveal?: boolean },
  ) => Promise<import('obsidian').WorkspaceLeaf>;
}

export default class CopsidianPlugin extends Plugin {
  settings: CopsidianSettings = DEFAULT_SETTINGS;
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

    this.registerView(VIEW_TYPE, (leaf) => new CopsidianView(leaf, this));
    this.deduplicateCopsidianLeaves();
    this.addRibbonIcon('terminal-square', 'Open Copsilot', () => this.activateView());
    this.addSettingTab(new CopsidianSettingsTab(this));
    this.addCommand({
      id: 'open-copsidian',
      name: 'Open Copsilot',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'ai-edit-selection',
      name: 'AI Edit Selection',
      editorCallback: (editor, view) => this.aiEditSelection(editor, view),
    });
  }

  override onunload(): void { this.client?.disconnect(); }

  // ── Unified storage ──

  override async loadData(): Promise<PluginData | null> {
    const saved = await super.loadData();
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
      settings: { ...DEFAULT_SETTINGS, ...(saved as Partial<CopsidianSettings>) },
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
    this.pruneSessions();
    await super.saveData(this.buildPluginData());
  }

  private pruneSessions(): void {
    const maxMessages = this.settings.maxSessionMessages ?? 200;
    const retentionDays = this.settings.sessionRetentionDays ?? 30;
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    for (const [id, session] of this.sessions) {
      // Remove old sessions
      if (session.updatedAt < cutoffTime && session.messages.length === 0) {
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
    const copsidianView = leaf?.view as CopsidianView | undefined;
    if (copsidianView) {
      await copsidianView.requestInlineEdit(selected, editor);
    }
  }

  async activateView(): Promise<void> {
    const existing = this.deduplicateCopsidianLeaves();
    if (existing) {
      await existing.setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(existing);
      this.deduplicateCopsidianLeaves();
      return;
    }

    const workspace = this.app.workspace as typeof this.app.workspace & WorkspaceWithSideLeaf;
    let leaf = null as import('obsidian').WorkspaceLeaf | null;

    if (typeof workspace.ensureSideLeaf === 'function') {
      leaf = await workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: true, reveal: true });
    } else {
      leaf = this.app.workspace.getRightLeaf(true) ?? this.app.workspace.getLeaf(true);
    }

    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.deduplicateCopsidianLeaves();
  }

  private deduplicateCopsidianLeaves(): import('obsidian').WorkspaceLeaf | null {
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
      console.error('[copsidian] Connect failed:', e);
      new Notice(t().notice.connectFailed);
      return false;
    }
  }

  getClient(): AgentRuntime | null { return this.client; }
}
