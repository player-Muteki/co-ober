// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps, TabPanel } from './CoOberViewController';
import type { SessionRuntime } from '../chat/sessionRuntime';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { setLocale } from '../i18n/index';
import { MAX_CONCURRENT_STREAMS } from '../constants';
import { AcpStreamCapacityError } from '../client/AcpErrors';
import type { AcpResponse, NormalizedUpdate } from '../types';

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
      updatePermission: noop,
      setImageAttachEnabled: noop,
    },
    inlineEditPanel: { clearState: noop, pendingState: null, showDiffFromResponse: noop },
    permissionBanner: { dismiss: noop, show: vi.fn(), resolveExternally: vi.fn() },
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
