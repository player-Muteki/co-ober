// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CoOberView } from './CoOberView';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps } from './CoOberViewController';
import { setLocale } from '../i18n/index';
import { installObsidianDomHelpers } from '../test/domHelpers';
import type CoOberPlugin from '../main';

installObsidianDomHelpers();

describe('CoOberView inline edit preview', () => {
  it('renders changed lines and applies edited text to the active editor selection', () => {
    setLocale('en');
    const view = createView();
    const editor = createEditor();
    setPendingInlineEdit(view, 'old line', editor);

    const inlineEditPanel = Reflect.get(view, 'inlineEditPanel') as InlineEditPanel;
    inlineEditPanel.showDiff('old line', 'new line');

    expect(texts(view, '.diff-line.removed')).toEqual(['-old line']);
    expect(texts(view, '.diff-line.added')).toEqual(['+new line']);

    click(view, '.co-ober-inline-edit-actions .mod-cta');

    expect(editor.replaceSelection).toHaveBeenCalledWith('new line');
    expect(view.contentEl.querySelector('.co-ober-inline-edit-panel')).toBeNull();
  });

  it('discards preview without replacing selected text', () => {
    setLocale('en');
    const view = createView();
    const editor = createEditor();
    setPendingInlineEdit(view, 'original', editor);

    const inlineEditPanel = Reflect.get(view, 'inlineEditPanel') as InlineEditPanel;
    inlineEditPanel.showDiff('original', 'edited');
    click(view, '.co-ober-inline-edit-actions button:not(.mod-cta)');

    expect(editor.replaceSelection).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector('.co-ober-inline-edit-panel')).toBeNull();
  });

  it('refreshes inline edit labels when the locale changes', () => {
    setLocale('en');
    const view = createView();
    setPendingInlineEdit(view, 'old', createEditor());

    const inlineEditPanel = Reflect.get(view, 'inlineEditPanel') as InlineEditPanel;
    inlineEditPanel.showDiff('old', 'new');
    expect(text(view, '.co-ober-inline-edit-title')).toBe('AI Edit Preview');
    expect(text(view, '.mod-cta')).toBe('Apply');

    setLocale('zh');
    view.refreshLocale(); // manual trigger of parent since dom relies on it

    expect(text(view, '.co-ober-inline-edit-title')).toBe('AI 编辑预览');
    expect(text(view, '.mod-cta')).toBe('应用');
    expect(text(view, '.co-ober-inline-edit-actions button:not(.mod-cta)')).toBe('放弃');
  });
});

describe('CoOberView runtime session sync', () => {
  it('opens and tries to connect when view opens', async () => {
    setLocale('en');
    const plugin = createPlugin();
    const view = createView(plugin);

    await view.onOpen();

    expect(view.contentEl.querySelector('.co-ober-header')).not.toBeNull();
    expect(view.contentEl.querySelector('.co-ober-input')).not.toBeNull();
    expect(view.contentEl.querySelector('.co-ober-welcome')).not.toBeNull();
    // Now we try to connect when view opens
    expect(plugin.initClient).toHaveBeenCalled();
    expect(plugin.getClient()).toBeNull();
  });

  it('connects and creates a runtime session when sending the first message', async () => {
    setLocale('en');
    const client = createClient();
    let plugin: CoOberPlugin;
    plugin = createPlugin({
      initClient: vi.fn().mockImplementation(async () => {
        plugin.getClient = vi.fn(() => client) as never;
        return true;
      }),
      settings: { defaultAgent: 'plan', defaultModel: 'openai/gpt', defaultEffort: 'medium' },
    });
    const view = createView(plugin);
    await view.onOpen();

    await Reflect.get(view, 'send').call(view, 'hello', []);

    expect(plugin.initClient).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledWith('/vault', []);
    expect(client.setMode).toHaveBeenCalledWith('runtime-session', 'plan');
    expect(client.setModel).toHaveBeenCalledWith('runtime-session', 'openai/gpt');
    expect(client.setConfigOption).toHaveBeenCalledWith('runtime-session', 'effort', 'medium');
    expect(client.sendMessage).toHaveBeenCalled();
    expect(plugin.savePluginData).toHaveBeenCalled();
  });

  it('loads restored sessions with configured MCP servers', async () => {
    const mcpServers = [
      { id: 'fs', enabled: true, name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    ];
    const client = {
      getCurrentSessionId: vi.fn(() => 'other-session'),
      loadSession: vi.fn().mockResolvedValue(undefined),
    };
    const plugin = {
      app: { vault: { adapter: { getBasePath: () => '/vault' } } },
      settings: { maxNoteSize: 8000, syncRules: [], mcpServers },
      getClient: () => client,
    } as unknown as CoOberPlugin;

    const controller = createController(plugin);
    await controller.syncRuntimeSession('restored-session');

    expect(client.loadSession).toHaveBeenCalledWith('restored-session', '/vault', mcpServers);
  });
});

describe('CoOberView cleanup', () => {
  it('closes safely before the view finishes opening', async () => {
    const view = createView();

    await expect(view.onClose()).resolves.toBeUndefined();
  });
});

function createView(plugin = createPlugin()): CoOberView {
  const view = new CoOberView({} as never, plugin);
  Reflect.set(view, 'registerEvent', vi.fn());
  return view;
}

function createController(plugin: CoOberPlugin): CoOberViewController {
	const noop = vi.fn();
	const deps: ControllerDeps = {
    renderer: {
      clear: noop, addUserMessage: noop, addAssistantPlaceholder: noop, removeAssistantPlaceholder: noop,
      appendText: noop, appendThinking: noop, addError: noop, showUsage: noop, forceScrollToBottom: noop,
      addToolCall: noop, updateToolCall: noop, setPlanEntries: noop,
    } as unknown as ControllerDeps['renderer'],
    input: { setStreaming: noop, focus: noop, appendValue: noop, triggerSend: noop, triggerStop: noop } as unknown as ControllerDeps['input'],
    toolbar: { setSending: noop, updateAgents: noop, updateModels: noop, updateEffort: noop } as unknown as ControllerDeps['toolbar'],
    inlineEditPanel: { clearState: noop, pendingState: null, showDiffFromResponse: noop } as unknown as ControllerDeps['inlineEditPanel'],
    permissionBanner: { dismiss: noop, show: vi.fn() } as unknown as ControllerDeps['permissionBanner'],
    mention: { clear: noop, listAllNotes: vi.fn(() => []), addRef: noop, hasRef: vi.fn(() => false), removeRef: noop } as unknown as ControllerDeps['mention'],
    resolver: { resolveNote: vi.fn() } as unknown as ControllerDeps['resolver'],
    syncEngine: { process: vi.fn() } as unknown as ControllerDeps['syncEngine'],
    sessionStore: {
      get: vi.fn(), getOrCreate: vi.fn(), setActive: vi.fn(), save: vi.fn(), load: vi.fn(), remove: vi.fn(), list: vi.fn(() => []),
      sessions: new Map(), activeId: null,
    } as unknown as ControllerDeps['sessionStore'],
    welcomeView: { show: noop, hide: noop, updateStatus: noop } as unknown as ControllerDeps['welcomeView'],
    plugin,
    updateContextMeter: noop,
  };
  const callbacks: ControllerCallbacks = {
    onShowWelcome: noop, onHideWelcome: noop, onShowReconnectBtn: noop, onHideReconnectBtn: noop,
    onShowNewMessagesBtn: noop, onHideNewMessagesBtn: noop, onScrollToBottom: noop, onClearUI: noop,
    onClearChips: noop, onClearPendingImageChips: noop, onAutoRefActiveFile: noop,
  };
  return new CoOberViewController(deps, callbacks);
}

function createPlugin(overrides: {
  client?: ReturnType<typeof createClient> | null;
  initClient?: ReturnType<typeof vi.fn>;
  settings?: Record<string, unknown>;
} = {}): CoOberPlugin {
  const client = overrides.client ?? null;
  return {
    app: {
      vault: { adapter: { getBasePath: () => '/vault' }, getMarkdownFiles: vi.fn(() => []) },
      workspace: {
        getLeavesOfType: vi.fn(() => []),
        getMostRecentLeaf: vi.fn(() => null),
        on: vi.fn(() => ({ unload: vi.fn() })),
      },
    },
    settings: {
      maxNoteSize: 8000,
      syncRules: [],
      mcpServers: [],
      defaultAgent: 'build',
      defaultModel: '',
      defaultEffort: 'default',
      systemPrompt: '',
      customAgents: [],
      customSkills: [],
      activeCustomAgentId: '',
      commonModels: [],
      autoScrollEnabled: true,
      ...(overrides.settings ?? {}),
    },
    sessions: new Map(),
    activeSessionId: null,
    loadPluginData: vi.fn().mockResolvedValue(undefined),
    savePluginData: vi.fn().mockResolvedValue(undefined),
    waitForClient: vi.fn().mockResolvedValue(false),
    initClient: overrides.initClient ?? vi.fn().mockResolvedValue(Boolean(client)),
    getClient: vi.fn(() => client),
  } as unknown as CoOberPlugin;
}

function createClient() {
  return {
    isConnected: vi.fn(() => true),
    getCurrentSessionId: vi.fn(() => undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue('runtime-session'),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    getSessionSnapshot: vi.fn(() => ({
      configOptions: [],
      availableCommands: [],
      availableModels: [],
      availableModes: [],
      currentModelId: null,
      currentModeId: null,
    })),
    getAgentCapabilities: vi.fn(() => null),
    setClientHandlers: vi.fn(),
  };
}

function createEditor(): { replaceSelection: ReturnType<typeof vi.fn> } {
  return { replaceSelection: vi.fn() };
}

import { InlineEditPanel } from './inlineEditPanel';

function setPendingInlineEdit(
  view: CoOberView,
  original: string,
  editor: { replaceSelection: ReturnType<typeof vi.fn> },
): void {
  // The test expects the real panel to run to modify DOM, so we must instantiate it
  // and attach it correctly if it hasn't been instantiated yet (since createView doesn't call onOpen).
  let inlineEditPanel = Reflect.get(view, 'inlineEditPanel') as InlineEditPanel;
  if (!inlineEditPanel) {
    inlineEditPanel = new InlineEditPanel(view.contentEl);
    Reflect.set(view, 'inlineEditPanel', inlineEditPanel);
  }
  inlineEditPanel.pendingState = { original, editor: editor as any };
}

function click(view: CoOberView, selector: string): void {
  const button = view.contentEl.querySelector(selector) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  button?.click();
}

function text(view: CoOberView, selector: string): string | null | undefined {
  return view.contentEl.querySelector(selector)?.textContent;
}

function texts(view: CoOberView, selector: string): string[] {
  return [...view.contentEl.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}
