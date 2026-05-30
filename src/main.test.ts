// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import CopsilotPlugin from './main';
import { VIEW_TYPE } from './types';

describe('CopsilotPlugin view activation', () => {
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

  it('reuses one Copsilot leaf and detaches duplicates', async () => {
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
      ensureSideLeaf: vi.fn().mockImplementation(async () => {
        leaves.push(created, lateDuplicate);
        return created;
      }),
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

function createPlugin(workspace: unknown): CopsilotPlugin {
  const plugin = Object.create(CopsilotPlugin.prototype) as CopsilotPlugin;
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
    deduplicateCopsilotLeaves: CopsilotPlugin.prototype['deduplicateCopsilotLeaves'],
    addRibbonIcon: vi.fn(),
    addSettingTab: vi.fn(),
    addCommand: vi.fn(),
  });
  return plugin;
}
