// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import CoOberPlugin from './main';
import { VIEW_TYPE } from './types';

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
    sessions: new Map(),
    activeSessionId: null,
    loadPluginData: vi.fn().mockResolvedValue(undefined),
    registerView: vi.fn(),
    deduplicateCoOberLeaves: CoOberPlugin.prototype['deduplicateCoOberLeaves'],
    addRibbonIcon: vi.fn(),
    addSettingTab: vi.fn(),
    addCommand: vi.fn(),
  });
  return plugin;
}
