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
import {
  isLoadableSessionEntry,
  migratePluginDataSessions,
  migratePluginDataTabs,
  hasDuplicateSessionIds,
  readSchemaVersion,
  sanitizeLoadedSettings,
  PLUGIN_DATA_SCHEMA_VERSION,
  PluginDataTooNewError,
} from './chat/pluginDataMigration';
import { SAVE_NOTICE_THROTTLE_MS } from './constants';

export default class CoOberPlugin extends Plugin {
  settings: CoOberSettings = DEFAULT_SETTINGS;
  client: AgentRuntime | null = null;
  readonly sessionStore = new SessionRepository(() => this.savePluginData());
  // The Settings tab instance is kept so a chat-view bar click on the
  // permission tier can repaint the dropdown the same panel already opened —
  // the sibling-repaint fanout that `refreshOpenViewsPermission` runs in the
  // other direction. `null` until onload, and views call it through optional
  // chaining so a mid-construction click stays a no-op rather than a throw.
  settingsTab: CoOberSettingsTab | null = null;
  /**
   * The open chat view subscribes to each write's outcome. One data.json save
   * carries every conversation, so a failure is each tab's news — the throttled
   * Notice below only says the disk is bad, not which transcript is at risk.
   */
  onPersistenceOutcome: ((failed: boolean) => void) | null = null;
  private connecting: Promise<boolean> | null = null;
  private readonly saveMutex = new Mutex();

  override async onload(): Promise<void> {
    try {
      await this.loadPluginData();
    } catch (e) {
      // A corrupted or newer-than-supported data.json must not brick the
      // plugin: fall back to defaults and keep the file aside so the data
      // is not silently lost or downgraded.
      console.error('[co-ober] failed to load plugin data:', e);
      const tooNew = e instanceof PluginDataTooNewError;
      if (tooNew || !(await this.restoreFromRollingBackup())) {
        const backupPath = await this.backupUnreadableData(tooNew ? 'newer' : 'corrupt');
        this.settings = { ...DEFAULT_SETTINGS };
        this.sessionStore.hydrate([], null);
        new Notice(
          backupPath && tooNew
            ? t().notice.dataLoadTooNew
                .replace('{version}', String(e.foundVersion))
                .replace('{file}', backupPath)
            : backupPath
              ? t().notice.dataLoadFailed.replace('{file}', backupPath)
              : t().notice.dataLoadFailedNoBackup,
        );
      } else {
        new Notice(t().notice.dataRestoredFromBackup);
      }
    }
    setLocale(this.settings.language);

    this.registerView(VIEW_TYPE, (leaf) => new CoOberView(leaf, this));
    this.deduplicateCoOberLeaves();
    this.addRibbonIcon('terminal-square', t().app.ribbon, () => this.activateView());
    const settingsTab = new CoOberSettingsTab(this);
    this.settingsTab = settingsTab;
    this.addSettingTab(settingsTab);
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
    void this.savePluginData()
      .catch((e) => console.warn('[co-ober] unload save failed:', e))
      .finally(() => {
        // The save-failure alarm is a duration-0 Notice, so it outlives the
        // plugin that raised it: a reload creates a fresh instance whose
        // saveAlarm is null and can never hide this toast, leaving an
        // unhideable "your disk is failing" banner on screen for a session
        // that will never write again. Settle it once teardown is final; the
        // console line above still records why.
        this.dismissSaveAlarm();
      });
    void this.client?.disconnect().catch(() => {});
  }

  // ── Unified storage ──

  override async loadData(): Promise<PluginData | null> {
    const saved: unknown = await super.loadData();
    if (!saved) {
      // Real Obsidian swallows a JSON.parse failure and returns the same null
      // it returns for a missing file, so a torn data.json — the crash-mid-save
      // the rolling backup exists to survive — would otherwise load as fresh
      // defaults and let the next autosave overwrite the recoverable bytes. If
      // the file is present with content that did not parse, fail the load so
      // the caller routes into restore-from-backup.
      if (await this.existsNonEmptyDataFile()) throw new Error('data.json is present but could not be parsed');
      return null;
    }

    // A file written by a newer schema must never be migrated-and-restamped:
    // it goes through the load-failure path so it can be set aside intact.
    const storedVersion = readSchemaVersion(saved);
    if (storedVersion > PLUGIN_DATA_SCHEMA_VERSION) throw new PluginDataTooNewError(storedVersion);

    // A file this build stamps always carries the session list. If it is absent,
    // or present but not a list, the write was truncated or foreign — not an
    // intentionally empty history — so fail the load and let the caller restore
    // the rolling backup. The check has to run before the hasPluginData split
    // below: half a save can lose the settings, the session list and the active
    // pointer together while leaving its schemaVersion behind, and that file
    // took the legacy branch, hydrated as an empty plugin, and had its
    // recoverable bytes overwritten by the next autosave. Pre-schema files
    // legitimately omit the key and stay treated as an empty store.
    const storedSessions = saved !== null && typeof saved === 'object' ? (saved as Partial<PluginData>).sessions : undefined;
    if (storedVersion >= 1 && !Array.isArray(storedSessions)) {
      throw new Error('data.json session list is missing or not an array');
    }

    const hasPluginData =
      typeof saved === 'object' &&
      saved !== null &&
      ('settings' in saved || 'sessions' in saved || 'activeSessionId' in saved);

    if (hasPluginData) {
      const data = saved as Partial<PluginData>;
      const restored = migratePluginDataSessions(data.sessions, data.activeSessionId);
      // The list existing as an array is only half of "the file carried a
      // history": an ids-only array and a list of records this build refuses
      // (no role, content that is not a string) both pass the check above and
      // then restore as zero conversations. That is the same loss the missing
      // list would be — the plugin hydrates empty, restamps the file and the
      // next autosave buries bytes a version-aware writer wrote — so a file
      // that claimed conversations and yielded none fails to the backup path.
      // An intentionally empty history writes `sessions: []` and stays fine.
      if (storedVersion >= 1 && Array.isArray(storedSessions) && storedSessions.length > 0 && restored.sessions.length === 0) {
        throw new Error('data.json session list carries no loadable conversation');
      }
      // A second gate on the same evidence: hydrate() writes two records that
      // share a sessionId into the same Map key and the later one wins, so the
      // load reports success, restore-from-backup never runs, and the
      // conversation the reader expected is gone from the screen and from the
      // next autosave. This build cannot produce that shape — the snapshot comes
      // out of a Map keyed by sessionId — so a duplicate is a partial merge, a
      // foreign writer or a hand edit, and failing here is the only moment the
      // loss is still reversible.
      if (storedVersion >= 1 && hasDuplicateSessionIds(restored.sessions)) {
        throw new Error('data.json lists one session id twice');
      }
      const surviving = new Set(restored.sessions.map((session) => session.sessionId));
      const tabs = migratePluginDataTabs(data.openTabs, data.activeTabId, surviving, restored.activeSessionId);
      // The autoConnect toggle did nothing before 0.1.34, so a stored false in
      // genuinely pre-schema data is the old default, not a choice: keep
      // auto-connect. A file that merely failed to read its schemaVersion as a
      // number still carries the key — evidence of a version-aware writer — so
      // its explicit false is respected rather than silently flipped back on.
      const settings = sanitizeLoadedSettings(data.settings, DEFAULT_SETTINGS);
      const looksLegacy = !('schemaVersion' in data);
      if (looksLegacy && settings.autoConnect === false) settings.autoConnect = true;
      return {
        schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
        settings,
        sessions: restored.sessions,
        activeSessionId: restored.activeSessionId,
        openTabs: tabs.openTabs,
        activeTabId: tabs.activeTabId,
      };
    }

    return {
      settings: sanitizeLoadedSettings(saved, DEFAULT_SETTINGS),
      sessions: [],
      activeSessionId: null,
      openTabs: [],
      activeTabId: null,
    };
  }

  override async saveData(data: unknown): Promise<void> {
    await super.saveData(data);
  }

  private buildPluginData(): PluginData {
    // Prune against a private copy of the store (retention, truncation, image
    // budget) so a save never rewrites or strips the transcripts on screen.
    const sessionState = this.sessionStore.snapshot({
      maxMessages: this.settings.maxSessionMessages ?? 200,
      retentionDays: this.settings.sessionRetentionDays ?? 30,
    });
    return {
      schemaVersion: PLUGIN_DATA_SCHEMA_VERSION,
      settings: this.settings,
      ...sessionState,
    };
  }

  private lastSaveNoticeAt = 0;
  private saveAlarm: Notice | null = null;

  /** Clear the sticky save-failure alarm once a write finally succeeds. */
  private dismissSaveAlarm(): void {
    const alarm = this.saveAlarm;
    this.saveAlarm = null;
    alarm?.hide();
  }

  /**
   * Never rejects. Fire-and-forget call sites rely on that. Whether the write
   * reached the disk travels as `lastSaveOk` — the same fact the failure Notice
   * and the `onPersistenceOutcome` handler already carry, now also readable by
   * a caller that wants to say "saved" only when the save landed. `null` means
   * no save has finished yet (the plugin just loaded).
   */
  lastSaveOk: boolean | null = null;

  async savePluginData(): Promise<void> {
    let ok = false;
    try {
      await this.saveMutex.runExclusive(async () => {
        // Pruning happens on the snapshot copy inside buildPluginData, so the
        // live in-memory transcripts are written out as-is and never truncated
        // or image-stripped under the reader's feet.
        await super.saveData(this.buildPluginData());
        await this.writeRollingBackup();
      });
      ok = true;
    } catch (e) {
      // Every save call site except unload is fire-and-forget; surface failures
      // here (throttled) instead of losing chat data silently. The Notice is
      // sticky (duration 0) so a persistently failing disk stays visible
      // between throttle windows instead of evaporating after a few seconds.
      console.error('[co-ober] save failed:', e);
      const now = Date.now();
      if (now - this.lastSaveNoticeAt > SAVE_NOTICE_THROTTLE_MS) {
        this.lastSaveNoticeAt = now;
        // Retire the incumbent before taking its place: a duration-0 Notice never
        // self-expires, so overwriting the reference would strand an unhideable
        // toast that stacks up on every failure after the throttle window.
        this.saveAlarm?.hide();
        this.saveAlarm = new Notice(t().notice.saveFailed, 0);
      }
    }
    this.lastSaveOk = ok;
    // A successful write ends the failure streak: drop the alarm and let the
    // next failure notify immediately.
    if (ok) {
      this.lastSaveNoticeAt = 0;
      this.dismissSaveAlarm();
    }
    // Outcome reporting lives outside the write's try/catch: a throwing view
    // callback must not relabel a write that reached the disk as a failure, nor
    // reject the never-rejects save API the fire-and-forget call sites rely on.
    try {
      this.onPersistenceOutcome?.(!ok);
    } catch (e) {
      console.error('[co-ober] persistence outcome handler failed:', e);
    }
  }

  private async backupUnreadableData(kind: 'corrupt' | 'newer' = 'corrupt'): Promise<string | null> {
    const dataPath = this.dataFilePath();
    const backupPath = `${dataPath.slice(0, -'.json'.length)}.${kind}-${Date.now()}.json`;
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

  private dataFilePath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
  }

  /**
   * True when data.json is on disk with non-empty content. Used only to tell a
   * corrupt save (present, but super.loadData() swallowed the parse error and
   * returned null) apart from a genuinely absent file, so the corrupt case can
   * route to restore-from-backup. Any probe failure fails open to "absent",
   * preserving the old load-defaults behavior rather than crashing startup.
   */
  private async existsNonEmptyDataFile(): Promise<boolean> {
    try {
      const adapter = this.app.vault.adapter;
      const path = this.dataFilePath();
      if (!(await adapter.exists(path))) return false;
      const raw = await adapter.read(path);
      return raw.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * data.json is rewritten whole and not atomically, so a crash or a full disk
   * mid-save costs every conversation the file held. Keeping the previous good
   * copy next to it turns that event into "lose the last save" instead of
   * "start with an empty plugin".
   */
  private async writeRollingBackup(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const dataPath = this.dataFilePath();
      if (!(await adapter.exists(dataPath))) return;
      const raw = await adapter.read(dataPath);
      if (await this.wouldEmptyAPopulatedBackup(raw)) return;
      await adapter.write(`${dataPath}.bak`, raw);
    } catch (e) {
      console.warn('[co-ober] could not refresh data.json backup:', e);
    }
  }

  /**
   * A save that wrote no conversations, against a backup that still holds them,
   * is the crash/full-disk signature this backup exists to survive — promoting it
   * would make the loss permanent. Refuse the copy and leave the good backup
   * where it is. An unparseable incoming file is refused for the same reason.
   */
  private async wouldEmptyAPopulatedBackup(incoming: string): Promise<boolean> {
    const adapter = this.app.vault.adapter;
    const backupPath = `${this.dataFilePath()}.bak`;
    if (!(await adapter.exists(backupPath))) return false;
    const backupCount = countPersistedSessions(await adapter.read(backupPath));
    if (backupCount === null || backupCount === 0) return false;
    const incomingCount = countPersistedSessions(incoming);
    return incomingCount === null || incomingCount === 0;
  }

  /**
   * Promote data.json.bak when the live file will not parse. The damaged file is
   * set aside first, and the backup is only taken when it parses and the rename
   * succeeded — anything else leaves the caller on the old defaults path with
   * the bytes still on disk.
   */
  private async restoreFromRollingBackup(): Promise<boolean> {
    try {
      const adapter = this.app.vault.adapter;
      const dataPath = this.dataFilePath();
      const backupPath = `${dataPath}.bak`;
      if (!(await adapter.exists(backupPath))) return false;
      const raw = await adapter.read(backupPath);
      // Promote only a backup that would actually load. A copy that parses but
      // trips the loader's own checks (too-new, or its session list lost) would
      // be written over the live file and then set aside again by the caller —
      // renaming the bytes we just restored and leaving no data.json at all.
      if (!backupIsLoadable(raw)) return false;
      if (!(await this.backupUnreadableData('corrupt'))) return false;
      await adapter.write(dataPath, raw);
      await this.loadPluginData();
      return true;
    } catch (e) {
      console.warn('[co-ober] no usable data.json backup to restore:', e);
      return false;
    }
  }

  async loadPluginData(): Promise<void> {
    this.settings = DEFAULT_SETTINGS;
    this.sessionStore.hydrate([], null);

    const pluginData = await this.loadData();
    if (!pluginData) return;

    this.settings = sanitizeLoadedSettings(pluginData.settings, DEFAULT_SETTINGS);
    this.sessionStore.hydrate(pluginData.sessions ?? [], pluginData.activeSessionId ?? null);
    this.sessionStore.hydrateTabShell(pluginData.openTabs, pluginData.activeTabId);
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
      coOberView.requestInlineEdit(selected, editor);
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
    // A live client must be torn down before replacement: dropping the
    // reference alone leaves its `opencode acp` subprocess, transport and
    // reconnect timers running as orphans.
    const stale = this.client;
    if (stale) {
      this.client = null;
      await stale.disconnect().catch(() => {});
    }
    try {
      const acp = new AcpClient(this.settings.opencodePath, getVaultPath(this.app), this.createVaultIo());
      // The handshake advertises this client's capabilities, so the stored tier
      // has to be on the client *before* connect() speaks. Applying it after the
      // handshake told an agent that file writes and terminals were off.
      acp.permissionMode = this.settings.permissionMode;
      applyPermissionTier(acp, this.settings.permissionMode, this.settings);
      await acp.connect();
      this.client = new AgentRuntime(acp);
      this.client.permissionMode = this.settings.permissionMode;
      this.client.idleTimeoutMs = this.settings.idleTimeoutMs ?? 300000;
      new Notice(t().notice.connected);
      return true;
    } catch (e) {
      this.client = null;
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

/**
 * How many sessions a serialized data.json would actually load, or null when it
 * cannot be read. Counting what the loader keeps, not the array's length: an id
 * list — `{"sessions":["ses-1","ses-2"]}` — loads as no conversations at all,
 * and read as two it would let an effectively-empty save overwrite the backup
 * that still holds the real copies.
 */
function countPersistedSessions(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    return Array.isArray(parsed?.sessions) ? parsed.sessions.filter(isLoadableSessionEntry).length : null;
  } catch {
    return null;
  }
}

/**
 * Whether a rolling-backup string would actually load: parseable JSON, not
 * newer than this build, and — when versioned — carrying a session list. This
 * mirrors loadData()'s own failure conditions so a backup that would only get
 * set aside again is never promoted over the live file.
 */
function backupIsLoadable(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const version = readSchemaVersion(parsed);
  if (version > PLUGIN_DATA_SCHEMA_VERSION) return false;
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (version >= 1 && !Array.isArray(sessions)) return false;
  // Mirrors loadData()'s second gate using the same migration the load will
  // run: a backup that names conversations but yields none would be written
  // over the live file, fail the load right after, and leave the copy this
  // promotion just set aside as the only remaining data.json.
  if (version >= 1 && Array.isArray(sessions) && sessions.length > 0) {
    const migrated = migratePluginDataSessions(sessions, null);
    if (migrated.sessions.length === 0) return false;
    // The duplicate-id gate the load runs too: promoting a copy whose two
    // records collapse into one session would fail the very next load, and the
    // file this promotion set aside would be the only remaining data.json.
    if (hasDuplicateSessionIds(migrated.sessions)) return false;
  }
  return true;
}
