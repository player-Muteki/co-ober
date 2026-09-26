// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps, TabPanel } from './CoOberViewController';
import type { SessionRuntime } from '../chat/sessionRuntime';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale, t } from '../i18n/index';
import { Notice } from '../test/obsidianMock';
import {
  MAX_CONCURRENT_STREAMS,
  MIN_OPEN_TABS,
  MAX_OPEN_TABS,
  DEFAULT_OPEN_TABS,
} from '../constants';
import { AcpStreamCapacityError } from '../client/AcpErrors';
import { commandRegistry } from '../commands/registry';
import type { AcpResponse, AvailableCommand, NormalizedUpdate, PromptPart, StoredDraft, TabShell } from '../types';

vi.mock('../opencode/NativeSessionReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../opencode/NativeSessionReader')>();
  return {
    ...actual,
    readNativeSessionUsage: vi.fn().mockResolvedValue(undefined),
    readNativeSessionTodos: vi.fn().mockResolvedValue([]),
    readNativeMessageStats: vi.fn().mockResolvedValue([]),
    readNativeToolErrors: vi.fn().mockResolvedValue({}),
    readNativeTurnStats: vi.fn().mockResolvedValue([]),
  };
});

setLocale('en');
installObsidianDomHelpers();

/** Per-tab renderer spy: the assertions care which surface got painted. */
function createTabRenderer() {
  return {
    clear: vi.fn(),
    addUserMessage: vi.fn(),
    addAssistantPlaceholder: vi.fn(),
    removeAssistantPlaceholder: vi.fn(),
    appendText: vi.fn(),
    appendThinking: vi.fn(),
    finalizeCurrentThinking: vi.fn(),
    appendInterruptIndicator: vi.fn(),
    flushTextRender: vi.fn().mockResolvedValue(undefined),
    addError: vi.fn(),
    addSystemMessage: vi.fn(),
    setSystemNote: vi.fn(),
    clearSystemNote: vi.fn(),
    showUsage: vi.fn(),
    forceScrollToBottom: vi.fn(),
    addToolCall: vi.fn(),
    updateToolCall: vi.fn(),
    setPlanEntries: vi.fn(),
    renderStructuredMessage: vi.fn(),
    collapseTurns: vi.fn(),
    setActive: vi.fn(),
    dispose: vi.fn(),
  };
}
type TabRenderer = ReturnType<typeof createTabRenderer>;

interface Harness {
  controller: CoOberViewController;
  deps: ControllerDeps;
  callbacks: ControllerCallbacks;
  renderers: Map<string, TabRenderer>;
  disposedTabs: string[];
  activations: Array<[string | null, string]>;
}

function createHarness(): Harness {
  const noop = vi.fn();
  const renderers = new Map<string, TabRenderer>();
  const disposedTabs: string[] = [];
  const activations: Harness['activations'] = [];
  const deps = {
    input: { setStreaming: noop, focus: noop, appendValue: noop, textareaEl: { value: '' } },
    toolbar: {
      setSending: noop,
      updateAgents: noop,
      updateModels: noop,
      updateEffort: noop,
      updateExtraConfigs: noop,
      updatePermission: noop,
      setImageAttachEnabled: noop,
    },
    inlineEditPanel: { clearState: noop, pendingState: null, showDiffFromResponse: noop },
    permissionBanner: { dismiss: noop, show: vi.fn(), showElicitation: vi.fn(), resolveExternally: vi.fn() },
    mention: { clear: noop, listAllNotes: vi.fn(() => []), addRef: noop, hasRef: vi.fn(() => false), removeRef: noop },
    resolver: { resolveNote: vi.fn() },
    syncEngine: { process: vi.fn() },
    sessionStore: {
      get: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }),
      getOrCreate: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }),
      setActive: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(),
      list: vi.fn(() => []),
      append: vi.fn(),
      rename: vi.fn(() => true),
      setTabShell: vi.fn(),
      tabShell: vi.fn(() => ({ openTabs: [], activeTabId: null })),
      sessions: new Map(),
      activeId: null,
    },
    welcomeView: { show: noop, hide: noop, updateStatus: noop, reparent: noop },
    runtime: {
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
        defaultNoteFolder: '',
      },
      getClient: vi.fn(() => null),
      initClient: vi.fn().mockResolvedValue(false),
      getVaultCwd: vi.fn(() => '/vault'),
      createNote: vi.fn().mockResolvedValue(undefined),
    },
    updateContextMeter: noop,
    createTabPanel: (tabId: string): TabPanel => {
      const renderer = createTabRenderer();
      renderers.set(tabId, renderer);
      return { renderer: renderer as unknown as TabPanel['renderer'] };
    },
    disposeTabPanel: (tabId: string) => {
      disposedTabs.push(tabId);
    },
    onActiveTabChanged: (prevTabId: string | null, tabId: string) => {
      activations.push([prevTabId, tabId]);
    },
  } as unknown as ControllerDeps;

  const callbacks = {
    onShowWelcome: vi.fn(),
    onHideWelcome: vi.fn(),
    onShowReconnectBtn: vi.fn(),
    onHideReconnectBtn: vi.fn(),
    onShowNewMessagesBtn: vi.fn(),
    onHideNewMessagesBtn: vi.fn(),
    onScrollToBottom: vi.fn(),
    onClearUI: vi.fn(),
    onClearChips: vi.fn(),
    getPendingImageParts: () => [],
    onClearPendingImageChips: vi.fn(),
    onAutoRefActiveFile: vi.fn(),
    onOpenSideChat: vi.fn(),
    onCloseSideChat: vi.fn(),
    onTabsChanged: vi.fn(),
  } as unknown as ControllerCallbacks;

  const controller = new CoOberViewController(deps, callbacks);
  return { controller, deps, callbacks, renderers, disposedTabs, activations };
}

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    isConnected: vi.fn(() => true),
    getCurrentSessionId: vi.fn(() => undefined),
    loadSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue('new-session'),
    setMode: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue('forked-session'),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    activeStreamCount: vi.fn(() => 0),
    isSessionLoaded: vi.fn(() => true),
    getSessionSnapshotFor: vi.fn(() => ({
      configOptions: [],
      availableCommands: [],
      availableModels: [],
      availableModes: [],
      currentModelId: null,
      currentModeId: null,
    })),
    getSessionSnapshot: vi.fn(() => ({
      configOptions: [],
      availableCommands: [],
      availableModes: [],
      availableModels: [],
      currentModelId: null,
      currentModeId: null,
    })),
    getAgentCapabilities: vi.fn(() => null),
    getAgentProtocolVersion: vi.fn(() => null as number | null),
    setClientHandlers: vi.fn(),
    permissionMode: 'safe',
    requestPermission: vi.fn(),
    ...overrides,
  };
}

function rtOf(h: Harness, tabId: string): SessionRuntime {
  const rt = h.controller.runtimeForTab(tabId);
  if (!rt) throw new Error(`no runtime for ${tabId}`);
  return rt;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('CoOberViewController — multi-tab runtimes (0.2.0 stage 2)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  it('opens one tab at construction and keeps the single-tab proxies', () => {
    const first = h.controller.activeTabId();
    expect(h.controller.listTabIds()).toEqual([first]);
    expect(h.renderers.has(first)).toBe(true);
    expect(h.controller.state).toBe(rtOf(h, first).state);
    expect(h.activations).toEqual([]);
  });

  describe('tab switching never interrupts generation', () => {
    it('activates an already-open session without cancelling or reloading', async () => {
      const client = createMockClient();
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      // ses-a owns a transcript, so its tab cannot be adopted by a switch.
      (h.deps.sessionStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === 'ses-a'
          ? { sessionId: 'ses-a', messages: [{ role: 'user', content: 'q', type: 'text', timestamp: 1 }], updatedAt: 1 }
          : { messages: [], updatedAt: 0 },
      );
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();

      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      expect(tabB).not.toBe(tabA);
      const loadsBefore = client.loadSession.mock.calls.length;

      await h.controller.switchSession('ses-a');

      expect(h.controller.activeTabId()).toBe(tabA);
      expect(h.controller.getSessionId()).toBe('ses-a');
      expect(client.cancel).not.toHaveBeenCalled();
      expect(client.loadSession.mock.calls.length).toBe(loadsBefore);
      expect(h.activations[h.activations.length - 1]).toEqual([tabB, tabA]);
    });

    it('adopts an idle empty tab instead of stacking tabs', async () => {
      const client = createMockClient();
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const first = h.controller.activeTabId();

      await h.controller.switchSession('ses-a');
      await h.controller.switchSession('ses-b');

      expect(h.controller.listTabIds()).toEqual([first]);
      expect(h.controller.getSessionId()).toBe('ses-b');
    });
  });

  describe('true concurrency', () => {
    it('keeps both turns streaming and routes each tab content to its own renderer', async () => {
      let releaseA: (r: AcpResponse) => void = () => {};
      let releaseB: (r: AcpResponse) => void = () => {};
      const responses = [
        new Promise<AcpResponse>((r) => {
          releaseA = r;
        }),
        new Promise<AcpResponse>((r) => {
          releaseB = r;
        }),
      ];
      const chunkCb: Array<(u: NormalizedUpdate) => void> = [];
      const client = createMockClient({
        sendMessage: vi.fn((_sid: string, _parts: unknown, cb: (u: NormalizedUpdate) => void) => {
          chunkCb.push(cb);
          return responses[chunkCb.length - 1];
        }),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();

      const sendingA = h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      const sendingB = h.controller.send('question B', []);
      await tick();

      // Both streams are in flight at once; the running tab was not cancelled.
      expect(rtOf(h, tabA).busy).toBe(true);
      expect(rtOf(h, tabB).busy).toBe(true);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.cancel).not.toHaveBeenCalled();

      chunkCb[0]({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'm1',
        chunkText: 'from A',
        accumulatedText: 'from A',
      });
      expect(rtOf(h, tabA).renderer.appendText).toHaveBeenCalledWith('from A', 'm1');
      expect(rtOf(h, tabB).renderer.appendText).not.toHaveBeenCalled();

      releaseA({ stopReason: 'end_turn' });
      releaseB({ stopReason: 'end_turn' });
      await Promise.all([sendingA, sendingB]);

      const textA = h.renderers.get(tabA)!.addUserMessage.mock.calls.map((c) => c[0]);
      const textB = h.renderers.get(tabB)!.addUserMessage.mock.calls.map((c) => c[0]);
      expect(textA).toEqual(['question A']);
      expect(textB).toEqual(['question B']);
      expect(rtOf(h, tabA).busy).toBe(false);
      expect(rtOf(h, tabB).busy).toBe(false);
    });

    it('marks a background tab unread when its turn finishes out of sight', async () => {
      let resolveFirst: (r: AcpResponse) => void = () => {};
      const client = createMockClient({
        sendMessage: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<AcpResponse>((r) => {
                resolveFirst = r;
              }),
          )
          .mockResolvedValue({ stopReason: 'end_turn' }),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();

      const sendingA = h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      await h.controller.send('question B', []);
      expect(h.controller.activeTabId()).not.toBe(tabA);

      resolveFirst({ stopReason: 'end_turn' });
      await sendingA;

      expect(rtOf(h, tabA).unread).toBe(true);
      // The active tab never shows the background turn's release on its input.
      expect(rtOf(h, tabA).renderer.collapseTurns).toHaveBeenCalled();
    });
  });

  describe('stream budget', () => {
    it('queues a prompt from an idle tab while the shared budget is full', async () => {
      const client = createMockClient({ activeStreamCount: vi.fn(() => MAX_CONCURRENT_STREAMS) });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());

      await h.controller.send('parked', []);

      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(rt.promptQueue.map((e) => e.text)).toEqual(['parked']);
    });

    it('drains parked queues as soon as a slot frees', async () => {
      const count = { value: MAX_CONCURRENT_STREAMS };
      const client = createMockClient({ activeStreamCount: vi.fn(() => count.value) });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());
      await h.controller.send('parked', []);
      expect(rt.promptQueue).toHaveLength(1);

      count.value = 0;
      (Reflect.get(h.controller, 'tryDrainAnyQueue') as () => void).call(h.controller);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

      expect(rt.promptQueue).toHaveLength(0);
    });

    it('re-queues a drained turn that lost the race for a slot', async () => {
      const count = { value: MAX_CONCURRENT_STREAMS };
      const client = createMockClient({
        activeStreamCount: vi.fn(() => count.value),
        sendMessage: vi.fn().mockImplementation(() => {
          // The client's own counter is authoritative: it stayed full.
          count.value = MAX_CONCURRENT_STREAMS;
          return Promise.reject(new AcpStreamCapacityError(MAX_CONCURRENT_STREAMS));
        }),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());
      await h.controller.send('parked', []);
      expect(client.sendMessage).not.toHaveBeenCalled();

      // A slot looks free, the client still refuses: the head is parked again
      // instead of surfacing as a failed turn.
      count.value = MAX_CONCURRENT_STREAMS - 1;
      (Reflect.get(h.controller, 'tryDrainAnyQueue') as () => void).call(h.controller);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

      expect(rt.promptQueue.map((e) => e.text)).toEqual(['parked']);
      expect(rt.renderer.addError).not.toHaveBeenCalled();
      expect(rt.busy).toBe(false);
    });
  });

  describe('teardown', () => {
    it('handleDisconnect releases every runtime, not just the active one', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => new Promise<AcpResponse>(() => {})),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      void h.controller.send('question B', []);
      await tick();

      h.controller.handleDisconnect();

      for (const tabId of [tabA, tabB]) {
        expect(rtOf(h, tabId).busy).toBe(false);
        expect(rtOf(h, tabId).state.isStreaming).toBe(false);
        expect(rtOf(h, tabId).state.isConnected).toBe(false);
      }
    });

    it('cancelAllStreams cancels each in-flight turn once', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => new Promise<AcpResponse>(() => {})),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      void h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      void h.controller.send('question B', []);
      await tick();

      await h.controller.cancelAllStreams();

      expect(client.cancel.mock.calls.map((c) => c[0]).sort()).toEqual(['ses-a', 'ses-b']);
      for (const tabId of h.controller.listTabIds()) expect(rtOf(h, tabId).busy).toBe(false);
    });

    it('closeTab cancels only that tab and disposes only its panel', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => new Promise<AcpResponse>(() => {})),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      void h.controller.send('question B', []);
      await tick();

      await h.controller.closeTab(tabB);

      expect(client.cancel).toHaveBeenCalledTimes(1);
      expect(client.cancel).toHaveBeenCalledWith('ses-b');
      expect(h.disposedTabs).toEqual([tabB]);
      expect(h.controller.listTabIds()).toEqual([tabA]);
      expect(rtOf(h, tabA).busy).toBe(true);
      expect(h.controller.activeTabId()).toBe(tabA);
    });
  });

  describe('permission requests carry their tab of origin', () => {
    async function openSecondTab(client: ReturnType<typeof createMockClient>) {
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (h.deps.sessionStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === 'ses-a'
          ? { sessionId: 'ses-a', messages: [{ role: 'user', content: 'q', type: 'text', timestamp: 1 }], updatedAt: 1 }
          : { messages: [], updatedAt: 0 },
      );
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      await h.controller.switchSession('ses-b');
      return { tabA, tabB: h.controller.activeTabId() };
    }

    function permissionHandlers(client: ReturnType<typeof createMockClient>) {
      h.controller.bindClientHandlers();
      return (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        onPermissionRequest: (req: unknown) => Promise<string>;
      };
    }

    const request = {
      sessionId: 'ses-a',
      options: [{ optionId: 'reject', kind: 'reject_once' }],
    };

    it('labels a background request and switches to its tab on focus', async () => {
      const client = createMockClient();
      const { tabA, tabB } = await openSecondTab(client);
      const handlers = permissionHandlers(client);

      await handlers.onPermissionRequest(request);

      const show = h.deps.permissionBanner.show as unknown as ReturnType<typeof vi.fn>;
      const origin = show.mock.calls[0][1] as { label: string; onFocus: () => void };
      expect(show.mock.calls[0][0]).toBe(request);
      expect(origin.label).toBe('Request from tab 1 — click to switch');
      origin.onFocus();
      expect(h.controller.activeTabId()).toBe(tabA);
      expect(h.controller.activeTabId()).not.toBe(tabB);
    });

    it('leaves the origin off for the tab the user is already looking at', async () => {
      const client = createMockClient();
      await openSecondTab(client);
      const handlers = permissionHandlers(client);

      await handlers.onPermissionRequest({ ...request, sessionId: 'ses-b' });

      const show = h.deps.permissionBanner.show as unknown as ReturnType<typeof vi.fn>;
      expect(show.mock.calls[0][1]).toBeUndefined();
    });
  });
});

describe('CoOberViewController — tab strip and shells (0.2.0 stage 3)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    Notice.messages.length = 0;
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(createMockClient());
    // Painting runs the full transcript pipeline; these tests assert *when* it
    // happens, so the body is stubbed and the call is what is observed.
    vi.spyOn(h.controller, 'restoreSession').mockResolvedValue(undefined);
  });

  /** Stored transcripts, so badge titles and adoptability are realistic. */
  function withStored(transcripts: Record<string, number>, titles: Record<string, string> = {}) {
    (h.deps.sessionStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (!(id in transcripts)) return undefined;
      return {
        sessionId: id,
        title: titles[id],
        messages: Array.from({ length: transcripts[id] }, (_unused, i) => ({
          role: 'user', content: `q${i}`, type: 'text', timestamp: 1,
        })),
        updatedAt: 1,
      };
    });
  }

  function setCap(max: number | undefined) {
    (h.deps.runtime.settings as { maxOpenTabs?: number }).maxOpenTabs = max;
  }

  it('opens every restored shell as a panel but paints only the one in front', () => {
    withStored({ 'ses-a': 1, 'ses-b': 1 });
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-2',
    );

    expect(h.controller.listTabIds()).toEqual(['tab-1', 'tab-2']);
    expect(h.controller.activeTabId()).toBe('tab-2');
    const paint = h.controller.restoreSession as unknown as ReturnType<typeof vi.fn>;
    expect(paint).toHaveBeenCalledTimes(1);
    expect((paint.mock.calls[0][0] as SessionRuntime).sessionId).toBe('ses-b');
  });

  it('paints a background shell on the first look, and never a second time', () => {
    withStored({ 'ses-a': 1, 'ses-b': 1 });
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-2',
    );
    const paint = h.controller.restoreSession as unknown as ReturnType<typeof vi.fn>;
    expect(paint).toHaveBeenCalledTimes(1);

    h.controller.switchToTab('tab-1');
    expect(paint).toHaveBeenCalledTimes(2);
    expect((paint.mock.calls[1][0] as SessionRuntime).sessionId).toBe('ses-a');

    h.controller.switchToTab('tab-2');
    h.controller.switchToTab('tab-1');
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it('hydrates the front tab once through restoreActiveTab', async () => {
    withStored({ 'ses-a': 1 });
    h.controller.restoreTabShells([{ tabId: 'tab-1', sessionId: 'ses-a' }], 'tab-1');
    const paint = h.controller.restoreSession as unknown as ReturnType<typeof vi.fn>;
    expect(paint).not.toHaveBeenCalled();

    await h.controller.restoreActiveTab();
    await h.controller.restoreActiveTab();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(rtOf(h, 'tab-1').needsRestore).toBe(false);
  });

  it('tells the user why a pruned conversation left an empty tab', async () => {
    withStored({});
    h.controller.restoreTabShells([{ tabId: 'tab-1', sessionId: 'ses-gone' }], 'tab-1');
    await h.controller.restoreActiveTab();

    expect(h.renderers.get('tab-1')?.addSystemMessage).toHaveBeenCalledWith(t().tabs.dangling);
    expect(h.controller.restoreSession as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('records which conversation sits in which tab, and re-records on close', async () => {
    withStored({ 'ses-a': 1, 'ses-b': 1 });
    const setTabShell = h.deps.sessionStore.setTabShell as unknown as ReturnType<typeof vi.fn>;
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-1',
    );

    expect(setTabShell).toHaveBeenLastCalledWith(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-1',
    );

    await h.controller.closeTab('tab-2');
    expect(setTabShell).toHaveBeenLastCalledWith([{ tabId: 'tab-1', sessionId: 'ses-a' }], 'tab-1');
  });

  it('labels each badge with its conversation and current activity', () => {
    withStored({ 'ses-a': 1, 'ses-b': 1 }, { 'ses-a': 'Note A' });
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-2',
    );
    rtOf(h, 'tab-1').busy = true;
    rtOf(h, 'tab-1').unread = true;
    rtOf(h, 'tab-2').promptQueue.push({ text: 'next', refs: [] });

    const badges = h.controller.tabDescriptors();
    expect(badges.map((b) => b.title)).toEqual(['Note A', t().tabs.untitled]);
    expect(badges.map((b) => b.streaming)).toEqual([true, false]);
    expect(badges.map((b) => b.unread)).toEqual([true, false]);
    expect(badges.map((b) => b.queued)).toEqual([false, true]);
    expect(badges.map((b) => b.active)).toEqual([false, true]);
    expect(badges.map((b) => b.index)).toEqual([0, 1]);
  });

  it('clears the unread mark as soon as the tab comes forward', () => {
    withStored({ 'ses-a': 1, 'ses-b': 1 });
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-2',
    );
    rtOf(h, 'tab-1').unread = true;

    h.controller.switchToTab('tab-1');

    expect(rtOf(h, 'tab-1').unread).toBe(false);
    expect(h.controller.tabDescriptors()[0].unread).toBe(false);
  });

  it('keeps an out-of-range tab cap usable', () => {
    setCap(99);
    expect(h.controller.maxOpenTabs()).toBe(MAX_OPEN_TABS);
    setCap(0);
    expect(h.controller.maxOpenTabs()).toBe(MIN_OPEN_TABS);
    setCap(undefined);
    expect(h.controller.maxOpenTabs()).toBe(DEFAULT_OPEN_TABS);
    expect(h.controller.canOpenTab()).toBe(true);
  });

  describe('a full strip refuses to add a tab, and says so', () => {
    let client: ReturnType<typeof createMockClient>;

    beforeEach(() => {
      setCap(2);
      withStored({ 'ses-a': 1, 'ses-b': 1 });
      client = createMockClient();
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.restoreTabShells(
        [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
        'tab-2',
      );
      client.createSession.mockClear();
      client.loadSession.mockClear();
      client.forkSession.mockClear();
      client.resumeSession.mockClear();
    });

    const limitNotice = t().tabs.limitReached.replace('{max}', '2');

    it('blocks the strip\'s "+" button', async () => {
      await h.controller.newSession(true);
      expect(h.controller.listTabIds()).toHaveLength(2);
      expect(client.createSession).not.toHaveBeenCalled();
      expect(Notice.messages).toContain(limitNotice);
    });

    it('blocks a session switch that would need a new tab', async () => {
      await h.controller.switchSession('ses-c');
      expect(h.controller.listTabIds()).toHaveLength(2);
      expect(client.loadSession).not.toHaveBeenCalled();
      expect(Notice.messages).toContain(limitNotice);
    });

    it('blocks a fork rather than replacing what is on screen', async () => {
      await h.controller.forkSession('ses-a');
      expect(client.forkSession).not.toHaveBeenCalled();
      expect(Notice.messages).toContain(limitNotice);
    });

    it('blocks a resumed session that has no tab yet', async () => {
      await h.controller.resumeSession('ses-c');
      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(Notice.messages).toContain(limitNotice);
    });

    it('still lets /new reuse an idle tab, and a freed slot opens one', async () => {
      Notice.messages.length = 0;
      withStored({ 'ses-a': 1, 'ses-b': 0 });
      await h.controller.newSession();
      expect(client.createSession).toHaveBeenCalledTimes(1);
      expect(h.controller.listTabIds()).toHaveLength(2);
      expect(Notice.messages).not.toContain(limitNotice);

      await h.controller.closeTab('tab-1');
      expect(h.controller.canOpenTab()).toBe(true);
    });
  });

  it('refreshes the strip when a turn claims and when it releases a slot', async () => {
    withStored({ 'ses-a': 1 });
    h.controller.state.sessionId = 'ses-a';
    let finish: (r: AcpResponse) => void = () => {};
    const client = createMockClient({
      sendMessage: vi.fn(() => new Promise<AcpResponse>((resolve) => { finish = resolve; })),
    });
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    const onTabsChanged = vi.fn();
    h.callbacks.onTabsChanged = onTabsChanged;

    const running = h.controller.send('hi', []);
    await tick();
    expect(rtOf(h, h.controller.activeTabId()).busy).toBe(true);
    expect(onTabsChanged.mock.calls.length).toBeGreaterThan(0);
    const afterStart = onTabsChanged.mock.calls.length;

    finish({ stopReason: 'end_turn' } as AcpResponse);
    await running;
    expect(onTabsChanged.mock.calls.length).toBeGreaterThan(afterStart);
  });
});

describe('CoOberViewController — one tab’s teardown stays inside that tab (0.2.1 stage 2)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    commandRegistry.updateAcpCommands([]);
    Notice.messages.length = 0;
  });

  /** A client whose turns never finish, so a tab stays busy on demand. */
  function hangingClient(): ReturnType<typeof createMockClient> {
    const client = createMockClient({
      sendMessage: vi.fn().mockImplementation(() => new Promise<AcpResponse>(() => {})),
    });
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    return client;
  }

  describe('/clear', () => {
    it('hands its own tab to the one reset path the restore uses', async () => {
      const chunkCb: Array<(u: NormalizedUpdate) => void> = [];
      const client = createMockClient({
        sendMessage: vi.fn((_sid: string, _parts: unknown, cb: (u: NormalizedUpdate) => void) => {
          chunkCb.push(cb);
          return new Promise<AcpResponse>(() => {});
        }),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());
      const reset = vi.spyOn(rt.streamCtrl, 'reset');
      void h.controller.send('question A', []);
      await tick();
      await h.controller.send('follow-up', []);
      expect(rt.promptQueue.map((e) => e.text)).toEqual(['follow-up']);
      rt.painted = true;
      rt.needsRestore = true;

      await commandRegistry.find('clear')!.run('');

      expect(reset).toHaveBeenCalledTimes(1);
      expect(rt.promptQueue).toHaveLength(0);
      expect(Notice.messages).toContain(t().queue.dropped.replace('{count}', '1'));
      expect(rt.painted).toBe(false);
      expect(rt.needsRestore).toBe(false);
      expect(rt.busy).toBe(false);
      expect(rt.renderer.clear).toHaveBeenCalledTimes(1);
      // Clearing the transcript is not leaving the session.
      expect(rt.state.sessionId).toBe('ses-a');
      expect(h.callbacks.onShowWelcome).toHaveBeenCalledWith(true);

      // The turn still in flight belongs to a dead generation: its frames must
      // not repaint the cleared panel.
      chunkCb[0]({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'm1',
        chunkText: 'ghost',
        accumulatedText: 'ghost',
      });
      expect(rt.renderer.appendText).not.toHaveBeenCalled();
    });

    it('takes down only the tab in view', async () => {
      hangingClient();
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      void h.controller.send('question B', []);
      await tick();
      await h.controller.switchSession('ses-a');

      await commandRegistry.find('clear')!.run('');

      expect(rtOf(h, tabA).busy).toBe(false);
      expect(rtOf(h, tabB).busy).toBe(true);
      expect(rtOf(h, tabB).renderer.clear).not.toHaveBeenCalled();
      expect(rtOf(h, tabB).state.sessionId).toBe('ses-b');
    });
  });

  describe('closeTab', () => {
    async function openBusyTabWithQueue(bgSession: string) {
      hangingClient();
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.send('queued on A', []);
      await h.controller.switchSession(bgSession);
      const tabB = h.controller.activeTabId();
      void h.controller.send('question B', []);
      await tick();
      await h.controller.send('queued on B', []);
      return { tabA, tabB };
    }

    it('announces the prompts it throws away', async () => {
      const { tabA, tabB } = await openBusyTabWithQueue('ses-b');
      Notice.messages.length = 0;

      await h.controller.closeTab(tabB);

      expect(Notice.messages).toContain(t().queue.dropped.replace('{count}', '1'));
      // The surviving tab keeps its own waiting turns.
      expect(rtOf(h, tabA).promptQueue.map((e) => e.text)).toEqual(['queued on A']);
    });

    it('stays quiet when the closed tab had nothing waiting', async () => {
      const client = hangingClient();
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      Notice.messages.length = 0;

      await h.controller.closeTab(tabB);

      expect(Notice.messages).not.toContain(t().queue.dropped.replace('{count}', '1'));
      // An idle tab is torn down without touching the turn still running elsewhere.
      expect(client.cancel).not.toHaveBeenCalled();
      expect(rtOf(h, tabA).busy).toBe(true);
    });
  });

  describe('a contested stream slot', () => {
    it('parks a send that lost the race, with its bubble and images committed', async () => {
      const count = { value: MAX_CONCURRENT_STREAMS - 1 };
      const images: PromptPart[] = [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }];
      const sendMessage = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
      sendMessage.mockImplementationOnce(() => {
        // The other tab claimed the last slot between the pre-check and here.
        count.value = MAX_CONCURRENT_STREAMS;
        return Promise.reject(new AcpStreamCapacityError(MAX_CONCURRENT_STREAMS));
      });
      const client = createMockClient({ activeStreamCount: vi.fn(() => count.value), sendMessage });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.callbacks.getPendingImageParts = () => images;
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());

      await h.controller.send('contested', []);

      expect(rt.promptQueue).toHaveLength(1);
      expect(rt.promptQueue[0]).toMatchObject({ text: 'contested', painted: true, images });
      // Already drawn once: re-painting it on the replay would double the bubble.
      expect(rt.renderer.addUserMessage).toHaveBeenCalledTimes(1);
      expect(rt.renderer.addError).not.toHaveBeenCalled();
      expect(rt.busy).toBe(false);

      count.value = MAX_CONCURRENT_STREAMS - 1;
      (Reflect.get(h.controller, 'tryDrainAnyQueue') as () => void).call(h.controller);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

      expect(rt.promptQueue).toHaveLength(0);
      expect(rt.renderer.addUserMessage).toHaveBeenCalledTimes(1);
      expect(rt.renderer.addError).not.toHaveBeenCalled();
      // The parked turn replays the image it carried, not the live composer.
      const replayedParts = sendMessage.mock.calls[1][1] as PromptPart[];
      expect(replayedParts).toContainEqual(images[0]);
    });

    it('keeps a turn a tool path queued on the error lane', async () => {
      const client = createMockClient({
        activeStreamCount: vi.fn(() => MAX_CONCURRENT_STREAMS - 1),
        sendMessage: vi.fn().mockRejectedValue(new AcpStreamCapacityError(MAX_CONCURRENT_STREAMS)),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());

      // sendTextToAgent turns must not re-enter send()'s slash parser, so they
      // keep reporting instead of queueing.
      await (Reflect.get(h.controller, 'sendTextToAgent') as (t: string) => Promise<void>).call(
        h.controller,
        '/compact',
      );

      expect(rt.promptQueue).toHaveLength(0);
      expect(rt.renderer.addError).toHaveBeenCalledTimes(1);
    });

    it('drains a painted head and an unpainted tail as two turns', async () => {
      const sendMessage = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
      const client = createMockClient({ sendMessage });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const rt = rtOf(h, h.controller.activeTabId());
      rt.promptQueue.push({ text: 'already on screen', refs: [], painted: true });
      rt.promptQueue.push({ text: 'still in the composer', refs: [] });

      (Reflect.get(h.controller, 'tryDrainAnyQueue') as () => void).call(h.controller);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

      const painted = h.renderers.get(h.controller.activeTabId())!.addUserMessage.mock.calls.map((c) => c[0]);
      expect(painted).toEqual(['still in the composer']);
      const sentTexts = sendMessage.mock.calls.map((c) =>
        (c[1] as PromptPart[]).map((p) => p.text ?? '').join('\n'),
      );
      expect(sentTexts[0]).toContain('already on screen');
      expect(sentTexts[0]).not.toContain('still in the composer');
      expect(sentTexts[1]).toContain('still in the composer');
    });
  });
});

describe('CoOberViewController — the slash menu speaks for the tab in view (0.2.1 stage 3)', () => {
  let h: Harness;
  const cmdA: AvailableCommand[] = [{ name: 'cmdA', description: 'from A' }];
  const cmdB: AvailableCommand[] = [{ name: 'cmdB', description: 'from B' }];
  let chunkCb: Record<string, (u: NormalizedUpdate) => void>;

  beforeEach(() => {
    h = createHarness();
    chunkCb = {};
    const client = createMockClient({
      sendMessage: vi.fn((sid: string, _parts: unknown, cb: (u: NormalizedUpdate) => void) => {
        chunkCb[sid] = cb;
        return new Promise<AcpResponse>(() => {});
      }),
      getSessionSnapshotFor: vi.fn((sid: string) => ({
        configOptions: [],
        availableCommands: sid === 'ses-a' ? cmdA : sid === 'ses-b' ? cmdB : [],
        availableModels: [],
        availableModes: [],
        currentModelId: null,
        currentModeId: null,
      })),
    });
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    (h.deps.sessionStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'ses-a'
        ? { sessionId: 'ses-a', messages: [{ role: 'user', content: 'q', type: 'text', timestamp: 1 }], updatedAt: 1 }
        : { messages: [], updatedAt: 0 },
    );
    commandRegistry.updateAcpCommands([]);
  });

  afterEach(() => {
    commandRegistry.updateAcpCommands([]);
  });

  async function startTurn(sessionId: string) {
    h.controller.state.sessionId = sessionId;
    void h.controller.send(`question ${sessionId}`, []);
    await tick();
    expect(rtOf(h, h.controller.activeTabId()).busy).toBe(true);
  }

  it('does not let a background tab rewrite the command list', async () => {
    await startTurn('ses-a');
    chunkCb['ses-a']({ kind: 'commands', commands: cmdA });
    expect(commandRegistry.find('cmdA')).toBeDefined();

    await h.controller.switchSession('ses-b');
    const tabB = h.controller.activeTabId();
    await startTurn('ses-b');
    chunkCb['ses-b']({ kind: 'commands', commands: cmdB });
    expect(commandRegistry.find('cmdB')).toBeDefined();

    // Tab A comes forward: its own list is projected, tab B's is not.
    await h.controller.switchSession('ses-a');
    expect(commandRegistry.find('cmdA')).toBeDefined();
    expect(commandRegistry.find('cmdB')).toBeUndefined();

    // And a late report from the now-background tab must not overwrite it.
    chunkCb['ses-b']({ kind: 'commands', commands: cmdB });
    expect(commandRegistry.find('cmdB')).toBeUndefined();
    expect(commandRegistry.find('cmdA')).toBeDefined();
    // The background tab did not lose its own list either.
    expect(rtOf(h, tabB).state.availableCommands).toEqual(cmdB);

    await h.controller.switchSession('ses-b');
    expect(commandRegistry.find('cmdB')).toBeDefined();
    expect(commandRegistry.find('cmdA')).toBeUndefined();
  });

  it('projects an empty list for a tab whose session reports no commands', async () => {
    await startTurn('ses-a');
    chunkCb['ses-a']({ kind: 'commands', commands: cmdA });
    expect(commandRegistry.find('cmdA')).toBeDefined();

    // A brand-new tab has no session to ask, so the menu must not keep the
    // previous tab's commands.
    await h.controller.newSession(true);
    expect(commandRegistry.find('cmdA')).toBeUndefined();
  });
});

describe('CoOberViewController — a thread and a command belong to one tab (0.2.2 stage 1)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    commandRegistry.updateAcpCommands([]);
    Notice.messages.length = 0;
  });

  /** A client that can fork and close, so /btw has somewhere to go. */
  function forkClient(overrides: Record<string, unknown> = {}) {
    const client = createMockClient({
      getAgentCapabilities: vi.fn(() => ({ sessionCapabilities: { fork: true, close: true } })),
      ...overrides,
    });
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    return client;
  }

  /** Tab A kept on its own session, tab B freshly created and on screen. */
  async function tabBehindTheFrontOne(client: ReturnType<typeof createMockClient>) {
    (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    h.controller.state.sessionId = 'ses-a';
    const tabA = h.controller.activeTabId();
    await h.controller.newSession(true);
    const tabB = h.controller.activeTabId();
    expect(tabB).not.toBe(tabA);
    return { tabA, tabB };
  }

  describe('the /btw thread', () => {
    it('is forked from the conversation that asked, not the one on screen', async () => {
      const client = forkClient({
        forkSession: vi.fn().mockResolvedValueOnce('fork-a').mockResolvedValueOnce('fork-b'),
      });
      const { tabA, tabB } = await tabBehindTheFrontOne(client);

      await h.controller.startSideChat('from the background tab', rtOf(h, tabA));

      expect(client.forkSession).toHaveBeenCalledWith('ses-a', '/vault');
      const calls = (h.callbacks.onOpenSideChat as ReturnType<typeof vi.fn>).mock.calls as Array<
        [unknown, string, string]
      >;
      // The panel is opened for the asking tab, so two tabs get two threads.
      expect(calls[calls.length - 1][1]).toBe('from the background tab');
      expect(calls[calls.length - 1][2]).toBe(tabA);
      expect(rtOf(h, tabB).sideChatSessionId).toBeNull();
    });

    it('survives a tab switch, because switching is not closing', async () => {
      const client = forkClient();
      const { tabA, tabB } = await tabBehindTheFrontOne(client);
      await h.controller.startSideChat('still thinking', rtOf(h, tabB));

      h.controller.switchToTab(tabA);
      h.controller.switchToTab(tabB);

      expect(rtOf(h, tabB).sideChatSessionId).toBe('forked-session');
      expect(client.closeSession).not.toHaveBeenCalled();
      expect(h.callbacks.onCloseSideChat).not.toHaveBeenCalled();
    });

    it('goes back with the tab that owns it, even from the background', async () => {
      const client = forkClient();
      const { tabA, tabB } = await tabBehindTheFrontOne(client);
      await h.controller.startSideChat('bye then', rtOf(h, tabA));
      client.closeSession.mockClear();

      await h.controller.closeTab(tabA);

      expect(client.closeSession).toHaveBeenCalledWith('forked-session');
      expect(h.callbacks.onCloseSideChat).toHaveBeenCalledWith(tabA);
      // The strip fell back to the other tab, thread and all.
      expect(h.controller.activeTabId()).toBe(tabB);
      expect(rtOf(h, tabB).sideChatSessionId).toBeNull();
    });

    it('is released by a reset of its own tab and left alone by a reset of another', async () => {
      const client = forkClient({
        forkSession: vi.fn().mockResolvedValueOnce('fork-a').mockResolvedValueOnce('fork-b'),
      });
      const { tabA, tabB } = await tabBehindTheFrontOne(client);
      await h.controller.startSideChat('from A', rtOf(h, tabA));
      await h.controller.startSideChat('from B', rtOf(h, tabB));
      client.closeSession.mockClear();

      await commandRegistry.find('clear')!.run('', { tabId: tabA });

      expect(client.closeSession).toHaveBeenCalledTimes(1);
      expect(client.closeSession).toHaveBeenCalledWith('fork-a');
      expect(rtOf(h, tabB).sideChatSessionId).toBe('fork-b');
    });

    it('is cancelled by its own tab only', async () => {
      const client = forkClient();
      const { tabA, tabB } = await tabBehindTheFrontOne(client);
      await h.controller.startSideChat('from B', rtOf(h, tabB));

      h.controller.abortSideChat(tabA);
      expect(client.cancel).not.toHaveBeenCalled();
      h.controller.abortSideChat(tabB);
      expect(client.cancel).toHaveBeenCalledWith('forked-session');
    });
  });

  describe('builtin commands', () => {
    it('apply to the tab that queued them, once its turn finally releases', async () => {
      let finish: (r: AcpResponse) => void = () => {};
      const client = createMockClient({
        sendMessage: vi.fn(() => new Promise<AcpResponse>((resolve) => { finish = resolve; })),
      });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      h.controller.state.sessionId = 'ses-a';
      const tabA = h.controller.activeTabId();
      void h.controller.send('question A', []);
      await tick();
      await h.controller.send('/model gpt-x', []);
      expect(rtOf(h, tabA).promptQueue.map((e) => e.text)).toEqual(['/model gpt-x']);

      // The reader moves on while the turn is still running.
      await h.controller.switchSession('ses-b');
      const tabB = h.controller.activeTabId();
      finish({ stopReason: 'end_turn' } as AcpResponse);
      await tick();

      expect(client.setModel).toHaveBeenCalledWith('ses-a', 'gpt-x');
      expect(rtOf(h, tabA).renderer.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('gpt-x'));
      expect(rtOf(h, tabB).renderer.addSystemMessage).not.toHaveBeenCalled();
      expect(h.controller.activeTabId()).toBe(tabB);
    });

    it('take over the tab they were typed in instead of the screen', async () => {
      const client = createMockClient({
        createSession: vi.fn().mockResolvedValueOnce('ses-new-1').mockResolvedValueOnce('ses-new-2'),
      });
      const { tabA, tabB } = await tabBehindTheFrontOne(client);
      expect(rtOf(h, tabB).state.sessionId).toBe('ses-new-1');
      const welcomeCalls = (h.callbacks.onShowWelcome as ReturnType<typeof vi.fn>).mock.calls.length;

      await commandRegistry.find('new')!.run('', { tabId: tabA });

      expect(rtOf(h, tabA).state.sessionId).toBe('ses-new-2');
      expect(rtOf(h, tabB).state.sessionId).toBe('ses-new-1');
      // `/new` greets the user with a welcome screen only on the tab it reset;
      // a background reset must not blank the tab in view.
      expect(h.callbacks.onShowWelcome).toHaveBeenCalledTimes(welcomeCalls);
    });

    it('do nothing at all once their tab is gone', async () => {
      const client = forkClient();
      const front = h.controller.activeTabId();

      await commandRegistry.find('model')!.run('gpt-x', { tabId: 'tab-404' });

      expect(client.setModel).not.toHaveBeenCalled();
      expect(rtOf(h, front).renderer.addSystemMessage).not.toHaveBeenCalled();
    });
  });
});

describe('CoOberViewController — what survives a restart (0.2.2 stage 2)', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
    vi.spyOn(h.controller, 'restoreSession').mockResolvedValue(undefined);
  });

  /** The shells the store was last asked to keep, plus the front tab they name. */
  function lastShell(): { shells: TabShell[]; activeTabId: string | null } {
    const call = (h.deps.sessionStore.setTabShell as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    if (!call) throw new Error('setTabShell was never called');
    return { shells: call[0] as TabShell[], activeTabId: call[1] as string | null };
  }

  function twoTabs(draftsFor: (tabA: string, tabB: string) => Record<string, StoredDraft | undefined> = () => ({})) {
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-1',
    );
    const [tabA, tabB] = h.controller.listTabIds();
    h.callbacks.onCollectDrafts = vi.fn(() => draftsFor(tabA, tabB));
    h.controller.persistTabShell();
    return { tabA, tabB, ...lastShell() };
  }

  it('carries each tab\'s unsent message in its own shell', () => {
    const { tabA, tabB, shells } = twoTabs((a) => ({ [a]: { text: 'half-typed' } }));

    expect(shells.find((s) => s.tabId === tabA)!.draft).toEqual({ text: 'half-typed' });
    expect(shells.find((s) => s.tabId === tabB)!.draft).toBeUndefined();
  });

  it('writes no draft field for a tab whose composer was empty', () => {
    const { tabA, shells } = twoTabs();

    expect('draft' in shells.find((s) => s.tabId === tabA)!).toBe(false);
  });

  it('keeps the tab order and front tab that the drafts were typed into', () => {
    const { tabA, tabB, activeTabId, shells } = twoTabs();

    expect(shells.map((s) => s.tabId)).toEqual([tabA, tabB]);
    expect(activeTabId).toBe(tabA);
  });

  it('hands stored drafts back under the live tab ids, not the stored ones', () => {
    const restored = vi.fn();
    h.callbacks.onRestoreDrafts = restored;

    h.controller.restoreTabShells(
      [
        { tabId: 'tab-1', sessionId: 'ses-a', draft: { text: 'first half' } },
        { tabId: 'tab-2', sessionId: 'ses-b', draft: { text: 'second half', images: 2 } },
      ],
      'tab-2',
    );

    const live = h.controller.listTabIds();
    expect(restored).toHaveBeenCalledOnce();
    const [drafts] = restored.mock.calls[0] as [Record<string, StoredDraft>];
    expect(Object.keys(drafts).sort()).toEqual([...live].sort());
    expect(drafts[h.controller.activeTabId()].text).toBe('second half');
  });

  it('says nothing when no stored tab had a draft', () => {
    const restored = vi.fn();
    h.callbacks.onRestoreDrafts = restored;

    h.controller.restoreTabShells([{ tabId: 'tab-1', sessionId: 'ses-a' }], 'tab-1');

    expect(restored).not.toHaveBeenCalled();
  });

  it('marks every open tab once per failing streak when the write does not land', () => {
    h.controller.restoreTabShells(
      [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
      'tab-1',
    );
    const renderers = [...h.renderers.values()];
    expect(renderers.length).toBe(2);
    const before = renderers.map((r) => r.addSystemMessage.mock.calls.length);

    h.controller.reportPersistence(true);
    h.controller.reportPersistence(true);
    for (const [i, r] of renderers.entries()) {
      expect(r.addSystemMessage).toHaveBeenCalledTimes(before[i] + 1);
      expect(r.addSystemMessage).toHaveBeenLastCalledWith(t().session.notSaved);
    }

    // A later good write re-arms the line, so the next failure speaks again.
    h.controller.reportPersistence(false);
    h.controller.reportPersistence(true);
    for (const [i, r] of renderers.entries()) {
      expect(r.addSystemMessage).toHaveBeenCalledTimes(before[i] + 2);
    }
    expect(h.controller.reportPersistence(false)).toBeUndefined();
  });

  describe('protocol drift', () => {
    function twoTabs(): [string, string] {
      h.controller.restoreTabShells(
        [{ tabId: 'tab-1', sessionId: 'ses-a' }, { tabId: 'tab-2', sessionId: 'ses-b' }],
        'tab-1',
      );
      return h.controller.listTabIds() as [string, string];
    }

    it('counts a background tab’s lost frames in that tab alone', () => {
      const [tabA, tabB] = twoTabs();
      h.controller.noteProtocolDrift('ses-b');
      h.controller.noteProtocolDrift('ses-b');

      expect(h.renderers.get(tabA)?.setSystemNote).not.toHaveBeenCalled();
      expect(rtOf(h, tabB).droppedFrames).toBe(2);
      expect(h.renderers.get(tabB)?.setSystemNote).toHaveBeenLastCalledWith('droppedFrames', 'stream.droppedFrames', 2);
    });

    it('gives a side chat’s drops to the tab that forked it', () => {
      const [tabA] = twoTabs();
      rtOf(h, tabA).sideChatSessionId = 'fork-1';
      h.controller.noteProtocolDrift('fork-1');
      expect(h.renderers.get(tabA)?.setSystemNote).toHaveBeenCalledWith('droppedFrames', 'stream.droppedFrames', 1);
    });

    it('blames the tab on screen when a frame names no session', () => {
      const [tabA, tabB] = twoTabs();
      h.controller.noteProtocolDrift(null);
      expect(h.renderers.get(tabA)?.setSystemNote).toHaveBeenCalledTimes(1);
      expect(h.renderers.get(tabB)?.setSystemNote).not.toHaveBeenCalled();
    });

    it('starts the count over when the tab’s transcript is torn down', async () => {
      const client = createMockClient();
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const [tabA] = twoTabs();
      h.controller.noteProtocolDrift('ses-a');
      expect(rtOf(h, tabA).droppedFrames).toBe(1);

      await h.controller.newSession();

      expect(rtOf(h, tabA).droppedFrames).toBe(0);
    });

    it('reaches the tab through the handler the view binds to the client', () => {
      const client = createMockClient();
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const [tabA, tabB] = twoTabs();

      h.controller.bindClientHandlers();
      const handlers = (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        onProtocolDrift: (sessionId: string | null, kind: string) => void;
      };
      handlers.onProtocolDrift('ses-b', 'module_chunk');

      expect(h.renderers.get(tabB)?.setSystemNote).toHaveBeenCalledWith('droppedFrames', 'stream.droppedFrames', 1);
      expect(h.renderers.get(tabA)?.setSystemNote).not.toHaveBeenCalled();
    });

    function clientWithVersion(version: number | null) {
      const client = createMockClient({ getAgentProtocolVersion: vi.fn(() => version) });
      (h.deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      return client;
    }

    it('says the negotiated protocol version in every open tab', () => {
      clientWithVersion(2);
      const [tabA, tabB] = twoTabs();

      h.controller.noteProtocolMismatch();

      for (const tab of [tabA, tabB]) {
        expect(h.renderers.get(tab)?.setSystemNote).toHaveBeenCalledWith(
          'protocolMismatch',
          'stream.protocolMismatch',
          2,
        );
      }
    });

    it('takes the note back out once a later agent speaks the version it implements', () => {
      const client = clientWithVersion(2);
      const [tabA] = twoTabs();
      h.controller.noteProtocolMismatch();

      client.getAgentProtocolVersion.mockReturnValue(1);
      h.controller.noteProtocolMismatch();

      expect(h.renderers.get(tabA)?.clearSystemNote).toHaveBeenCalledWith('protocolMismatch');
    });

    it('leaves the transcripts alone about versions when nothing was negotiated', () => {
      const [tabA] = twoTabs();

      h.controller.noteProtocolMismatch();

      expect(h.renderers.get(tabA)?.setSystemNote).not.toHaveBeenCalled();
    });

    it('retires the version note when the connection goes away', () => {
      const client = clientWithVersion(2);
      const [tabA] = twoTabs();
      h.controller.noteProtocolMismatch();
      client.getAgentProtocolVersion.mockReturnValue(null);

      h.controller.handleDisconnect();

      expect(h.renderers.get(tabA)?.clearSystemNote).toHaveBeenCalledWith('protocolMismatch');
    });
  });
});
