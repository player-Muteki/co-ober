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
        expect.objectContaining({ content: '[3 earlier messages truncated]' }),
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
      clientReadyResolvers: [],
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
      clientReadyResolvers: [],
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
