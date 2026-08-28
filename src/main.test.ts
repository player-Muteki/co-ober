// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Plugin } from 'obsidian';
import CoOberPlugin from './main';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import { SessionRepository } from './chat/session';

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
