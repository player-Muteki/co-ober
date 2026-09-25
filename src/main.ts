import { Plugin, Notice, TFile, TFolder } from 'obsidian';
import { AgentRuntime } from './client/agent';
import { AcpClient } from './client/acp';
import type { VaultWriteIo } from './client/fsDelegate';
import { applyPermissionTier } from './client/permissionTier';
import { isMissingBinaryError } from './client/AcpErrors';
import { CoOberView } from './view/CoOberView';
import { CoOberSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import type { CoOberSettings, PluginData } from './types';
import { getVaultPath } from './utils/vault';
import { setLocale, t } from './i18n/index';
import { Mutex } from './utils/mutex';
import { SessionRepository } from './chat/session';
import { migratePluginDataSessions, readSchemaVersion, PLUGIN_DATA_SCHEMA_VERSION } from './chat/pluginDataMigration';
import { SAVE_NOTICE_THROTTLE_MS } from './constants';

export default class CoOberPlugin extends Plugin {
  settings: CoOberSettings = DEFAULT_SETTINGS;
  client: AgentRuntime | null = null;
  readonly sessionStore = new SessionRepository(() => this.savePluginData());
  private clientReadyResolvers: Array<(ready: boolean) => void> = [];
  private _clientReady = false;
  private connecting: Promise<boolean> | null = null;
  private readonly saveMutex = new Mutex();

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
    try {
      await this.loadPluginData();
    } catch (e) {
      // A corrupted data.json must not brick the plugin: fall back to defaults
      // and keep the unreadable file aside so the data is not silently lost.
      console.error('[co-ober] failed to load plugin data:', e);
      const backupPath = await this.backupUnreadableData();
      this.settings = { ...DEFAULT_SETTINGS };
      this.sessionStore.hydrate([], null);
      new Notice(
        backupPath
          ? t().notice.dataLoadFailed.replace('{file}', backupPath)
          : t().notice.dataLoadFailedNoBackup,
      );
    }
    setLocale(this.settings.language);

    this.registerView(VIEW_TYPE, (leaf) => new CoOberView(leaf, this));
    this.deduplicateCoOberLeaves();
    this.addRibbonIcon('terminal-square', t().app.ribbon, () => this.activateView());
    this.addSettingTab(new CoOberSettingsTab(this));
    this.addCommand({
      id: 'open',
      name: t().app.cmdOpen,
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'ai-edit-selection',
      name: t().app.cmdEdit,
      editorCallback: (editor, view) => this.aiEditSelection(editor, view),
    });
  }

  override onunload(): void {
    // Views flush their debounced saves on close, but app exit does not await
    // that teardown — write the store once more so a stream tail survives.
    void this.savePluginData().catch((e) => console.warn('[co-ober] unload save failed:', e));
    void this.client?.disconnect().catch(() => {});
  }

  // ── Unified storage ──

  override async loadData(): Promise<PluginData | null> {
    const saved: unknown = await super.loadData();
    if (!saved) return null;

    const hasPluginData =
      typeof saved === 'object' &&
      saved !== null &&
      ('settings' in saved || 'sessions' in saved || 'activeSessionId' in saved);

    if (hasPluginData) {
      const data = saved as Partial<PluginData>;
      const restored = migratePluginDataSessions(data.sessions, data.activeSessionId);
      const settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
      // The autoConnect toggle did nothing before 0.1.34, so a stored false in
      // pre-schema data is the old default, not a choice: keep auto-connect.
      if (readSchemaVersion(saved) < 1 && settings.autoConnect === false) settings.autoConnect = true;
      return {
        schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
        settings,
        sessions: restored.sessions,
        activeSessionId: restored.activeSessionId,
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
    const sessionState = this.sessionStore.snapshot();
    return {
      schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
      settings: this.settings,
      ...sessionState,
    };
  }

  private lastSaveNoticeAt = 0;

  async savePluginData(): Promise<void> {
    try {
      await this.saveMutex.runExclusive(async () => {
        this.sessionStore.prune({
          maxMessages: this.settings.maxSessionMessages ?? 200,
          retentionDays: this.settings.sessionRetentionDays ?? 30,
        });
        await super.saveData(this.buildPluginData());
      });
    } catch (e) {
      // Every save call site except unload is fire-and-forget; surface failures
      // here once (throttled) instead of losing chat data silently.
      console.error('[co-ober] save failed:', e);
      const now = Date.now();
      if (now - this.lastSaveNoticeAt > SAVE_NOTICE_THROTTLE_MS) {
        this.lastSaveNoticeAt = now;
        new Notice(t().notice.saveFailed);
      }
    }
  }

  private async backupUnreadableData(): Promise<string | null> {
    const dataPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
    const backupPath = `${dataPath.slice(0, -'.json'.length)}.corrupt-${Date.now()}.json`;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dataPath))) return null;
      await adapter.rename(dataPath, backupPath);
      return backupPath;
    } catch (e) {
      console.error('[co-ober] failed to set aside unreadable data.json:', e);
      return null;
    }
  }

  async loadPluginData(): Promise<void> {
    this.settings = DEFAULT_SETTINGS;
    this.sessionStore.hydrate([], null);

    const pluginData = await this.loadData();
    if (!pluginData) return;

    this.settings = { ...DEFAULT_SETTINGS, ...(pluginData.settings ?? {}) };
    this.sessionStore.hydrate(pluginData.sessions ?? [], pluginData.activeSessionId ?? null);
  }

  // ── Client ──

  async aiEditSelection(
    editor: import('obsidian').Editor,
    _view: import('obsidian').MarkdownView | import('obsidian').MarkdownFileInfo,
  ): Promise<void> {
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

  /**
   * Agent fs/writeTextFile goes through the Vault API so the metadata index
   * and open editors stay in sync; raw fs stays only as an out-of-vault fallback.
   */
  private createVaultIo(): VaultWriteIo {
    const app = this.app;
    return {
      async writeText(relPath, content) {
        const existing = app.vault.getAbstractFileByPath(relPath);
        if (existing instanceof TFile) {
          await app.vault.modify(existing, content);
          return;
        }
        let parent = '';
        for (const dir of relPath.split('/').slice(0, -1)) {
          parent = parent ? `${parent}/${dir}` : dir;
          if (!app.vault.getAbstractFileByPath(parent)) {
            try {
              await app.vault.createFolder(parent);
            } catch (e) {
              if (!(e instanceof Error) || !e.message.includes('already exists')) throw e;
            }
          }
        }
        if (existing instanceof TFolder) throw new Error(`Cannot write over folder: ${relPath}`);
        await app.vault.create(relPath, content);
      },
    };
  }

  private async connectClient(): Promise<boolean> {
    this.resolveClientWaiters(false);
    try {
      const acp = new AcpClient(this.settings.opencodePath, getVaultPath(this.app), this.createVaultIo());
      await acp.connect();
      this.client = new AgentRuntime(acp);
      this.client.permissionMode = this.settings.permissionMode;
      applyPermissionTier(this.client, this.settings.permissionMode, this.settings);
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
      const cmd = this.settings.opencodePath;
      new Notice(
        isMissingBinaryError(e) ? t().notice.binaryNotFound.replace('{cmd}', cmd) : t().notice.connectFailed,
      );
      return false;
    }
  }

  getClient(): AgentRuntime | null {
    return this.client;
  }

  getVaultCwd(): string {
    return getVaultPath(this.app);
  }

  /** Write a markdown note, creating missing parent folders; overwrites an existing file. */
  async createNote(path: string, content: string): Promise<void> {
    const cleanPath = path.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) throw new Error('empty note path');
    const folder = cleanPath.split('/').slice(0, -1).join('/');
    if (folder) {
      let current = '';
      for (const part of folder.split('/')) {
        current = current ? `${current}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(current)) {
          await this.app.vault.createFolder(current);
        }
      }
    }
    const existing = this.app.vault.getAbstractFileByPath(cleanPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    await this.app.vault.create(cleanPath, content);
  }
}
