// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Plugin } from 'obsidian';
import { Notice } from './test/obsidianMock';
import CoOberPlugin from './main';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import { SessionRepository } from './chat/session';
import { AcpClient } from './client/acp';
import { t } from './i18n';

describe('CoOberPlugin view activation', () => {
  it('does not connect to OpenCode while loading the plugin', async () => {
    const workspace = {
      getLeavesOfType: vi.fn(() => []),
    };
    const plugin = createPlugin(workspace);
    plugin.settings.autoConnect = true;
    plugin.initClient = vi.fn().mockResolvedValue(true);

    await plugin.onload();

    expect(plugin.initClient).not.toHaveBeenCalled();
  });

  it('reuses one Co-Ober leaf and detaches duplicates', async () => {
    const leaves: ReturnType<typeof createLeaf>[] = [];
    const existing = createLeaf();
    const duplicate = createLeaf(() => leaves.splice(leaves.indexOf(duplicate), 1));
    leaves.push(existing, duplicate);
    const workspace = {
      getLeavesOfType: vi.fn((viewType: string) => (viewType === VIEW_TYPE ? leaves : [])),
      revealLeaf: vi.fn(),
    };
    const plugin = createPlugin(workspace);

    await plugin.activateView();

    expect(duplicate.detach).toHaveBeenCalledTimes(1);
    expect(existing.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existing);
  });

  it('detaches duplicates that appear while creating a new side leaf', async () => {
    const created = createLeaf();
    const leaves: ReturnType<typeof createLeaf>[] = [];
    const lateDuplicate = createLeaf(() => leaves.splice(leaves.indexOf(lateDuplicate), 1));
    const workspace = {
      getLeavesOfType: vi.fn((viewType: string) => (viewType === VIEW_TYPE ? leaves : [])),
      getRightLeaf: vi.fn(() => {
        leaves.push(created, lateDuplicate);
        return created;
      }),
      getLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };
    const plugin = createPlugin(workspace);

    await plugin.activateView();

    expect(created.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
    expect(lateDuplicate.detach).toHaveBeenCalledTimes(1);
    expect(workspace.revealLeaf).toHaveBeenCalledWith(created);
  });
});

describe('CoOberPlugin persistence', () => {
  it('serializes concurrent plugin-data saves', async () => {
    let resolveFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirstSave = resolve;
    });
    const saveData = vi.spyOn(Plugin.prototype, 'saveData')
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValue(undefined);
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    const pendingFirst = plugin.savePluginData();
    const pendingSecond = plugin.savePluginData();

    await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(1));
    resolveFirstSave();
    await Promise.all([pendingFirst, pendingSecond]);
    expect(saveData).toHaveBeenCalledTimes(2);
    saveData.mockRestore();
  });

  it('persists the session state after pruning it', async () => {
    const saveData = vi.spyOn(Plugin.prototype, 'saveData').mockResolvedValue(undefined);
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS, maxSessionMessages: 4, sessionRetentionDays: 30 };
    plugin.sessionStore.hydrate([{
      sessionId: 's1',
      title: 'Session',
      messages: Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: `message ${index}`,
        type: 'text' as const,
        timestamp: index,
      })),
      createdAt: 1,
      updatedAt: Date.now(),
    }], 's1');

    await plugin.savePluginData();

    expect(saveData).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ content: '[3 messages truncated]' }),
      ]) })],
    }));
    saveData.mockRestore();
  });

  it('writes a final save on unload so a debounced stream tail survives shutdown', async () => {
    const saveData = vi.spyOn(Plugin.prototype, 'saveData').mockResolvedValue(undefined);
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    plugin.onunload();

    await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(1));
    saveData.mockRestore();
  });

  it('retires the sticky save alarm when the plugin goes away', async () => {
    Notice.messages.length = 0;
    Notice.hidden.length = 0;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockRejectedValue(new Error('disk full'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.savePluginData();
    expect(Reflect.get(plugin, 'saveAlarm')).toBeInstanceOf(Notice);

    // A duration-0 Notice outlives the plugin that raised it, and after a
    // reload the fresh instance starts with saveAlarm = null: nothing could
    // ever hide the toast, which went on accusing the disk of failing for a
    // session that would never write again.
    plugin.onunload();

    await vi.waitFor(() => expect(Notice.hidden).toContain(t().notice.saveFailed));
    expect(Reflect.get(plugin, 'saveAlarm')).toBeNull();
    errorSpy.mockRestore();
    saveSpy.mockRestore();
  });

  it('does not let a throwing outcome handler break the never-rejects save API', async () => {
    // Fire-and-forget call sites rely on savePluginData() settling. Reporting a
    // completed write must not be able to reject it (or relabel it a failure).
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.onPersistenceOutcome = () => {
      throw new Error('view exploded while painting');
    };

    await expect(plugin.savePluginData()).resolves.toBeUndefined();
    // The save API is never-rejects AND the outcome handler exploding must not
    // relabel the write: `lastSaveOk` still says the disk path succeeded even
    // though the view callback died.
    expect(plugin.lastSaveOk).toBe(true);

    errSpy.mockRestore();
    saveSpy.mockRestore();
  });
});

describe('CoOberPlugin.loadData autoConnect migration', () => {
  it('keeps auto-connect for legacy data where a stored false was never honored', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      settings: { autoConnect: false },
      sessions: [],
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.settings.autoConnect).toBe(true);
    loadSpy.mockRestore();
  });

  it('respects an explicit false saved under the current schema', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 1,
      settings: { autoConnect: false },
      sessions: [],
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.settings.autoConnect).toBe(false);
    loadSpy.mockRestore();
  });

  it('respects an explicit false when the version field is present but unreadable', async () => {
    // A half-written "schemaVersion": "2" (a string) reads as version 0, but the
    // key's presence still says a version-aware build wrote this file — so the
    // stored false is a real choice and must not be flipped back to true.
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: '2',
      settings: { autoConnect: false },
      sessions: [],
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.settings.autoConnect).toBe(false);
    loadSpy.mockRestore();
  });
});

describe('CoOberPlugin.loadData tab shells', () => {
  const session = { sessionId: 's1', title: 'T', createdAt: 1, updatedAt: 2, messages: [] };

  it('gives a pre-tab conversation a single tab', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 1,
      settings: {},
      sessions: [session],
      activeSessionId: 's1',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.openTabs).toEqual([{ tabId: 'tab-1', sessionId: 's1' }]);
    expect(data?.activeTabId).toBeNull();
    loadSpy.mockRestore();
  });

  it('drops a tab whose conversation is gone and the front pointer with it', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: [session],
      activeSessionId: 's1',
      openTabs: [
        { tabId: 'tab-1', sessionId: 's1' },
        { tabId: 'tab-2', sessionId: 'gone' },
      ],
      activeTabId: 'tab-2',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.openTabs).toEqual([{ tabId: 'tab-1', sessionId: 's1' }]);
    expect(data?.activeTabId).toBeNull();
    loadSpy.mockRestore();
  });
});

describe('CoOberPlugin.loadData foreign session list', () => {
  it('treats a present-but-not-a-list session field as a load failure', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: { not: 'a list' },
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    // A truncated or foreign write, not an empty history: throwing routes the
    // caller to the restore-from-backup path instead of saving over the backup.
    await expect(plugin.loadData()).rejects.toThrow('session list is missing or not an array');
    loadSpy.mockRestore();
  });

  it('accepts a well-formed empty list as an intentionally emptied store', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: [],
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.sessions).toEqual([]);
    loadSpy.mockRestore();
  });

  it('treats a versioned file that lost the sessions field entirely as a load failure', async () => {
    // buildPluginData() always writes sessions, so a file stamped v2 with no
    // sessions key at all is a truncated/foreign write, not an empty history.
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: { defaultModel: 'x' },
      activeSessionId: null,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    await expect(plugin.loadData()).rejects.toThrow('session list is missing or not an array');
    loadSpy.mockRestore();
  });

  it('treats a stamped file that lost settings, sessions and the pointer together as a load failure', async () => {
    // Half a save can leave only the schemaVersion and the tab shells behind.
    // That file carried none of the keys the versioned branch keys off, so it
    // took the legacy path, hydrated as an empty plugin, and the next autosave
    // wrote over the recoverable bytes with the empty store — the rolling
    // backup never even offered itself.
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      openTabs: [{ tabId: 'tab-1', sessionId: 'ses-a' }],
      activeTabId: 'tab-1',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    await expect(plugin.loadData()).rejects.toThrow('session list is missing or not an array');
    loadSpy.mockRestore();
  });

  it('fails a versioned list of ids that carries no conversation record at all', async () => {
    // The array check passed: the list is a list. But every element is a bare
    // id, so the migration restores zero conversations — the plugin hydrated
    // as an empty store, restamped the file and the next autosave buried bytes
    // a version-aware writer wrote, exactly as if the list had been lost.
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: ['ses-1', 'ses-2'],
      activeSessionId: 'ses-1',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    await expect(plugin.loadData()).rejects.toThrow('carries no loadable conversation');
    loadSpy.mockRestore();
  });

  it('loads a versioned list whose usable records survive alongside junk ones', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: ['ses-1', { sessionId: 'ses-2', title: 'kept', createdAt: 1, updatedAt: 2, messages: [] }],
      activeSessionId: 'ses-2',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    // Partial damage stays partial: refusing the whole file over one bad entry
    // would throw away the conversation that did read.
    expect(data?.sessions.map((s) => s.sessionId)).toEqual(['ses-2']);
    loadSpy.mockRestore();
  });

  it('fails a stamped file that lists one session id twice', async () => {
    // hydrate() writes both records into the same Map key and the later one
    // wins, so a list that names a conversation twice restores fewer
    // conversations than it claims — silently, and as a *successful* load, so
    // restore-from-backup never offered itself and the next autosave wrote the
    // collapsed file. This build's own writer cannot produce the shape.
    const record = (title: string) => ({ sessionId: 'ses-dup', title, createdAt: 1, updatedAt: 2, messages: [] });
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: [record('first'), record('second')],
      activeSessionId: 'ses-dup',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    await expect(plugin.loadData()).rejects.toThrow('lists one session id twice');
    loadSpy.mockRestore();
  });

  it('loads a stamped file whose every session id is distinct', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 2,
      settings: {},
      sessions: [
        { sessionId: 'ses-a', title: 'A', createdAt: 1, updatedAt: 2, messages: [] },
        { sessionId: 'ses-b', title: 'B', createdAt: 1, updatedAt: 3, messages: [] },
      ],
      activeSessionId: 'ses-a',
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.sessions.map((s) => s.sessionId)).toEqual(['ses-a', 'ses-b']);
    loadSpy.mockRestore();
  });

  it('leaves a pre-schema file without a session list on the legacy defaults path', async () => {
    const loadSpy = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      defaultModel: 'x',
      autoConnect: false,
    });
    const plugin = new CoOberPlugin({} as never, {} as never);

    const data = await plugin.loadData();

    expect(data?.sessions).toEqual([]);
    loadSpy.mockRestore();
  });
});

describe('CoOberPlugin.loadData corrupt file on disk', () => {
  function corruptPlugin(exists: boolean, raw: string) {
    const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
    Object.assign(plugin, {
      app: {
        vault: {
          configDir: '.obsidian',
          adapter: { exists: vi.fn(async () => exists), read: vi.fn(async () => raw) },
        },
      },
      manifest: { id: 'co-ober' },
    });
    return plugin;
  }

  it('routes a present-but-unparseable data.json into the load-failure path', async () => {
    // Real Obsidian returns null for a corrupt file exactly as it does for a
    // missing one; without the probe the plugin would load defaults and the
    // next autosave would overwrite the bytes the rolling backup might restore.
    const plugin = corruptPlugin(true, '{"schemaVersion": 2, "sessions": [');

    await expect(plugin.loadData()).rejects.toThrow('present but could not be parsed');
  });

  it('still treats a genuinely absent file as fresh defaults', async () => {
    const plugin = corruptPlugin(false, '');

    await expect(plugin.loadData()).resolves.toBeNull();
  });
});

describe('CoOberPlugin corrupted data recovery', () => {
  function createLoadPlugin(loadData: () => Promise<unknown>) {
    const rename = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn().mockResolvedValue(true);
    const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
    Object.assign(plugin, {
      app: {
        vault: { configDir: '.obsidian', adapter: { exists, rename } },
        workspace: { getLeavesOfType: vi.fn(() => []) },
      },
      manifest: { id: 'co-ober' },
      settings: { ...DEFAULT_SETTINGS },
      sessionStore: { hydrate: vi.fn() },
      loadData,
      registerView: vi.fn(),
      deduplicateCoOberLeaves: vi.fn(),
      addRibbonIcon: vi.fn(),
      addSettingTab: vi.fn(),
      addCommand: vi.fn(),
    });
    return { plugin, rename, exists };
  }

  it('sets the unreadable file aside and starts with defaults instead of bricking', async () => {
    Notice.messages.length = 0;
    const { plugin, rename, exists } = createLoadPlugin(() => Promise.reject(new Error('bad json')));

    await plugin.onload();

    expect(exists).toHaveBeenCalledWith('.obsidian/plugins/co-ober/data.json');
    expect(rename).toHaveBeenCalledWith(
      '.obsidian/plugins/co-ober/data.json',
      expect.stringMatching(/^\.obsidian\/plugins\/co-ober\/data\.corrupt-\d+\.json$/),
    );
    expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
    expect(Notice.messages.some((m) => m.includes('.corrupt-'))).toBe(true);
  });

  it('still starts with defaults when the corrupt file cannot be renamed away', async () => {
    Notice.messages.length = 0;
    const { plugin, rename } = createLoadPlugin(() => Promise.reject(new Error('bad json')));
    rename.mockRejectedValueOnce(new Error('rename denied'));

    await plugin.onload();

    expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
    expect(Notice.messages.some((m) => m.includes('starting with defaults'))).toBe(true);
  });

  it('does not treat a missing data.json as a failed rename backup', async () => {
    Notice.messages.length = 0;
    const { plugin, rename } = createLoadPlugin(() => Promise.reject(new Error('bad json')));
    rename.mockResolvedValue(undefined);
    (plugin.app.vault.adapter.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await plugin.onload();

    expect(rename).not.toHaveBeenCalled();
    expect(Notice.messages.some((m) => m.includes('starting with defaults'))).toBe(true);
  });

  describe('rolling backup', () => {
    const DATA = '.obsidian/plugins/co-ober/data.json';
    const BAK = '.obsidian/plugins/co-ober/data.json.bak';

    function createBackupPlugin(options: { loadData: (() => Promise<unknown>)[]; backup: string | null; live?: string }) {
      const files = new Map<string, string>();
      files.set(DATA, options.live ?? '{"schemaVersion": 2, "sessions": [{"sess');
      if (options.backup !== null) files.set(BAK, options.backup);
      const rename = vi.fn(async (from: string, to: string) => {
        files.set(to, files.get(from) ?? '');
        files.delete(from);
      });
      const attempts = [...options.loadData];
      const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
      Object.assign(plugin, {
        app: {
          vault: {
            configDir: '.obsidian',
            adapter: {
              exists: vi.fn(async (path: string) => files.has(path)),
              rename,
              read: vi.fn(async (path: string) => files.get(path) ?? ''),
              write: vi.fn(async (path: string, content: string) => {
                files.set(path, content);
              }),
            },
          },
          workspace: { getLeavesOfType: vi.fn(() => []) },
        },
        manifest: { id: 'co-ober' },
        settings: { ...DEFAULT_SETTINGS },
        saveMutex: { runExclusive: (fn: () => Promise<unknown>) => fn() },
        sessionStore: { hydrate: vi.fn(), hydrateTabShell: vi.fn(), prune: vi.fn(), snapshot: () => ({ sessions: [], activeSessionId: null }) },
        loadData: vi.fn(async () => {
          const next = attempts.shift();
          if (!next) throw new Error('loadData called more times than the test allowed');
          return next();
        }),
        registerView: vi.fn(),
        deduplicateCoOberLeaves: vi.fn(),
        addRibbonIcon: vi.fn(),
        addSettingTab: vi.fn(),
        addCommand: vi.fn(),
      });
      return { plugin, files, rename };
    }

    it('loads the last complete save instead of starting empty', async () => {
      Notice.messages.length = 0;
      const good = JSON.stringify({
        schemaVersion: 2,
        settings: { defaultModel: 'kept-model' },
        sessions: [{ sessionId: 's1', title: 'kept', createdAt: 1, updatedAt: 2, messages: [] }],
        activeSessionId: 's1',
      });
      const { plugin, files } = createBackupPlugin({
        loadData: [() => Promise.reject(new Error('bad json')), () => Promise.resolve(JSON.parse(good))],
        backup: good,
      });

      await plugin.onload();

      // The truncated file is set aside rather than overwritten, and the
      // conversations come back from the copy of the previous good save.
      expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith(
        [expect.objectContaining({ sessionId: 's1' })],
        's1',
      );
      expect(plugin.settings.defaultModel).toBe('kept-model');
      expect([...files.keys()]).toContain(DATA);
      expect(Notice.messages.some((m) => m.includes('last complete save'))).toBe(true);
      expect(Notice.messages.some((m) => m.includes('starting with defaults'))).toBe(false);
    });

    it('refuses a backup that would load as fewer conversations than it names', async () => {
      Notice.messages.length = 0;
      // Two records, one sessionId: promoting this copy would set the damaged
      // file as data.json, hydrate one conversation instead of two, report the
      // load a success, and bury the live file's shape under the next autosave.
      const dup = JSON.stringify({
        schemaVersion: 2,
        settings: {},
        sessions: [
          { sessionId: 'ses-a', title: 'A', createdAt: 1, updatedAt: 2, messages: [] },
          { sessionId: 'ses-a', title: 'B', createdAt: 1, updatedAt: 3, messages: [] },
        ],
        activeSessionId: 'ses-a',
      });
      const { plugin, files } = createBackupPlugin({
        loadData: [() => Promise.reject(new Error('bad json'))],
        backup: dup,
      });

      await plugin.onload();

      expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
      expect([...files.keys()].some((p) => p.includes('.corrupt-'))).toBe(true);
    });

    it('keeps the defaults path when the backup will not parse either', async () => {
      Notice.messages.length = 0;
      const { plugin, files } = createBackupPlugin({
        loadData: [() => Promise.reject(new Error('bad json'))],
        backup: '{"schemaVersion": 2, "sessions": [',
      });

      await plugin.onload();

      expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
      expect([...files.keys()].some((p) => p.includes('.corrupt-'))).toBe(true);
      expect(Notice.messages.some((m) => m.includes('starting with defaults'))).toBe(true);
    });

    it('refreshes the backup after a save that worked', async () => {
      const { plugin, files } = createBackupPlugin({ loadData: [], backup: null, live: '' });
      const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockImplementation(async () => {
        files.set(DATA, '{"schemaVersion":2,"sessions":[]}');
      });

      await plugin.savePluginData();

      expect(files.get(BAK)).toBe('{"schemaVersion":2,"sessions":[]}');
      saveSpy.mockRestore();
    });

    it('still saves when the backup cannot be written', async () => {
      const { plugin, files } = createBackupPlugin({ loadData: [], backup: null, live: '' });
      const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockImplementation(async () => {
        files.set(DATA, '{"schemaVersion":2,"sessions":[]}');
      });
      (plugin.app.vault.adapter.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('read-only volume'));
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await plugin.savePluginData();

      expect(files.get(DATA)).toBe('{"schemaVersion":2,"sessions":[]}');
      expect(consoleWarn).toHaveBeenCalledWith(
        '[co-ober] could not refresh data.json backup:',
        expect.any(Error),
      );
      consoleWarn.mockRestore();
      saveSpy.mockRestore();
    });

    it('refuses to promote a save that lost every conversation over a populated backup', async () => {
      const populated = JSON.stringify({
        schemaVersion: 2,
        settings: {},
        sessions: [{ sessionId: 's1', title: 'kept', createdAt: 1, updatedAt: 2, messages: [] }],
        activeSessionId: 's1',
      });
      const { plugin, files } = createBackupPlugin({ loadData: [], backup: populated, live: '' });
      const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockImplementation(async () => {
        // The crash/full-disk signature the backup exists to survive: the live
        // file now holds no conversations at all.
        files.set(DATA, '{"schemaVersion":2,"sessions":[]}');
      });

      await plugin.savePluginData();

      // Copying that emptiness over the backup would make the loss permanent,
      // so the last good copy is left exactly where it is.
      expect(files.get(BAK)).toBe(populated);
      saveSpy.mockRestore();
    });

    it('refuses to promote an id-list save whose sessions would not load over a populated backup', async () => {
      const populated = JSON.stringify({
        schemaVersion: 2,
        settings: {},
        sessions: [{ sessionId: 's1', title: 'kept', createdAt: 1, updatedAt: 2, messages: [] }],
        activeSessionId: 's1',
      });
      const { plugin, files } = createBackupPlugin({ loadData: [], backup: populated, live: '' });
      const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockImplementation(async () => {
        // Parses, and sessions is an array — but every entry is a bare id, so
        // this build loads no conversation from it at all. Counted by the
        // array's length it read as two, and the copy still holding the real
        // sessions would have been replaced by nothing.
        files.set(DATA, '{"schemaVersion":2,"sessions":["ses-1","ses-2"]}');
      });

      await plugin.savePluginData();

      expect(files.get(BAK)).toBe(populated);
      saveSpy.mockRestore();
    });

    it('does not promote a backup whose session list would itself load as nothing', async () => {
      // loadData() now refuses a versioned list that names conversations and
      // yields none, so a copy of that shape has to fail the same gate here: it
      // would be written over the live file, throw on the load that follows,
      // and leave the restored bytes renamed away as .corrupt-* with no
      // data.json in their place.
      Notice.messages.length = 0;
      const useless = JSON.stringify({
        schemaVersion: 2,
        settings: {},
        sessions: ['ses-1', 'ses-2'],
        activeSessionId: 'ses-1',
      });
      const { plugin, files } = createBackupPlugin({
        loadData: [() => Promise.reject(new Error('no loadable conversation'))],
        backup: useless,
      });

      await plugin.onload();

      expect([...files.keys()]).not.toContain(DATA);
      expect(files.get(BAK)).toBe(useless);
      expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
      expect(Notice.messages.some((m) => m.includes('starting with defaults'))).toBe(true);
    });

    it('still refreshes the backup when a save shrinks it without emptying it', async () => {
      const populated = JSON.stringify({
        schemaVersion: 2,
        settings: {},
        sessions: [
          { sessionId: 's1', title: 'kept', createdAt: 1, updatedAt: 2, messages: [] },
          { sessionId: 's2', title: 'gone', createdAt: 1, updatedAt: 2, messages: [] },
        ],
        activeSessionId: 's1',
      });
      const { plugin, files } = createBackupPlugin({ loadData: [], backup: populated, live: '' });
      const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockImplementation(async () => {
        // A routine retention prune: fewer conversations, still not empty.
        files.set(DATA, '{"schemaVersion":2,"sessions":[{"sessionId":"s1"}]}');
      });

      await plugin.savePluginData();

      expect(files.get(BAK)).toBe('{"schemaVersion":2,"sessions":[{"sessionId":"s1"}]}');
      saveSpy.mockRestore();
    });
  });

  it('surfaces a save failure once per throttle window', async () => {
    Notice.messages.length = 0;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockRejectedValue(new Error('disk full'));
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.savePluginData();
    await plugin.savePluginData();

    expect(Notice.messages.filter((m) => m.includes('failed to save'))).toHaveLength(1);
    saveSpy.mockRestore();
  });

  it('surfaces a save failure as a sticky notice', async () => {
    Notice.messages.length = 0;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockRejectedValue(new Error('disk full'));
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.savePluginData();

    const alarm = Reflect.get(plugin, 'saveAlarm') as Notice | null;
    expect(alarm).toBeInstanceOf(Notice);
    expect(alarm?.message).toBe(t().notice.saveFailed);
    expect(alarm?.duration).toBe(0);
    saveSpy.mockRestore();
  });

  it('tells the open conversation whether its transcript reached the disk', async () => {
    const outcome = vi.fn();
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.onPersistenceOutcome = outcome;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData');

    saveSpy.mockRejectedValueOnce(new Error('disk full'));
    await plugin.savePluginData();
    expect(outcome).toHaveBeenLastCalledWith(true);

    // The plugin reports every outcome; the tabs decide how often to say so.
    saveSpy.mockResolvedValueOnce(undefined);
    await plugin.savePluginData();
    expect(outcome).toHaveBeenLastCalledWith(false);
    saveSpy.mockRestore();
  });

  it('hides the sticky alarm once a later save succeeds', async () => {
    Notice.messages.length = 0;
    Notice.hidden.length = 0;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData').mockRejectedValueOnce(new Error('disk full'));
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await plugin.savePluginData();
    expect(Reflect.get(plugin, 'saveAlarm')).toBeInstanceOf(Notice);

    // A successful write clears the alarm and resets the throttle.
    saveSpy.mockResolvedValueOnce(undefined);
    await plugin.savePluginData();

    expect(Notice.hidden).toContain(t().notice.saveFailed);
    expect(Reflect.get(plugin, 'saveAlarm')).toBeNull();
    saveSpy.mockRestore();
  });

  it('re-arms a fresh alarm after a success even within the throttle window', async () => {
    Notice.messages.length = 0;
    Notice.hidden.length = 0;
    const saveSpy = vi.spyOn(Plugin.prototype, 'saveData');
    const plugin = new CoOberPlugin({} as never, {} as never);
    plugin.settings = { ...DEFAULT_SETTINGS };

    saveSpy.mockRejectedValueOnce(new Error('disk full'));
    await plugin.savePluginData();
    saveSpy.mockResolvedValueOnce(undefined);
    await plugin.savePluginData();
    saveSpy.mockRejectedValueOnce(new Error('disk full'));
    await plugin.savePluginData();

    // The reset lastSaveNoticeAt means the second failure is not swallowed.
    expect(Notice.messages.filter((m) => m.includes('failed to save'))).toHaveLength(2);
    saveSpy.mockRestore();
  });

  it('sets aside a data.json written by a newer schema instead of restamping it', async () => {
    Notice.messages.length = 0;
    const superLoad = vi.spyOn(Plugin.prototype, 'loadData').mockResolvedValue({
      schemaVersion: 5,
      settings: {},
      sessions: [],
      activeSessionId: null,
    });
    const { plugin, rename } = createLoadPlugin(() =>
      (CoOberPlugin.prototype as unknown as { loadData: () => Promise<unknown> }).loadData.call(plugin),
    );

    await plugin.onload();

    expect(rename).toHaveBeenCalledWith(
      '.obsidian/plugins/co-ober/data.json',
      expect.stringMatching(/^\.obsidian\/plugins\/co-ober\/data\.newer-\d+\.json$/),
    );
    expect(plugin.sessionStore.hydrate).toHaveBeenCalledWith([], null);
    expect(Notice.messages.some((m) => m.includes('newer Co-Ober version') && m.includes('schema 5'))).toBe(true);
    superLoad.mockRestore();
  });
});

function createLeaf(onDetach?: () => void) {
  return {
    setViewState: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn(() => onDetach?.()),
  };
}

function createPlugin(workspace: unknown): CoOberPlugin {
  const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
  Object.assign(plugin, {
    app: { workspace },
    settings: {
      language: 'en',
      autoConnect: false,
    },
    sessionStore: new SessionRepository(async () => {}),
    loadPluginData: vi.fn().mockResolvedValue(undefined),
    registerView: vi.fn(),
    deduplicateCoOberLeaves: CoOberPlugin.prototype['deduplicateCoOberLeaves'],
    addRibbonIcon: vi.fn(),
    addSettingTab: vi.fn(),
    addCommand: vi.fn(),
  });
  return plugin;
}

describe('CoOberPlugin connect failure messaging', () => {
  function createConnectPlugin(opencodePath: string) {
    const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
    Object.assign(plugin, {
      app: { vault: { adapter: { getBasePath: () => process.cwd() } } },
      manifest: { id: 'co-ober' },
      settings: { ...DEFAULT_SETTINGS, opencodePath },
    });
    return plugin;
  }

  const connectClientOf = (plugin: CoOberPlugin) =>
    (plugin as unknown as { connectClient: () => Promise<boolean> }).connectClient.bind(plugin);

  it('names the missing binary when the configured command cannot spawn', async () => {
    Notice.messages.length = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = createConnectPlugin('/nonexistent/co-ober-connect-xyz');

    const ok = await connectClientOf(plugin)();

    expect(ok).toBe(false);
    expect(Notice.messages.some((m) => m.includes('Could not find') && m.includes('co-ober-connect-xyz'))).toBe(true);
    errSpy.mockRestore();
  });

  it('keeps the generic failure notice for a launch that dies after spawning', async () => {
    Notice.messages.length = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = createConnectPlugin(process.execPath);

    const ok = await connectClientOf(plugin)();

    expect(ok).toBe(false);
    expect(Notice.messages.some((m) => m.includes('Could not find'))).toBe(false);
    expect(Notice.messages.some((m) => m.includes('Failed to connect'))).toBe(true);
    errSpy.mockRestore();
  });

  it('disconnects a live client before replacing it', async () => {
    Notice.messages.length = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = createConnectPlugin('/nonexistent/co-ober-stale-xyz');
    const disconnect = vi.fn().mockResolvedValue(undefined);
    plugin.client = { disconnect } as unknown as CoOberPlugin['client'];

    const ok = await connectClientOf(plugin)();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    expect(plugin.client).toBeNull();
    errSpy.mockRestore();
  });
});

describe('CoOberPlugin capability tier reaches the handshake', () => {
  function tierPlugin(permissionMode: 'readonly' | 'safe') {
    const plugin = Object.create(CoOberPlugin.prototype) as CoOberPlugin;
    Object.assign(plugin, {
      app: { vault: { adapter: { getBasePath: () => process.cwd() } } },
      manifest: { id: 'co-ober' },
      settings: { ...DEFAULT_SETTINGS, opencodePath: 'opencode', permissionMode },
      client: null,
    });
    return plugin;
  }

  const connectClientOf = (plugin: CoOberPlugin) =>
    (plugin as unknown as { connectClient: () => Promise<boolean> }).connectClient.bind(plugin);

  async function runConnect(permissionMode: 'readonly' | 'safe') {
    Notice.messages.length = 0;
    const order: string[] = [];
    const connect = vi
      .spyOn(AcpClient.prototype, 'connect')
      .mockImplementation(async () => void order.push('connect'));
    const setFs = vi
      .spyOn(AcpClient.prototype, 'setFsCapabilityMode')
      .mockImplementation(() => void order.push('fs'));
    const setTerminal = vi
      .spyOn(AcpClient.prototype, 'setTerminalCapabilityMode')
      .mockImplementation(() => void order.push('terminal'));
    const plugin = tierPlugin(permissionMode);

    const ok = await connectClientOf(plugin)();

    // Restore first, then keep the recorded calls: vitest clears a spy's call
    // data along with its implementation.
    const fsCalls = setFs.mock.calls.map((call) => [...call]);
    const terminalCalls = setTerminal.mock.calls.map((call) => [...call]);
    connect.mockRestore();
    setFs.mockRestore();
    setTerminal.mockRestore();
    return { ok, order, plugin, fsCalls, terminalCalls };
  }

  it('applies the stored tier before the initialize handshake speaks', async () => {
    const { ok, order, fsCalls, terminalCalls } = await runConnect('readonly');

    expect(ok).toBe(true);
    expect(order).toEqual(['fs', 'terminal', 'connect']);
    expect(fsCalls[0]?.[0]).toBe('readonly');
    expect(terminalCalls[0]?.[0]).toBe('disabled');
  });

  it('keeps the runtime on the stored tier too, not on its own default', async () => {
    const { plugin } = await runConnect('readonly');

    expect(plugin.client?.permissionMode).toBe('readonly');
  });

  it('leaves a permissive tier to the user’s own capability settings', async () => {
    const { order, fsCalls, terminalCalls } = await runConnect('safe');

    expect(order).toEqual(['fs', 'terminal', 'connect']);
    expect(fsCalls[0]?.[0]).toBe(DEFAULT_SETTINGS.fsCapability ?? 'enabled');
    expect(fsCalls[0]?.[1]).toBe(DEFAULT_SETTINGS.maxNoteSize);
    expect(terminalCalls[0]?.[0]).toBe(DEFAULT_SETTINGS.terminalCapability ?? 'enabled');
    expect(terminalCalls[0]?.[1]).toBe(DEFAULT_SETTINGS.terminalTimeoutMs);
    expect(terminalCalls[0]?.[2]).toBe(DEFAULT_SETTINGS.terminalMaxOutputBytes);
  });
});
