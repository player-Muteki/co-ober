// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CoOberView } from './CoOberView';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps } from './CoOberViewController';
import { setLocale } from '../i18n/index';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { Notice } from '../test/obsidianMock';
import type CoOberPlugin from '../main';
import { SessionRepository } from '../chat/session';

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

  it('leaves the reconnect button as the entry point when autoConnect is off', async () => {
    setLocale('en');
    const plugin = createPlugin({ settings: { autoConnect: false } });
    const view = createView(plugin);

    await view.onOpen();

    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(view.contentEl.querySelector('.co-ober-reconnect-btn')).not.toBeNull();
  });

  it('names an unresolvable command instead of a doomed auto-connect', async () => {
    setLocale('en');
    Notice.messages.length = 0;
    const plugin = createPlugin({ settings: { opencodePath: '/nonexistent/co-ober-view-xyz' } });
    const view = createView(plugin);

    await view.onOpen();

    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(Notice.messages.some((m) => m.includes('Could not find') && m.includes('co-ober-view-xyz'))).toBe(true);
    expect(view.contentEl.querySelector('.co-ober-reconnect-btn')).not.toBeNull();
  });

  it('notifies and reloads authoritative toolbar state when a model change fails', async () => {
    setLocale('en');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Notice.messages.length = 0;
    const client = createClient();
    client.setModel = vi.fn().mockRejectedValue(new Error('set boom'));
    const plugin = createPlugin({ client });
    const view = createView(plugin);
    await view.onOpen();

    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    controller.state.sessionId = 'runtime-session';
    const reloadSpy = vi.spyOn(controller, 'loadToolbarOptions');

    const toolbar = Reflect.get(view, 'toolbar') as unknown as {
      callbacks: { onModelChange: (model: string) => void };
    };
    toolbar.callbacks.onModelChange('openai/gpt');
    await vi.waitFor(() => expect(reloadSpy).toHaveBeenCalled());

    expect(client.setModel).toHaveBeenCalledWith('runtime-session', 'openai/gpt');
    expect(Notice.messages.some((m) => m.includes('set boom'))).toBe(true);
    errSpy.mockRestore();
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

  it('removes the exact pending part when chips carry byte-identical images', async () => {
    setLocale('en');
    const plugin = createPlugin();
    const view = createView(plugin);
    await view.onOpen();

    // Both files encode to the same base64 payload; only the MIME type differs.
    function MockFileReader(this: any) {
      this.onload = null;
      this.result = null;
      this.readAsDataURL = vi.fn(() => {
        this.result = 'data:image/png;base64,SAME=';
        setTimeout(() => {
          if (this.onload) this.onload({ target: this });
        }, 0);
      });
    }
    vi.spyOn(globalThis, 'FileReader').mockImplementation(MockFileReader as any);

    const dragDropManager = Reflect.get(view, 'dragDropManager') as {
      handleFiles: (files: File[]) => Promise<void>;
    };
    await dragDropManager.handleFiles([new File(['x'], 'a.png', { type: 'image/png' })]);
    await dragDropManager.handleFiles([new File(['x'], 'a.jpg', { type: 'image/jpeg' })]);

    const parts = Reflect.get(view, 'pendingImageParts') as Array<{ part: { mimeType: string } }>;
    expect(parts.map((p) => p.part.mimeType)).toEqual(['image/png', 'image/jpeg']);

    const chips = (Reflect.get(view, 'contextChipsEl') as HTMLElement).querySelectorAll('[data-kind="image"]');
    expect(chips).toHaveLength(2);
    (chips[1] as HTMLElement).click();

    // Object-identity removal drops the jpeg part; a data-keyed lookup would
    // have removed the first byte-identical (png) part instead.
    expect(parts.map((p) => p.part.mimeType)).toEqual(['image/png']);
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
      settings: { maxNoteSize: 8000, syncRules: [], mcpServers },
      getClient: () => client,
      getVaultCwd: () => '/vault',
    } as unknown as CoOberPlugin;

    const controller = createController(plugin);
    await controller.syncRuntimeSession('restored-session');

    expect(client.loadSession).toHaveBeenCalledWith('restored-session', '/vault', mcpServers, undefined);
  });
});

describe('CoOberView cleanup', () => {
  it('closes safely before the view finishes opening', async () => {
    const view = createView();

    await expect(view.onClose()).resolves.toBeUndefined();
  });
});

describe('CoOberView icon button a11y', () => {
  it('names the header and jump-to-latest buttons accessibly, in the active locale', async () => {
    setLocale('en');
    const view = createView(createPlugin());
    await view.onOpen();

    const [newBtn, historyBtn] = [...view.contentEl.querySelectorAll('.co-ober-header-actions button')] as HTMLButtonElement[];
    expect(newBtn.getAttribute('aria-label')).toBe('New session');
    expect(newBtn.title).toBe('New session');
    expect(historyBtn.getAttribute('aria-label')).toBe('Session history');
    expect(historyBtn.title).toBe('Session history');

    (Reflect.get(view, 'showNewMessagesBtn') as () => void).call(view);
    const jumpBtn = view.contentEl.querySelector('.co-ober-new-messages-btn') as HTMLButtonElement;
    expect(jumpBtn.getAttribute('aria-label')).toBe('Jump to latest message');

    setLocale('zh');
    view.refreshLocale();
    expect(newBtn.getAttribute('aria-label')).toBe('新建会话');
    expect(historyBtn.getAttribute('aria-label')).toBe('会话历史');
    expect(jumpBtn.getAttribute('aria-label')).toBe('跳转到最新消息');
    setLocale('en');
  });
});

describe('CoOberView new-messages button revival', () => {
  it('recreates the jump button after it was detached together with the transcript', async () => {
    setLocale('en');
    const view = createView(createPlugin());
    await view.onOpen();
    const show = () => (Reflect.get(view, 'showNewMessagesBtn') as () => void).call(view);

    show();
    const first = view.contentEl.querySelector('.co-ober-new-messages-btn');
    expect(first).not.toBeNull();

    // renderer.clear() empties the message host, taking the button with it;
    // the stale field must not suppress the button forever after that.
    (Reflect.get(view, 'messagesEl') as HTMLElement).empty();
    show();
    const second = view.contentEl.querySelector('.co-ober-new-messages-btn');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe('CoOberView tab panels', () => {
  function panelEls(view: CoOberView): HTMLElement[] {
    return [...view.contentEl.querySelectorAll('.co-ober-tab-panel')] as HTMLElement[];
  }

  function callPrivate<T>(target: object, name: string, ...args: unknown[]): T {
    const fn = Reflect.get(target, name) as (...a: unknown[]) => T;
    return fn.apply(target, args);
  }

  async function openView(plugin = createPlugin()): Promise<CoOberView> {
    setLocale('en');
    const view = createView(plugin);
    await view.onOpen();
    return view;
  }

  function activeTabId(view: CoOberView): string {
    return (Reflect.get(view, 'controller') as CoOberViewController).activeTabId();
  }

  it('opens exactly one visible panel for the initial tab', async () => {
    const view = await openView();
    const controller = Reflect.get(view, 'controller') as CoOberViewController;

    const panels = panelEls(view);
    expect(panels.length).toBe(1);
    expect(panels[0].classList.contains('co-ober-tab-panel-hidden')).toBe(false);
    expect(Reflect.get(view, 'messagesEl')).toBe(panels[0]);
    expect(controller.listTabIds().length).toBe(1);
  });

  it('creates background panels hidden until activation, each with its own renderer', async () => {
    const view = await openView();
    const tabA = activeTabId(view);
    const firstEl = panelEls(view)[0];
    const firstRenderer = Reflect.get(view, 'renderer');

    const second = callPrivate<{ renderer: unknown }>(view, 'createTabPanel', 'tab-b');
    const panels = panelEls(view);
    expect(panels.length).toBe(2);
    expect(panels[1].classList.contains('co-ober-tab-panel-hidden')).toBe(true);
    expect(second.renderer).not.toBe(firstRenderer);
    // Creating a background tab must not steal the active aliases.
    expect(Reflect.get(view, 'messagesEl')).toBe(firstEl);
    expect(Reflect.get(view, 'renderer')).toBe(firstRenderer);

    callPrivate<void>(view, 'onActiveTabChanged', tabA, 'tab-b');
    expect(firstEl.classList.contains('co-ober-tab-panel-hidden')).toBe(true);
    expect(panels[1].classList.contains('co-ober-tab-panel-hidden')).toBe(false);
    expect(Reflect.get(view, 'messagesEl')).toBe(panels[1]);
    expect(Reflect.get(view, 'renderer')).toBe(second.renderer);
  });

  it('moves the welcome card to the newly active panel', async () => {
    const view = await openView();
    const tabA = activeTabId(view);
    const [firstEl] = panelEls(view);
    expect(firstEl.querySelector('.co-ober-welcome')).not.toBeNull();

    callPrivate(view, 'createTabPanel', 'tab-b');
    callPrivate(view, 'onActiveTabChanged', tabA, 'tab-b');

    const secondEl = panelEls(view)[1];
    expect(secondEl.querySelector('.co-ober-welcome')).not.toBeNull();
    expect(firstEl.querySelector('.co-ober-welcome')).toBeNull();
  });

  it('keeps the welcome card off a panel that already has transcript content', async () => {
    const view = await openView();
    const tabA = activeTabId(view);
    const renderer = Reflect.get(view, 'renderer') as { addUserMessage: (text: string) => void };
    renderer.addUserMessage('already talking');

    callPrivate(view, 'createTabPanel', 'tab-b');
    callPrivate(view, 'onActiveTabChanged', tabA, 'tab-b');
    const [firstEl, secondEl] = panelEls(view);
    expect(secondEl.querySelector('.co-ober-welcome')).not.toBeNull();

    // Returning to the populated panel leaves the transcript, no welcome.
    callPrivate(view, 'onActiveTabChanged', 'tab-b', tabA);
    expect(firstEl.querySelector('.co-ober-welcome')).toBeNull();
    expect(firstEl.textContent).toContain('already talking');
  });

  it('saves and restores the composer text and note chips per tab', async () => {
    const view = await openView();
    const tabA = activeTabId(view);
    const input = Reflect.get(view, 'input') as { textareaEl: HTMLTextAreaElement };

    input.textareaEl.value = 'draft for A';
    callPrivate(view, 'addChip', { id: 'note-a.md', type: 'note', name: 'note-a', path: 'note-a.md' }, 'manual');
    expect(view.contentEl.querySelectorAll('.co-ober-chip[data-ref-id]').length).toBe(1);

    callPrivate(view, 'createTabPanel', 'tab-b');
    callPrivate(view, 'onActiveTabChanged', tabA, 'tab-b');
    expect(input.textareaEl.value).toBe('');
    expect(view.contentEl.querySelectorAll('.co-ober-chip[data-ref-id]').length).toBe(0);

    input.textareaEl.value = 'draft for B';
    callPrivate(view, 'onActiveTabChanged', 'tab-b', tabA);
    expect(input.textareaEl.value).toBe('draft for A');
    const chips = view.contentEl.querySelectorAll('.co-ober-chip[data-ref-id]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('note-a');

    callPrivate(view, 'onActiveTabChanged', tabA, 'tab-b');
    expect(input.textareaEl.value).toBe('draft for B');
  });

  it('drops the panel element, jump button and draft when the tab is disposed', async () => {
    const view = await openView();
    const tabA = activeTabId(view);
    const input = Reflect.get(view, 'input') as { textareaEl: HTMLTextAreaElement };
    callPrivate(view, 'createTabPanel', 'tab-b');
    callPrivate(view, 'onActiveTabChanged', tabA, 'tab-b');
    input.textareaEl.value = 'lost with the tab';
    callPrivate(view, 'showNewMessagesBtn', 'tab-b');
    const secondEl = panelEls(view)[1];

    callPrivate(view, 'disposeTabPanel', 'tab-b');
    expect(panelEls(view).length).toBe(1);
    expect(secondEl.isConnected).toBe(false);
    expect((Reflect.get(view, 'drafts') as Map<string, unknown>).has('tab-b')).toBe(false);
  });

  it('cancels every stream and disposes every panel on close', async () => {
    const view = await openView();
    callPrivate(view, 'createTabPanel', 'tab-b');
    expect(panelEls(view).length).toBe(2);

    await view.onClose();
    expect(panelEls(view).length).toBe(0);
    expect((Reflect.get(view, 'panels') as Map<string, unknown>).size).toBe(0);
  });

  it('opens a second panel when the controller switches into a streaming tab', async () => {
    const client = createClient();
    const view = await openView(createPlugin({ client }));
    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    const tabA = controller.activeTabId();
    // A running turn makes the active tab un-adoptable, so the next session
    // has to land in a fresh tab — driven entirely through the controller.
    (controller.runtimeForTab(tabA) as { busy: boolean }).busy = true;

    await controller.switchSession('ses-b', 'local');

    const panels = panelEls(view);
    expect(panels.length).toBe(2);
    expect(panels[0].classList.contains('co-ober-tab-panel-hidden')).toBe(true);
    expect(panels[1].classList.contains('co-ober-tab-panel-hidden')).toBe(false);
    expect(Reflect.get(view, 'messagesEl')).toBe(panels[1]);
    expect(controller.listTabIds().length).toBe(2);
  });

  it('numbers every open tab in the strip and marks the one in view', async () => {
    const client = createClient();
    const view = await openView(createPlugin({ client }));
    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    expect(texts(view, '.co-ober-tab-number')).toEqual(['1']);

    (controller.runtimeForTab(controller.activeTabId()) as { busy: boolean }).busy = true;
    await controller.switchSession('ses-b', 'local');

    const badges = [...view.contentEl.querySelectorAll('.co-ober-tab-bar [role="tab"]')] as HTMLElement[];
    expect(texts(view, '.co-ober-tab-number')).toEqual(['1', '2']);
    expect(badges.map((b) => b.classList.contains('is-active'))).toEqual([false, true]);
    expect(badges[0].classList.contains('is-streaming')).toBe(true);
    expect(badges[0].querySelector('.co-ober-tab-pulse')).not.toBeNull();
    expect(badges[1].getAttribute('aria-selected')).toBe('true');
  });

  it('switches on a badge click and opens a tab from the plus button', async () => {
    const client = createClient();
    const view = await openView(createPlugin({ client }));
    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    const tabA = controller.activeTabId();
    (controller.runtimeForTab(tabA) as { busy: boolean }).busy = true;
    await controller.switchSession('ses-b', 'local');
    const newSession = vi.spyOn(controller, 'newSession').mockResolvedValue(undefined);

    (view.contentEl.querySelector('.co-ober-tab-bar [role="tab"]') as HTMLElement).click();
    expect(controller.activeTabId()).toBe(tabA);

    click(view, '.co-ober-tab-new');
    expect(newSession).toHaveBeenCalledWith(true);
  });

  it('disables the plus button once the strip holds as many tabs as allowed', async () => {
    const client = createClient();
    const view = await openView(createPlugin({ client, settings: { maxOpenTabs: 2 } }));
    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    expect((view.contentEl.querySelector('.co-ober-tab-new') as HTMLButtonElement).disabled).toBe(false);

    (controller.runtimeForTab(controller.activeTabId()) as { busy: boolean }).busy = true;
    await controller.switchSession('ses-b', 'local');

    const add = view.contentEl.querySelector('.co-ober-tab-new') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute('title')).toContain('2');
  });

  it('rebuilds the saved strip with only the front transcript painted', async () => {
    const plugin = createPlugin({ client: createClient() });
    plugin.sessionStore.hydrate([
      {
        sessionId: 'ses-a', title: 'A', createdAt: 1, updatedAt: 1,
        messages: [{ role: 'user', content: 'front of A', type: 'text', timestamp: 1 }],
      },
      {
        sessionId: 'ses-b', title: 'B', createdAt: 1, updatedAt: 1,
        messages: [{ role: 'user', content: 'hidden B', type: 'text', timestamp: 1 }],
      },
    ], 'ses-a');
    plugin.sessionStore.hydrateTabShell(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-1',
    );

    const view = await openView(plugin);
    const controller = Reflect.get(view, 'controller') as CoOberViewController;
    const panels = panelEls(view);
    expect(panels.length).toBe(2);
    expect(panels[0].textContent).toContain('front of A');
    expect(panels[1].textContent).not.toContain('hidden B');
    expect(texts(view, '.co-ober-tab-number')).toEqual(['1', '2']);

    controller.switchToTab(controller.listTabIds()[1]);
    await vi.waitFor(() => expect(panelEls(view)[1].textContent).toContain('hidden B'));
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
		runtime: plugin,
    updateContextMeter: noop,
  };
  const callbacks: ControllerCallbacks = {
    onShowWelcome: noop, onHideWelcome: noop, onShowReconnectBtn: noop, onHideReconnectBtn: noop,
    onShowNewMessagesBtn: noop, onHideNewMessagesBtn: noop, onScrollToBottom: noop, onClearUI: noop,
    onClearChips: noop, getPendingImageParts: () => [], onClearPendingImageChips: noop, onAutoRefActiveFile: noop,
  };
  return new CoOberViewController(deps, callbacks);
}

function createPlugin(overrides: {
  client?: ReturnType<typeof createClient> | null;
  initClient?: ReturnType<typeof vi.fn>;
  settings?: Record<string, unknown>;
} = {}): CoOberPlugin {
  const client = overrides.client ?? null;
  const plugin = {
    app: {
      vault: {
        adapter: { getBasePath: () => '/vault' },
        getMarkdownFiles: vi.fn(() => []),
        on: vi.fn(() => ({ unload: vi.fn() })),
      },
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
      autoConnect: true,
      // The auto-connect pre-check resolves this before spawning; a binary we
      // know exists keeps every other test on the connect path.
      opencodePath: process.execPath,
      ...(overrides.settings ?? {}),
    },
    loadPluginData: vi.fn().mockResolvedValue(undefined),
    savePluginData: vi.fn().mockResolvedValue(undefined),
    waitForClient: vi.fn().mockResolvedValue(false),
    initClient: overrides.initClient ?? vi.fn().mockResolvedValue(Boolean(client)),
    getClient: vi.fn(() => client),
    getVaultCwd: vi.fn(() => '/vault'),
  } as unknown as CoOberPlugin;
  Object.assign(plugin, {
    sessionStore: new SessionRepository(() => plugin.savePluginData()),
  });
  return plugin;
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
