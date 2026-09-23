// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CoOberViewController, deriveSessionTitle, normalizeEffortLabel } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps } from './CoOberViewController';
import { installObsidianDomHelpers } from '../test/domHelpers';
import type {
  AcpResponse,
  ContentBlock,
  ContextRef,
  NormalizedUpdate,
  PromptPart,
  SerializedMessage,
} from '../types';
import { setLocale, t } from '../i18n/index';
import zhLocale from '../i18n/zh';
import { commandRegistry } from '../commands/registry';
import { AcpSessionMissingError, AcpProcessExitError } from '../client/AcpErrors';
import {
  readNativeMessageStats,
  readNativeSessionTodos,
  readNativeSessionUsage,
  readNativeToolErrors,
  readNativeTurnStats,
} from '../opencode/NativeSessionReader';

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMockDeps(overrides: Partial<ControllerDeps> = {}): ControllerDeps {
  const noop = vi.fn();
  return {
    renderer: {
      clear: noop,
      addUserMessage: noop,
      addAssistantPlaceholder: noop,
      removeAssistantPlaceholder: noop,
      appendText: noop,
      appendThinking: noop,
      finalizeCurrentThinking: noop,
      appendInterruptIndicator: noop,
      flushTextRender: vi.fn().mockResolvedValue(undefined),
      addError: noop,
      showUsage: noop,
      forceScrollToBottom: noop,
      addToolCall: noop,
      updateToolCall: noop,
      setPlanEntries: noop,
      collapseTurns: vi.fn(),
      addSystemMessage: vi.fn(),
    } as unknown as ControllerDeps['renderer'],
    input: {
      setStreaming: noop,
      focus: noop,
      appendValue: noop,
      triggerSend: noop,
      triggerStop: noop,
      textareaEl: { value: '', dispatchEvent: vi.fn() },
    } as unknown as ControllerDeps['input'],
    toolbar: {
      setSending: noop,
      updateAgents: noop,
      updateModels: noop,
      updateEffort: noop,
      updatePermission: noop,
    } as unknown as ControllerDeps['toolbar'],
    inlineEditPanel: {
      clearState: noop,
      pendingState: null,
      showDiffFromResponse: noop,
    } as unknown as ControllerDeps['inlineEditPanel'],
    permissionBanner: { dismiss: noop, show: vi.fn() } as unknown as ControllerDeps['permissionBanner'],
    mention: {
      clear: noop,
      listAllNotes: vi.fn(() => []),
      addRef: noop,
      hasRef: vi.fn(() => false),
      removeRef: noop,
    } as unknown as ControllerDeps['mention'],
    resolver: { resolveNote: vi.fn() } as unknown as ControllerDeps['resolver'],
    syncEngine: { process: vi.fn() } as unknown as ControllerDeps['syncEngine'],
    sessionStore: {
      get: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }),
      getOrCreate: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }),
      setActive: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => []),
      append: vi.fn(),
      rename: vi.fn(() => true),
      sessions: new Map(),
      activeId: null,
    } as unknown as ControllerDeps['sessionStore'],
    welcomeView: { show: noop, hide: noop, updateStatus: noop } as unknown as ControllerDeps['welcomeView'],
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
        defaultNoteFolder: 'co-ober-notes',
      },
      getClient: vi.fn(() => null),
      initClient: vi.fn().mockResolvedValue(false),
      getVaultCwd: vi.fn(() => '/vault'),
      createNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as ControllerDeps['runtime'],
    updateContextMeter: noop,
    ...overrides,
  };
}

function createMockCallbacks(): ControllerCallbacks {
  return {
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
  };
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
    sendMessage: vi
      .fn()
      .mockResolvedValue({ stopReason: 'end_turn', usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 } }),
    cancel: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    forkSession: vi.fn().mockResolvedValue('forked-session'),
    resumeSession: vi.fn().mockResolvedValue(undefined),
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
    permissionMode: 'safe',
    requestPermission: vi.fn(),
    ...overrides,
  };
}

describe('CoOberViewController', () => {
  let deps: ControllerDeps;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let controller: CoOberViewController;

  beforeEach(() => {
    deps = createMockDeps();
    callbacks = createMockCallbacks();
    (readNativeSessionUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readNativeSessionTodos as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (readNativeMessageStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (readNativeToolErrors as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (readNativeTurnStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    controller = new CoOberViewController(deps, callbacks);
  });

  describe('initialization', () => {
    it('creates with default state', () => {
      expect(controller.state.sessionId).toBeNull();
      expect(controller.state.isConnected).toBe(false);
      expect(controller.isBusy()).toBe(false);
      expect(controller.getSessionId()).toBeNull();
    });
  });

  describe('ensureClientConnected', () => {
    it('returns true if client already connected', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      const result = await controller.ensureClientConnected();

      expect(result).toBe(true);
      expect(controller.state.isConnected).toBe(true);
      expect(callbacks.onHideReconnectBtn).toHaveBeenCalled();
      expect(deps.welcomeView.updateStatus).toHaveBeenCalledWith(true);
    });

    it('initializes client when not connected', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValueOnce(null).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const result = await controller.ensureClientConnected();

      expect(result).toBe(true);
      expect(deps.runtime.initClient).toHaveBeenCalled();
      expect(controller.state.isConnected).toBe(true);
    });

    it('returns false and shows reconnect on init failure', async () => {
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const result = await controller.ensureClientConnected();

      expect(result).toBe(false);
      expect(controller.state.isConnected).toBe(false);
      expect(callbacks.onShowReconnectBtn).toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('resets state and shows reconnect button', () => {
      controller.state.isConnected = true;
      controller.state.isStreaming = true;

      controller.handleDisconnect();

      expect(controller.state.isConnected).toBe(false);
      expect(controller.state.isStreaming).toBe(false);
      expect(deps.welcomeView.updateStatus).toHaveBeenCalledWith(false);
      expect(callbacks.onShowReconnectBtn).toHaveBeenCalled();
    });
  });

  describe('reconnect', () => {
    it('succeeds and hides reconnect button', async () => {
      const client = createMockClient();
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.reconnect();

      expect(controller.state.isConnected).toBe(true);
      expect(deps.welcomeView.updateStatus).toHaveBeenCalledWith(true);
      expect(callbacks.onHideReconnectBtn).toHaveBeenCalled();
    });

    it('throws on failure', async () => {
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(controller.reconnect()).rejects.toThrow();
    });
  });

  describe('syncRuntimeSession', () => {
    it('does nothing for null session', async () => {
      await controller.syncRuntimeSession(null);
      expect(deps.runtime.getClient).not.toHaveBeenCalled();
    });

    it('loads session when different from current', async () => {
      const client = createMockClient({ getCurrentSessionId: vi.fn(() => 'other') });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.syncRuntimeSession('test-session');

      expect(client.loadSession).toHaveBeenCalledWith('test-session', '/vault', [], undefined);
    });

    it('skips load when session already current', async () => {
      const client = createMockClient({ getCurrentSessionId: vi.fn(() => 'same') });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.syncRuntimeSession('same');

      expect(client.loadSession).not.toHaveBeenCalled();
    });
  });

  describe('client permission handling', () => {
    it('rejects when a non-safe client has no permission callback', async () => {
      const client = createMockClient({ permissionMode: 'plan', requestPermission: undefined });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.bindClientHandlers();
      const handlers = (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const decision = await handlers.onPermissionRequest({
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      } as never);

      expect(decision).toBe('reject');
    });
  });

  describe('reconnect failure handling', () => {
    it('surfaces the failure and drops to the disconnected state', () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.bindClientHandlers();
      const handlers = (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0];
      handlers.onReconnectFailed();

      expect(deps.renderer.addError).toHaveBeenCalledWith(t().error.reconnectFailed);
      expect(controller.state.isConnected).toBe(false);
      expect(callbacks.onShowReconnectBtn).toHaveBeenCalled();
    });
  });

  describe('newSession', () => {
    it('creates session and updates state', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.newSession();

      expect(client.createSession).toHaveBeenCalledWith('/vault', []);
      expect(controller.getSessionId()).toBe('new-session');
      expect(deps.sessionStore.getOrCreate).toHaveBeenCalledWith('new-session');
      expect(deps.sessionStore.setActive).toHaveBeenCalledWith('new-session');
      expect(callbacks.onShowWelcome).toHaveBeenCalled();
      expect(callbacks.onAutoRefActiveFile).toHaveBeenCalled();
    });

    it('does nothing when client fails to connect', async () => {
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await controller.newSession();

      expect(deps.sessionStore.save).toHaveBeenCalled();
    });
  });

  describe('restoreSession', () => {
    it('does nothing without session ID', async () => {
      await controller.restoreSession();
      expect(deps.renderer.addUserMessage).not.toHaveBeenCalled();
    });

    it('renders user and assistant messages', async () => {
      controller.state.sessionId = 'test';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        messages: [
          { role: 'user', content: 'hello', type: 'text', timestamp: 1000 },
          { role: 'assistant', content: 'hi there', type: 'text', timestamp: 2000 },
          { role: 'assistant', content: 'thinking...', type: 'thinking', timestamp: 3000 },
        ],
      });

      await controller.restoreSession();

      expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('hello', 1000, undefined);
      expect(deps.renderer.appendText).toHaveBeenCalledWith(
        'hi there',
        expect.stringContaining('restore-'),
        2000,
        undefined,
        undefined,
      );
      expect(deps.renderer.appendThinking).toHaveBeenCalledWith(
        'thinking...',
        expect.stringContaining('restore-'),
        3000,
      );
    });

    it('routes assistant messages with content blocks to renderStructuredMessage', async () => {
      const renderStructuredMessage = vi.fn();
      deps.renderer = {
        ...deps.renderer,
        renderStructuredMessage,
        appendText: vi.fn(),
      } as unknown as ControllerDeps['renderer'];
      controller.state.sessionId = 'test';
      const structured = {
        role: 'assistant',
        content: 'hi there',
        type: 'text',
        timestamp: 2000,
        contentBlocks: [{ type: 'text', text: 'hi there' }],
      };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({ messages: [structured] });

      await controller.restoreSession();

      expect(renderStructuredMessage).toHaveBeenCalledWith(structured);
      expect(deps.renderer.appendText).not.toHaveBeenCalled();
    });

    it('forwards persisted images when restoring user messages', async () => {
      controller.state.sessionId = 'test';
      const images = [{ mimeType: 'image/png', data: 'AAA=' }];
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        messages: [{ role: 'user', content: 'look', type: 'text', timestamp: 1000, images }],
      });

      await controller.restoreSession();

      expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('look', 1000, images);
    });

    it('attaches native per-message usage by native message id', async () => {
      controller.state.sessionId = 'test';
      const messages: SerializedMessage[] = [
        { role: 'user', content: 'q', type: 'text', timestamp: 1000 },
        { role: 'assistant', content: 'a1', type: 'text', timestamp: 2000, nativeMessageId: 'msg_1' },
        { role: 'assistant', content: 'a2', type: 'text', timestamp: 3000, nativeMessageId: 'msg_2' },
      ];
      const session = { sessionId: 'test', messages };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(session);
      (readNativeMessageStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { messageId: 'msg_2', cost: 0.05, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      ]);

      await controller.restoreSession();

      expect(deps.renderer.appendText).toHaveBeenCalledWith(
        'a2',
        expect.stringContaining('restore-'),
        3000,
        { cost: 0.05, inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        undefined,
      );
      expect(deps.renderer.appendText).toHaveBeenCalledWith('a1', expect.any(String), 2000, undefined, undefined);
      expect(deps.sessionStore.save).toHaveBeenCalled();
    });

    it('attaches native turn stats by message id and forwards them to appendText', async () => {
      controller.state.sessionId = 'test';
      const messages: SerializedMessage[] = [
        { role: 'user', content: 'q', type: 'text', timestamp: 1000 },
        { role: 'assistant', content: 'reasoning', type: 'thinking', timestamp: 1500, nativeMessageId: 'msg_1' },
        { role: 'assistant', content: 'answer', type: 'text', timestamp: 2000, nativeMessageId: 'msg_1' },
      ];
      const session = { sessionId: 'test', messages };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(session);
      (readNativeTurnStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { messageId: 'msg_1', outputTokens: 40, durationMs: 4000 },
      ]);

      await controller.restoreSession();

      expect(messages[1].turnStats).toBeUndefined();
      expect(messages[2].turnStats).toEqual({ outputTokens: 40, durationMs: 4000 });
      expect(deps.renderer.appendText).toHaveBeenCalledWith(
        'answer',
        expect.stringContaining('restore-'),
        2000,
        undefined,
        { outputTokens: 40, durationMs: 4000 },
      );
    });

    it('never guesses turn stats for messages without a native id', async () => {
      controller.state.sessionId = 'test';
      const messages: SerializedMessage[] = [
        { role: 'assistant', content: 'a1', type: 'text', timestamp: 2000 },
      ];
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({ sessionId: 'test', messages });
      (readNativeTurnStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { messageId: 'msg_1', outputTokens: 40, durationMs: 4000 },
      ]);

      await controller.restoreSession();

      expect(messages[0].turnStats).toBeUndefined();
    });

    it('claims each native stat once when thinking and text share a message id', async () => {
      controller.state.sessionId = 'test';
      const messages: SerializedMessage[] = [
        { role: 'assistant', content: 'reasoning', type: 'thinking', timestamp: 1500, nativeMessageId: 'msg_1' },
        { role: 'assistant', content: 'answer', type: 'text', timestamp: 2000, nativeMessageId: 'msg_1' },
      ];
      const session = { sessionId: 'test', messages };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(session);
      (readNativeMessageStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { messageId: 'msg_1', cost: 0.01, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ]);

      await controller.restoreSession();

      const usage = { cost: 0.01, inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      expect(messages[1].usage).toEqual(usage);
      expect(messages[0].usage).toBeUndefined();
    });

    it('matches usage positionally only when legacy counts line up one-to-one', async () => {
      controller.state.sessionId = 'test';
      const session = {
        sessionId: 'test',
        messages: [
          { role: 'assistant', content: 'one', type: 'text', timestamp: 1000 },
          { role: 'assistant', content: 'two', type: 'text', timestamp: 2000 },
        ],
      };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(session);
      (readNativeMessageStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { messageId: 'msg_x', cost: 0.02, inputTokens: 20, outputTokens: 7, totalTokens: 27 },
      ]);

      await controller.restoreSession();

      expect(deps.renderer.appendText).toHaveBeenNthCalledWith(1, 'one', expect.any(String), 1000, undefined, undefined);
      expect(deps.renderer.appendText).toHaveBeenNthCalledWith(2, 'two', expect.any(String), 2000, undefined, undefined);
    });

    it('marks restored tool blocks failed from native tool errors', async () => {
      const renderStructuredMessage = vi.fn();
      deps.renderer = {
        ...deps.renderer,
        renderStructuredMessage,
      } as unknown as ControllerDeps['renderer'];
      controller.state.sessionId = 'test';
      const doneBlock: ContentBlock = {
        type: 'tool_use',
        toolCallId: 'call_1',
        toolTitle: 'Edit note',
        toolStatus: 'completed',
      };
      const hungBlock: ContentBlock = {
        type: 'tool_use',
        toolCallId: 'call_2',
        toolTitle: 'Read note',
        toolStatus: 'in_progress',
      };
      const session = {
        sessionId: 'test',
        messages: [
          { role: 'assistant', content: '', type: 'text', timestamp: 2000, contentBlocks: [doneBlock, hungBlock] },
        ],
      };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue(session);
      (readNativeToolErrors as ReturnType<typeof vi.fn>).mockResolvedValue({ call_1: 'aborted', call_2: 'boom' });

      await controller.restoreSession();

      expect(doneBlock.toolError).toBe('aborted');
      expect(doneBlock.toolStatus).toBe('completed');
      expect(hungBlock.toolError).toBe('boom');
      expect(hungBlock.toolStatus).toBe('failed');
      expect(renderStructuredMessage).toHaveBeenCalledWith(session.messages[0]);
    });

    it('restores the plan panel from native todos', async () => {
      controller.state.sessionId = 'test';
      const setPlanEntries = vi.fn();
      deps.renderer = { ...deps.renderer, setPlanEntries } as unknown as ControllerDeps['renderer'];
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'test',
        messages: [{ role: 'user', content: 'hi', type: 'text', timestamp: 1000 }],
      });
      const todos = [
        { content: 'Read the note', status: 'completed' },
        { content: 'Write the answer', status: 'pending' },
      ];
      (readNativeSessionTodos as ReturnType<typeof vi.fn>).mockResolvedValue(todos);

      await controller.restoreSession();

      expect(readNativeSessionTodos).toHaveBeenCalledWith('test');
      expect(setPlanEntries).toHaveBeenCalledWith(todos);
    });

    it('leaves the plan panel untouched when native todos are empty', async () => {
      controller.state.sessionId = 'test';
      const setPlanEntries = vi.fn();
      deps.renderer = { ...deps.renderer, setPlanEntries } as unknown as ControllerDeps['renderer'];
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'test',
        messages: [{ role: 'user', content: 'hi', type: 'text', timestamp: 1000 }],
      });

      await controller.restoreSession();

      expect(setPlanEntries).not.toHaveBeenCalled();
    });

    it('folds restored turns behind collapse headers', async () => {
      controller.state.sessionId = 'test';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'test',
        messages: [{ role: 'user', content: 'hi', type: 'text', timestamp: 1000 }],
      });

      await controller.restoreSession();

      expect(deps.renderer.collapseTurns).toHaveBeenCalled();
    });
  });

  describe('buildParts', () => {
    it('embeds notes referenced by [[wikilinks]] in the submitted text', async () => {
      (deps.mention.listAllNotes as ReturnType<typeof vi.fn>).mockReturnValue([
        { id: 'areas/alpha.md', type: 'note', name: 'alpha', path: 'areas/alpha.md' },
      ]);
      (deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: 'alpha',
        content: 'Alpha note body.',
      });

      const parts = await controller.buildParts('summarize [[Alpha]] for me', []);

      expect(deps.resolver.resolveNote).toHaveBeenCalledWith('areas/alpha.md');
      expect(parts[0].text).toContain('=== NOTE: [[alpha]] ===');
      expect(parts[0].text).toContain('Alpha note body.');
      expect(parts[parts.length - 1].text).toBe('summarize [[Alpha]] for me');
    });

    it('includes the Obsidian operations guidance in the system section', async () => {
      const parts = await controller.buildParts('plain question', []);
      expect(parts[0].text).toContain('Obsidian Vault Operations');
      expect(parts[0].text).toContain('&amp;');
    });

    it('leaves unresolvable links in the text without embedding anything', async () => {
      (deps.mention.listAllNotes as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const parts = await controller.buildParts('see [[Nowhere Land]]', []);
      expect(deps.resolver.resolveNote).not.toHaveBeenCalled();
      expect(parts[parts.length - 1].text).toBe('see [[Nowhere Land]]');
    });
  });

  describe('send', () => {
    it('reuses existing session for subsequent sends', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('first', []);
      await controller.send('second', []);

      // createSession called once (first send), second reuses it
      expect(client.createSession).toHaveBeenCalledTimes(1);
    });

    it('queues prompt when busy', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      // Manually set busy
      Reflect.set(controller, 'busy', true);

      await controller.send('queued-msg', []);

      const queue = Reflect.get(controller, 'promptQueue') as Array<{ text: string }>;
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toBe('queued-msg');

      // No session operations when queued
      expect(client.createSession).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it('sends message and processes response', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('hello', []);

      expect(callbacks.onHideWelcome).toHaveBeenCalled();
      expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('hello', undefined, undefined);
      expect(deps.renderer.addAssistantPlaceholder).toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalled();
      expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
      expect(controller.isBusy()).toBe(false);
    });

    it('resyncs the plan panel when a turn completes', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const setPlanEntries = vi.fn();
      deps.renderer = { ...deps.renderer, setPlanEntries } as unknown as ControllerDeps['renderer'];
      const todos = [{ content: 'Next step', status: 'pending' }];
      (readNativeSessionTodos as ReturnType<typeof vi.fn>).mockResolvedValue(todos);

      await controller.send('hello', []);

      await vi.waitFor(() => expect(setPlanEntries).toHaveBeenCalledWith(todos));
      expect(deps.renderer.collapseTurns).toHaveBeenCalled();
    });

    it('applies context usage reported in the response _meta', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockResolvedValue({
          stopReason: 'end_turn',
          _meta: { used: 12345, size: 200000, cost: { amount: 0.05, currency: 'USD' } },
        }),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const updateContextMeter = vi.fn();
      deps.updateContextMeter = updateContextMeter;

      await controller.send('hello', []);

      expect(controller.state.usage?.contextTokens).toBe(12345);
      expect(controller.state.usage?.contextWindow).toBe(200000);
      expect(controller.state.usage?.cost).toEqual({ amount: 0.05, currency: 'USD' });
      expect(updateContextMeter).toHaveBeenCalled();
    });

    it('renders, sends and persists pending image parts with the user message', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const addUserMessage = vi.fn();
      deps.renderer = { ...deps.renderer, addUserMessage } as unknown as ControllerDeps['renderer'];
      const images = [{ mimeType: 'image/png', data: 'AAA=' }];
      callbacks.getPendingImageParts = () =>
        images.map((i) => ({ type: 'image' as const, mimeType: i.mimeType, data: i.data }));
      callbacks.onClearPendingImageChips = vi.fn();
      controller = new CoOberViewController(deps, callbacks);

      await controller.send('look', []);

      expect(addUserMessage).toHaveBeenCalledWith('look', undefined, images);
      const appendCalls = (deps.sessionStore.append as ReturnType<typeof vi.fn>).mock.calls;
      const userAppend = appendCalls.find((call) => call[1]?.role === 'user');
      expect(userAppend?.[1]).toMatchObject({ content: 'look', type: 'text', images });
      const parts = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as PromptPart[];
      expect(parts[parts.length - 1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAA=' });
      expect(callbacks.onClearPendingImageChips).toHaveBeenCalled();
    });

    it('ignores late updates from a cancelled request after a new request starts', async () => {
      const firstResponse = deferred<AcpResponse>();
      const secondResponse = deferred<AcpResponse>();
      let firstHandler: ((update: NormalizedUpdate) => void) | undefined;
      let secondHandler: ((update: NormalizedUpdate) => void) | undefined;
      const client = createMockClient({
        sendMessage: vi
          .fn()
          .mockImplementationOnce(
            async (_id: string, _parts: PromptPart[], handler: (update: NormalizedUpdate) => void) => {
              firstHandler = handler;
              return firstResponse.promise;
            },
          )
          .mockImplementationOnce(
            async (_id: string, _parts: PromptPart[], handler: (update: NormalizedUpdate) => void) => {
              secondHandler = handler;
              return secondResponse.promise;
            },
          ),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const appendText = vi.fn();
      deps.renderer.appendText = appendText;

      const firstSend = controller.send('first', []);
      await vi.waitFor(() => expect(firstHandler).toBeDefined());
      await controller.stopGeneration();
      const secondSend = controller.send('second', []);
      await vi.waitFor(() => expect(secondHandler).toBeDefined());

      firstHandler?.({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'late-message',
        chunkText: 'late',
        accumulatedText: 'late',
      });
      secondHandler?.({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'current-message',
        chunkText: 'current',
        accumulatedText: 'current',
      });
      expect(appendText).toHaveBeenCalledTimes(1);
      expect(appendText).toHaveBeenCalledWith('current', 'current-message');

      firstResponse.resolve({ stopReason: 'interrupted' });
      secondResponse.resolve({ stopReason: 'end_turn' });
      await Promise.all([firstSend, secondSend]);
    });

    it('sends /compact through ACP prompt (not local interception)', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('/compact', []);

      expect(client.sendMessage).toHaveBeenCalled();
    });

    it('handles send errors', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockRejectedValue(new Error('network error')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('hello', []);

      expect(deps.renderer.addError).toHaveBeenCalledWith('network error');
      expect(controller.isBusy()).toBe(false);
    });

    it('claims busy synchronously so a same-tick double send queues instead of racing', async () => {
      const gate = deferred<AcpResponse>();
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => gate.promise),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const first = controller.send('first', []);
      const second = controller.send('second', []);
      await second;

      const queue = Reflect.get(controller, 'promptQueue') as Array<{ text: string }>;
      expect(queue.map((q) => q.text)).toEqual(['second']);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

      gate.resolve({ stopReason: 'end_turn' });
      await first;
      // Queue drained after the first turn completed
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
      expect(controller.isBusy()).toBe(false);
    });

    it('stop() restores queued prompts into the textarea instead of dropping them', async () => {
      const gate = deferred<AcpResponse>();
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => gate.promise),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const first = controller.send('first', []);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
      await controller.send('queued-1', []);
      await controller.send('queued-2', []);

      await controller.stopGeneration();

      const queue = Reflect.get(controller, 'promptQueue') as Array<{ text: string }>;
      expect(queue).toHaveLength(0);
      const ta = deps.input.textareaEl as unknown as { value: string; dispatchEvent: ReturnType<typeof vi.fn> };
      expect(ta.value).toBe('queued-1\nqueued-2');
      expect(ta.dispatchEvent).toHaveBeenCalled();
      expect(controller.isBusy()).toBe(false);

      gate.resolve({ stopReason: 'interrupted' });
      await first;
      // Stopped turn must not drain the (now-restored) queue
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(ta.value).toBe('queued-1\nqueued-2');
    });

    it('appends restored queue text to an existing draft', async () => {
      const gate = deferred<AcpResponse>();
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => gate.promise),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const first = controller.send('first', []);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
      await controller.send('queued-msg', []);
      const ta = deps.input.textareaEl as unknown as { value: string };
      ta.value = 'my draft';

      await controller.stopGeneration();

      expect(ta.value).toBe('my draft\nqueued-msg');
      gate.resolve({ stopReason: 'interrupted' });
      await first;
    });

    it('keeps queued prompts that carry refs in the queue when stopping', async () => {
      const gate = deferred<AcpResponse>();
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => gate.promise),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const first = controller.send('first', []);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
      const ref = { id: 'note.md', type: 'note', name: 'note', path: 'note.md' } as never;
      await controller.send('plain follow-up', []);
      await controller.send('with context', [ref]);

      await controller.stopGeneration();

      const queue = Reflect.get(controller, 'promptQueue') as Array<{ text: string; refs: unknown[] }>;
      expect(queue.map((q) => q.text)).toEqual(['with context']);
      expect(queue[0].refs).toHaveLength(1);
      const ta = deps.input.textareaEl as unknown as { value: string };
      expect(ta.value).toBe('plain follow-up');

      gate.resolve({ stopReason: 'interrupted' });
      await first;
    });

    it('offers a restart action when the agent process exits mid-request', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockRejectedValue(new AcpProcessExitError(1, null)),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('hello', []);

      expect(deps.renderer.addError).toHaveBeenCalledWith(t().error.processExit, 'restart', expect.any(Function));
      expect(controller.isBusy()).toBe(false);
    });

    it('does not let a superseded turn tear down the current turn state', async () => {
      const gate = deferred<AcpResponse>();
      const client = createMockClient({
        sendMessage: vi.fn().mockImplementation(() => gate.promise),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const first = controller.send('first', []);
      await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

      // Reconnect mid-stream: it bumps the generation and resets the busy flag,
      // so the pending turn is now superseded.
      controller.bindClientHandlers();
      const handlers = (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
      await handlers.onReconnect();
      const collapseCallsAfterReset = (deps.renderer.collapseTurns as ReturnType<typeof vi.fn>).mock.calls.length;
      const meterCallsAfterReset = (deps.updateContextMeter as ReturnType<typeof vi.fn>).mock.calls.length;

      gate.resolve({ stopReason: 'end_turn' });
      await first;

      // The stale turn's finally must not fold turns, report usage, or run post-response hooks.
      expect(deps.renderer.collapseTurns).toHaveBeenCalledTimes(collapseCallsAfterReset);
      expect(deps.updateContextMeter).toHaveBeenCalledTimes(meterCallsAfterReset);
    });

    it('surfaces refusal and truncation stop reasons instead of silent success', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockResolvedValue({ stopReason: 'refusal' }),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('hello', []);
      expect(deps.renderer.addError).toHaveBeenCalledWith(t().stopReason.refusal);

      (client.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ stopReason: 'max_tokens' });
      await controller.send('again', []);
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().stopReason.maxTokens);

      (client.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ stopReason: 'max_turn_requests' });
      await controller.send('more', []);
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().stopReason.maxTurnRequests);

      // User-initiated cancellations stay silent.
      const sysCalls = (deps.renderer.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls.length;
      (client.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ stopReason: 'cancelled' });
      await controller.send('done', []);
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledTimes(sysCalls);
    });

    it('gates the post-turn native plan refresh on streamed plan freshness', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const refreshSpy = vi.fn().mockResolvedValue(undefined);
      Reflect.set(controller, 'refreshNativePlan', refreshSpy);

      await controller.send('a', []);
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      // A plan that arrived during this turn is newer than any native snapshot.
      refreshSpy.mockClear();
      controller.state.lastPlanUpdateAt = Date.now() + 5_000;
      await controller.send('b', []);
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('surfaces unreadable permission requests as errors', () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.bindClientHandlers();
      const handlers = (client.setClientHandlers as ReturnType<typeof vi.fn>).mock.calls[0][0];
      handlers.onPermissionUnreadable('options: required');

      expect(deps.renderer.addError).toHaveBeenCalledWith(t().permission.unreadable);
    });
  });

  describe('stopGeneration', () => {
    it('does nothing when not busy', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'test';

      await controller.stopGeneration();

      expect(client.cancel).not.toHaveBeenCalled();
    });

    it('cancels when busy', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'test-session';
      // Simulate busy state by calling send which sets busy internally
      // We need to intercept during the send, so set busy directly
      Reflect.set(controller, 'busy', true);
      controller.state.isStreaming = true;

      await controller.stopGeneration();

      expect(client.cancel).toHaveBeenCalled();
      expect(controller.isBusy()).toBe(false);
      expect(controller.state.isStreaming).toBe(false);
    });
  });

  describe('switchSession', () => {
    it('switches session and restores messages', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        messages: [{ role: 'user', content: 'old msg', type: 'text', timestamp: 1000 }],
      });

      await controller.switchSession('target-session');

      expect(controller.getSessionId()).toBe('target-session');
      expect(deps.sessionStore.setActive).toHaveBeenCalledWith('target-session');
      expect(callbacks.onClearUI).toHaveBeenCalled();
      expect(callbacks.onAutoRefActiveFile).toHaveBeenCalled();
    });

    it('shows a dedicated error when a native OpenCode session is gone', async () => {
      const client = createMockClient({
        loadSession: vi.fn().mockRejectedValue(new AcpSessionMissingError('ses_gone')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.switchSession('ses_gone', 'opencode');

      expect(deps.renderer.addError).toHaveBeenCalledWith(t().session.nativeSessionMissing);
      expect(deps.renderer.addSystemMessage).not.toHaveBeenCalledWith(t().session.loadedNative);
    });

    it('shows the generic failure error for other load errors on native sessions', async () => {
      const client = createMockClient({
        loadSession: vi.fn().mockRejectedValue(new Error('transport died')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.switchSession('ses_x', 'opencode');

      expect(deps.renderer.addError).toHaveBeenCalledWith(t().session.loadNativeFailed);
    });
  });

  describe('session loss reporting', () => {
    it('informs the user when the agent dropped the session on connect', async () => {
      const client = createMockClient({
        loadSession: vi.fn().mockRejectedValue(new AcpSessionMissingError('local-1')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'local-1';

      await controller.ensureClientConnected();

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().session.runtimeSessionLost);
    });

    it('stays silent on connect for unrelated sync errors', async () => {
      const client = createMockClient({
        loadSession: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'local-1';

      await controller.ensureClientConnected();

      expect(deps.renderer.addSystemMessage).not.toHaveBeenCalledWith(t().session.runtimeSessionLost);
    });
  });

  describe('deleteSession', () => {
    it('removes session from store', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.deleteSession('other-session');

      expect(deps.sessionStore.remove).toHaveBeenCalledWith('other-session');
    });

    it('creates new session when deleting active', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'active-session';

      await controller.deleteSession('active-session');

      expect(deps.sessionStore.remove).toHaveBeenCalledWith('active-session');
      expect(client.createSession).toHaveBeenCalled();
    });
  });

  describe('forkSession', () => {
    it('forks session and updates state', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.forkSession('source-session');

      expect(client.forkSession).toHaveBeenCalledWith('source-session', '/vault');
      expect(controller.getSessionId()).toBe('forked-session');
      expect(deps.sessionStore.setActive).toHaveBeenCalledWith('forked-session');
    });
  });

  describe('resumeSession', () => {
    it('resumes session and updates state', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.resumeSession('paused-session');

      expect(client.resumeSession).toHaveBeenCalledWith('paused-session', '/vault', expect.any(Function));
      expect(controller.getSessionId()).toBe('paused-session');
      expect(deps.sessionStore.setActive).toHaveBeenCalledWith('paused-session');
    });

    it('refreshes native usage after resuming', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (readNativeSessionUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
        cost: 1.5,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });

      await controller.resumeSession('paused-session');

      expect(readNativeSessionUsage).toHaveBeenCalledWith('paused-session');
      expect(controller.state.usage?.cost).toEqual({ amount: 1.5, currency: 'USD' });
      expect(controller.state.usage?.thoughtTokens).toBeUndefined();
      expect(controller.state.usage?.contextTokens).toBeUndefined();
    });

    it('resyncs the native plan after resuming', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const setPlanEntries = vi.fn();
      deps.renderer = { ...deps.renderer, setPlanEntries } as unknown as ControllerDeps['renderer'];
      const todos = [{ content: 'Keep going', status: 'in_progress' }];
      (readNativeSessionTodos as ReturnType<typeof vi.fn>).mockResolvedValue(todos);

      await controller.resumeSession('paused-session');

      expect(readNativeSessionTodos).toHaveBeenCalledWith('paused-session');
      expect(setPlanEntries).toHaveBeenCalledWith(todos);
    });
  });

  describe('native session replay adoption', () => {
    function replayingClient() {
      return createMockClient({
        loadSession: vi.fn(
          async (_id: string, _cwd: string, _mcp: unknown, onReplay?: (u: NormalizedUpdate) => void) => {
            onReplay?.({
              kind: 'message_chunk',
              role: 'user',
              messageId: 'u1',
              chunkText: 'question',
              accumulatedText: 'question',
            });
            onReplay?.({
              kind: 'message_chunk',
              role: 'thought',
              messageId: 'a0',
              chunkText: 'pondering',
              accumulatedText: 'pondering',
            });
            onReplay?.({
              kind: 'message_chunk',
              role: 'agent',
              messageId: 'a1',
              chunkText: 'hi',
              accumulatedText: 'hi',
            });
          },
        ),
      });
    }

    function sharedStore(messages: SerializedMessage[] = []) {
      const shared = {
        sessionId: 'ses_native',
        title: 'native',
        opencodeSessionId: 'ses_native',
        messages,
        createdAt: 0,
        updatedAt: 0,
      };
      return {
        shared,
        override: {
          get: vi.fn(() => shared),
          getOrCreate: vi.fn(() => shared),
          setActive: vi.fn(),
          save: vi.fn(),
          remove: vi.fn(),
          list: vi.fn(() => []),
          append: vi.fn(),
        },
      };
    }

    it('stores and renders the replayed transcript when the local mirror is empty', async () => {
      const client = replayingClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const { shared, override } = sharedStore();
      deps.sessionStore = { ...deps.sessionStore, ...override } as ControllerDeps['sessionStore'];
      controller = new CoOberViewController(deps, callbacks);

      await controller.switchSession('ses_native', 'opencode');

      expect(shared.messages).toHaveLength(3);
      expect(shared.messages[0]).toMatchObject({ role: 'user', type: 'text', content: 'question' });
      expect(shared.messages[1]).toMatchObject({ role: 'assistant', type: 'thinking', content: 'pondering' });
      expect(shared.messages[2]).toMatchObject({ role: 'assistant', type: 'text', content: 'hi' });
      expect(override.save).toHaveBeenCalled();
      expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('question', expect.anything(), undefined);
      expect(deps.renderer.appendThinking).toHaveBeenCalledWith('pondering', expect.anything(), expect.anything());
      expect(deps.renderer.appendText).toHaveBeenCalledWith('hi', expect.anything(), expect.anything(), undefined, undefined);
    });

    it('refreshes cost and context from the native database when adopting', async () => {
      const client = replayingClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const { override } = sharedStore();
      deps.sessionStore = { ...deps.sessionStore, ...override } as ControllerDeps['sessionStore'];
      const updateContextMeter = vi.fn();
      deps.updateContextMeter = updateContextMeter;
      (readNativeSessionUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
        cost: 0.42,
        inputTokens: 1000,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadTokens: 9000,
        cacheWriteTokens: 0,
        contextTokens: 32770,
      });
      controller = new CoOberViewController(deps, callbacks);

      await controller.switchSession('ses_native', 'opencode');

      expect(readNativeSessionUsage).toHaveBeenCalledWith('ses_native');
      expect(controller.state.usage).toEqual({
        totalTokens: 1250,
        inputTokens: 1000,
        outputTokens: 200,
        thoughtTokens: 50,
        cost: { amount: 0.42, currency: 'USD' },
        contextWindow: undefined,
        contextTokens: 32770,
      });
      expect(updateContextMeter).toHaveBeenCalled();
    });

    it('keeps the existing local mirror when it already has messages', async () => {
      const client = replayingClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const existing: SerializedMessage[] = [{ role: 'user', type: 'text', content: 'local only', timestamp: 1 }];
      const { shared, override } = sharedStore(existing.slice());
      deps.sessionStore = { ...deps.sessionStore, ...override } as ControllerDeps['sessionStore'];
      controller = new CoOberViewController(deps, callbacks);

      await controller.switchSession('ses_native', 'opencode');

      expect(shared.messages).toEqual(existing);
    });

    it('resumeSession also adopts the replayed transcript', async () => {
      const client = createMockClient({
        resumeSession: vi.fn(async (_id: string, _cwd: string, onReplay?: (u: NormalizedUpdate) => void) => {
          onReplay?.({
            kind: 'message_chunk',
            role: 'agent',
            messageId: 'a1',
            chunkText: 'resumed text',
            accumulatedText: 'resumed text',
          });
        }),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const { shared, override } = sharedStore();
      deps.sessionStore = { ...deps.sessionStore, ...override } as ControllerDeps['sessionStore'];
      controller = new CoOberViewController(deps, callbacks);

      await controller.resumeSession('ses_native');

      expect(shared.messages).toHaveLength(1);
      expect(shared.messages[0]).toMatchObject({ role: 'assistant', content: 'resumed text' });
    });
  });

  describe('rewindUserTurn', () => {
    const userMsg = (content: string): SerializedMessage => ({ role: 'user', type: 'text', content, timestamp: 1 });
    const asstMsg = (content: string): SerializedMessage => ({
      role: 'assistant',
      type: 'text',
      content,
      timestamp: 2,
    });

    function rewindSetup(messages: SerializedMessage[], clientOverrides: Record<string, unknown> = {}) {
      const shared = {
        sessionId: 'old-ses',
        title: 'rewind',
        opencodeSessionId: 'old-ses',
        messages,
        createdAt: 0,
        updatedAt: 0,
      };
      const store = {
        get: vi.fn(() => shared),
        getOrCreate: vi.fn(() => shared),
        setActive: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
        list: vi.fn(() => []),
        append: vi.fn(),
        rekey: vi.fn((_oldId: string, newId: string) => {
          shared.sessionId = newId;
          shared.opencodeSessionId = newId;
        }),
      };
      deps.sessionStore = store as unknown as ControllerDeps['sessionStore'];
      const addUserMessage = vi.fn();
      deps.renderer = { ...deps.renderer, addUserMessage } as unknown as ControllerDeps['renderer'];
      const client = createMockClient({
        createSession: vi.fn().mockResolvedValue('fresh-ses'),
        getCurrentSessionId: vi.fn(() => 'fresh-ses'),
        ...clientOverrides,
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller = new CoOberViewController(deps, callbacks);
      controller.state.sessionId = 'old-ses';
      return { shared, store, client, addUserMessage };
    }

    it('truncates from the target turn and resends it into a fresh agent session with history context', async () => {
      const { shared, store, client, addUserMessage } = rewindSetup([
        userMsg('q1'),
        asstMsg('a1'),
        userMsg('q2'),
        asstMsg('a2'),
      ]);

      await controller.rewindUserTurn(2);

      expect(store.rekey).toHaveBeenCalledWith('old-ses', 'fresh-ses');
      expect(controller.state.sessionId).toBe('fresh-ses');
      expect(store.setActive).toHaveBeenCalledWith('fresh-ses');
      expect(shared.messages).toEqual([userMsg('q1'), asstMsg('a1')]);
      expect(client.closeSession).not.toHaveBeenCalled();

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      const [sid, parts] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PromptPart[]];
      expect(sid).toBe('fresh-ses');
      expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'q2' });
      const historyPart = parts.find(
        (p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes(t().rewind.contextHeader),
      );
      expect(historyPart).toBeDefined();
      expect((historyPart as { text: string }).text).toContain('User: q1');
      expect((historyPart as { text: string }).text).toContain('Assistant: a1');
      expect((historyPart as { text: string }).text).not.toContain('q2');

      // history is re-rendered before the new turn is sent
      expect(addUserMessage).toHaveBeenCalledWith('q1', 1, undefined);
    });

    it('regenerating the first turn sends no history block', async () => {
      const { client } = rewindSetup([userMsg('q1'), asstMsg('a1')]);

      await controller.rewindUserTurn(1);

      const [, parts] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PromptPart[]];
      expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'q1' });
      expect(
        parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes(t().rewind.contextHeader)),
      ).toBe(false);
    });

    it('edit-and-resend replaces the original text while keeping the same truncation', async () => {
      const { shared, client, addUserMessage } = rewindSetup([userMsg('q1'), asstMsg('a1'), userMsg('q2')]);

      await controller.rewindUserTurn(2, '  edited question  ');

      expect(shared.messages).toEqual([userMsg('q1'), asstMsg('a1')]);
      const [, parts] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, PromptPart[]];
      expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'edited question' });
      expect(addUserMessage).toHaveBeenCalledWith('edited question', undefined, undefined);
    });

    it('refuses to rewind while a generation is in flight', async () => {
      const { shared, client } = rewindSetup([userMsg('q1'), asstMsg('a1')]);
      Reflect.set(controller, 'busy', true);

      await controller.rewindUserTurn(1);

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().rewind.busy);
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(shared.messages).toHaveLength(2);
    });

    it('closes the old agent session when the capability exists', async () => {
      const closeSession = vi.fn().mockResolvedValue(undefined);
      rewindSetup([userMsg('q1')], {
        getAgentCapabilities: vi.fn(() => ({ sessionCapabilities: { close: true } })),
        closeSession,
      });

      await controller.rewindUserTurn(1);

      expect(closeSession).toHaveBeenCalledWith('old-ses');
    });

    it('ignores unknown ordinals without touching the session', async () => {
      const { shared, store, client } = rewindSetup([userMsg('q1')]);

      await controller.rewindUserTurn(5);

      expect(store.rekey).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(controller.state.sessionId).toBe('old-ses');
      expect(shared.messages).toHaveLength(1);
    });

    it('leaves the transcript untouched when the fresh agent session cannot be created', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { shared, store, client } = rewindSetup([userMsg('q1'), asstMsg('a1'), userMsg('q2')], {
        createSession: vi.fn().mockRejectedValue(new Error('spawn boom')),
      });

      await controller.rewindUserTurn(2);

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().rewind.renewFailed);
      expect(shared.messages).toHaveLength(3);
      expect(store.rekey).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(controller.state.sessionId).toBe('old-ses');
      errSpy.mockRestore();
    });
  });

  describe('loadToolbarOptions', () => {
    it('does nothing without client', () => {
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
      controller.loadToolbarOptions();
      expect(deps.toolbar.updateAgents).not.toHaveBeenCalled();
    });

    it('updates toolbar with snapshot data', () => {
      const client = createMockClient({
        getSessionSnapshot: vi.fn(() => ({
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-4',
              options: [{ value: 'gpt-4', name: 'GPT-4' }],
            },
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'high',
              options: [],
            },
            {
              id: 'mode',
              name: 'Mode',
              category: 'mode',
              type: 'select',
              currentValue: 'build',
              options: [{ value: 'build', name: 'Build' }],
            },
          ],
          availableCommands: [],
          availableModels: [{ modelId: 'gpt-4', name: 'GPT-4' }],
          availableModes: [{ id: 'build', name: 'Build' }],
          currentModelId: 'gpt-4',
          currentModeId: 'build',
        })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.loadToolbarOptions();

      expect(deps.toolbar.updateAgents).toHaveBeenCalled();
      expect(deps.toolbar.updateModels).toHaveBeenCalled();
      expect(deps.toolbar.updateEffort).toHaveBeenCalled();
      expect(controller.state.currentModelId).toBe('gpt-4');
    });

    it('surfaces agent-provided effort options with normalized labels', () => {
      const ef = t().toolbar.effort;
      const client = createMockClient({
        getSessionSnapshot: vi.fn(() => ({
          configOptions: [
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'minimal',
              options: [
                { value: 'minimal', name: 'minimal' },
                { value: 'x-high', name: 'x high' },
                { value: 'turbo', name: 'Turbo Mode' },
              ],
            },
          ],
          availableCommands: [],
          availableModels: [],
          availableModes: [],
          currentModelId: null,
          currentModeId: null,
        })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.loadToolbarOptions();

      expect(deps.toolbar.updateEffort).toHaveBeenCalledWith(
        [
          { value: 'minimal', label: ef.minimal },
          { value: 'x-high', label: ef.xhigh },
          { value: 'turbo', label: 'Turbo Mode' },
        ],
        'minimal',
      );
    });

    it('falls back to the built-in effort list when the agent provides none', () => {
      const ef = t().toolbar.effort;
      const client = createMockClient({
        getSessionSnapshot: vi.fn(() => ({
          configOptions: [],
          availableCommands: [],
          availableModels: [],
          availableModes: [],
          currentModelId: null,
          currentModeId: null,
        })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      controller.loadToolbarOptions();

      expect(deps.toolbar.updateEffort).toHaveBeenCalledWith(
        [
          { value: 'default', label: ef.default },
          { value: 'low', label: ef.low },
          { value: 'medium', label: ef.medium },
          { value: 'high', label: ef.high },
        ],
        'default',
      );
    });
  });

  describe('applyConfigOptions effort normalization', () => {
    it('localizes known effort values in config_option_update', () => {
      const ef = t().toolbar.effort;
      controller.applyConfigOptions([
        {
          id: 'effort',
          name: 'Effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'xhigh',
          options: [
            { value: 'xhigh', name: 'xhigh' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ]);
      expect(deps.toolbar.updateEffort).toHaveBeenCalledWith(
        [
          { value: 'xhigh', label: ef.xhigh },
          { value: 'auto', label: 'Auto' },
        ],
        'xhigh',
      );
    });
  });

  describe('normalizeEffortLabel', () => {
    it('localizes known effort values case- and separator-insensitively', () => {
      const ef = t().toolbar.effort;
      expect(normalizeEffortLabel('high', 'HIGH')).toBe(ef.high);
      expect(normalizeEffortLabel(' High ', 'x')).toBe(ef.high);
      expect(normalizeEffortLabel('x_high', 'x')).toBe(ef.xhigh);
      expect(normalizeEffortLabel('MINIMAL', 'minimal')).toBe(ef.minimal);
      expect(normalizeEffortLabel('max', 'maximum')).toBe(ef.max);
    });

    it('keeps agent-provided names for unknown values', () => {
      expect(normalizeEffortLabel('turbo', 'Turbo Mode')).toBe('Turbo Mode');
      expect(normalizeEffortLabel('turbo', '')).toBe('turbo');
      expect(normalizeEffortLabel('constructor', 'ctor')).toBe('ctor');
    });
  });

  describe('resetConversationView', () => {
    it('resets all state and calls callbacks', () => {
      controller.state.isStreaming = true;
      controller.state.usage = { totalTokens: 100, inputTokens: 50, outputTokens: 50 };
      Reflect.get(controller, 'promptQueue').push({ text: 'pending', refs: [] });

      controller.resetConversationView();

      expect(controller.state.isStreaming).toBe(false);
      expect(controller.state.usage).toBeNull();
      expect(deps.renderer.clear).toHaveBeenCalled();
      expect(callbacks.onClearUI).toHaveBeenCalled();
      expect(callbacks.onClearChips).toHaveBeenCalled();
      expect(callbacks.onClearPendingImageChips).toHaveBeenCalled();
      expect(Reflect.get(controller, 'promptQueue')).toHaveLength(0);
    });
  });

  describe('buildParts', () => {
    it('builds parts with text only', async () => {
      const parts = await controller.buildParts('hello', []);
      expect(parts).toEqual([
        { type: 'text', text: expect.stringContaining('You are Co-Ober') },
        { type: 'text', text: 'hello' },
      ]);
    });

    it('resolves context refs', async () => {
      (deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: 'note',
        content: 'note content',
      });

      const parts = await controller.buildParts('hello', [{ id: 'n1', type: 'note', name: 'note', path: 'note.md' }]);

      expect(deps.resolver.resolveNote).toHaveBeenCalledWith('note.md');
      expect(parts.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('pending image parts', () => {
    it('appends pending image parts to the prompt and clears chips', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      callbacks.getPendingImageParts = vi.fn((): PromptPart[] => [
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ]);

      await controller.send('look at this', []);

      const parts = client.sendMessage.mock.calls[0][1] as PromptPart[];
      expect(parts.some((p) => p.type === 'image' && p.mimeType === 'image/png' && p.data === 'aGVsbG8=')).toBe(true);
      expect(callbacks.onClearPendingImageChips).toHaveBeenCalled();
    });

    it('sends text-only parts when no images are pending', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      await controller.send('hello', []);

      const parts = client.sendMessage.mock.calls[0][1] as PromptPart[];
      expect(parts.every((p) => p.type === 'text')).toBe(true);
    });
  });

  describe('sendTextToAgent', () => {
    it('completes successfully without adding user message', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const fn = Reflect.get(controller, 'sendTextToAgent') as (text: string, refs?: ContextRef[]) => Promise<void>;

      await fn.call(controller, 'silent msg');

      expect(client.sendMessage).toHaveBeenCalled();
      expect(controller.isBusy()).toBe(false);
    });

    it('uses buildPartsWithRefs when refs provided', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const refs: ContextRef[] = [{ id: 'n1', type: 'note', name: 'note.md', path: 'note.md' }];
      (deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({
        name: 'note.md',
        content: 'note content',
      });
      const fn = Reflect.get(controller, 'sendTextToAgent') as (text: string, refs?: ContextRef[]) => Promise<void>;

      await fn.call(controller, 'query', refs);

      expect(deps.resolver.resolveNote).toHaveBeenCalledWith('note.md');
      expect(client.sendMessage).toHaveBeenCalled();
    });

    it('sends plain text part when no refs', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const fn = Reflect.get(controller, 'sendTextToAgent') as (text: string, refs?: ContextRef[]) => Promise<void>;

      await fn.call(controller, 'plain text', []);

      const callArgs = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs[1]).toEqual([{ type: 'text', text: 'plain text' }]);
    });

    it('handles error in sendTextToAgent', async () => {
      const client = createMockClient({
        sendMessage: vi.fn().mockRejectedValue(new Error('send error')),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const fn = Reflect.get(controller, 'sendTextToAgent') as (text: string, refs?: ContextRef[]) => Promise<void>;

      await fn.call(controller, 'failing msg');

      expect(deps.renderer.addError).toHaveBeenCalledWith('send error');
      expect(controller.isBusy()).toBe(false);
    });
  });

  describe('copyLastAssistantMessage', () => {
    it('does nothing without session', () => {
      controller.copyLastAssistantMessage();
      // Should not throw
    });

    it('copies last assistant message to clipboard', () => {
      controller.state.sessionId = 'test';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        messages: [
          { role: 'user', content: 'q', type: 'text' },
          { role: 'assistant', content: 'answer', type: 'text' },
        ],
      });
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      controller.copyLastAssistantMessage();

      expect(writeText).toHaveBeenCalledWith('answer');
    });
  });

  describe('exportSessionToNote', () => {
    it('reports when there is no session content to export', async () => {
      await controller.exportSessionToNote();
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().export.noSession);
      expect(deps.runtime.createNote).not.toHaveBeenCalled();
    });

    it('writes the transcript as a dated vault note under the configured folder', async () => {
      controller.state.sessionId = 'exp-1';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'exp-1',
        title: 'Research chat',
        messages: [
          { role: 'user', content: 'question', type: 'text', timestamp: 1 },
          { role: 'assistant', content: 'answer', type: 'text', timestamp: 2 },
        ],
      });

      await controller.exportSessionToNote();

      const createNote = deps.runtime.createNote as ReturnType<typeof vi.fn>;
      expect(createNote).toHaveBeenCalledTimes(1);
      const [path, content] = createNote.mock.calls[0] as [string, string];
      expect(path).toMatch(/^co-ober-notes\/Research chat \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.md$/);
      expect(content).toContain('# Research chat');
      expect(content).toContain('question');
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining(path));
    });

    it('surfaces note write failures', async () => {
      controller.state.sessionId = 'exp-2';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'exp-2',
        title: 'x',
        messages: [{ role: 'user', content: 'hi', type: 'text', timestamp: 1 }],
      });
      (deps.runtime.createNote as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));

      await controller.exportSessionToNote();

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });
  });

  describe('copyTranscript', () => {
    it('copies the rendered transcript to the clipboard and confirms', async () => {
      controller.state.sessionId = 'cp-1';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'cp-1',
        title: 'Chat',
        messages: [{ role: 'user', content: 'hi there', type: 'text', timestamp: 1 }],
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      controller.copyTranscript();
      await new Promise((r) => setTimeout(r, 0));

      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('# Chat'));
      expect(writeText.mock.calls[0][0]).toContain('hi there');
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().copy.transcript);
    });

    it('reports when there is nothing to copy', () => {
      controller.copyTranscript();
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().export.noSession);
    });
  });

  describe('renameSession', () => {
    it('renames through the store and persists', async () => {
      await controller.renameSession('s-1', ' New title ');
      expect(deps.sessionStore.rename).toHaveBeenCalledWith('s-1', 'New title');
      expect(deps.sessionStore.save).toHaveBeenCalled();
    });

    it('ignores blank titles', async () => {
      await controller.renameSession('s-1', '   ');
      expect(deps.sessionStore.rename).not.toHaveBeenCalled();
      expect(deps.sessionStore.save).not.toHaveBeenCalled();
    });

    it('skips saving when the session is unknown', async () => {
      (deps.sessionStore.rename as ReturnType<typeof vi.fn>).mockReturnValue(false);
      await controller.renameSession('missing', 'Title');
      expect(deps.sessionStore.save).not.toHaveBeenCalled();
    });
  });
});

describe('CoOberViewController — 0.1.31 correctness patches', () => {
  let deps: ControllerDeps;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let controller: CoOberViewController;

  beforeEach(() => {
    setLocale('en');
    deps = createMockDeps();
    callbacks = createMockCallbacks();
    (readNativeSessionUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (readNativeSessionTodos as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (readNativeMessageStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (readNativeToolErrors as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (readNativeTurnStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    controller = new CoOberViewController(deps, callbacks);
  });

  function noteRef(path: string): ContextRef {
    return { id: path, type: 'note', name: path, path } as ContextRef;
  }

  describe('forkSession', () => {
    it('copies the source transcript into the fork and re-renders it', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      const sourceMsg = { role: 'user', content: 'hello', type: 'text', timestamp: 1 };
      const forked = { sessionId: 'forked-session', title: 'New Chat', messages: [] as unknown[], updatedAt: 0 };
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
        if (id === 'local-1') return { sessionId: 'local-1', title: 'Source', messages: [sourceMsg], updatedAt: 0 };
        if (id === 'forked-session') return forked;
        return undefined;
      });
      (deps.sessionStore.getOrCreate as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
        id === 'forked-session' ? forked : { sessionId: id, title: 'x', messages: [], updatedAt: 0 },
      );

      await controller.forkSession('local-1');

      expect(controller.getSessionId()).toBe('forked-session');
      expect(forked.messages).toEqual([sourceMsg]);
      expect(client.loadSession).toHaveBeenCalledWith('forked-session', '/vault', [], expect.any(Function));
      expect(deps.sessionStore.setActive).toHaveBeenCalledWith('forked-session');
      expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('hello', 1, undefined);
    });

    it('surfaces agent errors instead of throwing', async () => {
      const client = createMockClient({ forkSession: vi.fn().mockRejectedValue(new Error('fork boom')) });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await expect(controller.forkSession('local-1')).resolves.toBeUndefined();

      expect(deps.renderer.addError).toHaveBeenCalledWith('fork boom');
      expect(deps.sessionStore.setActive).not.toHaveBeenCalled();
    });
  });

  describe('queue robustness', () => {
    it('releases queued prompts when the agent call fails before sending', async () => {
      const initDeferred = deferred<boolean>();
      (deps.runtime.initClient as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(initDeferred.promise)
        .mockResolvedValue(false);

      const first = controller.send('first', []);
      expect(controller.isBusy()).toBe(true);
      await controller.send('second', []);
      initDeferred.resolve(false);
      await first;

      expect(controller.isBusy()).toBe(false);
      const queue = (controller as unknown as { promptQueue: unknown[] }).promptQueue;
      expect(queue).toHaveLength(0);
      expect(deps.runtime.getClient()).toBeNull();
    });

    it('keeps draining the queue after a failing slash command', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      commandRegistry.registerBuiltin({
        id: 'boom-test',
        trigger: 'boom-test',
        title: 'Boom',
        description: 'throws',
        category: 'session',
        source: 'builtin',
        run: async () => {
          throw new Error('boom');
        },
      });
      try {
        controller.state.sessionId = 'local-1';
        const first = controller.send('hold', []);
        await controller.send('/boom-test', []);
        await controller.send('tail', []);
        await first;

        expect(deps.renderer.addError).toHaveBeenCalledWith('boom');
        // drainQueue is fire-and-forget; wait for the tail prompt to reach the client.
        await vi.waitFor(() => {
          const calls = client.sendMessage.mock.calls as unknown as Array<[string, Array<{ text?: string }>, unknown]>;
          const lastParts = calls[calls.length - 1]?.[1] ?? [];
          expect(lastParts.some((p) => p.text === 'tail')).toBe(true);
        });
      } finally {
        const builtins = Reflect.get(commandRegistry, 'builtins') as Map<string, unknown>;
        builtins.delete('boom-test');
        (Reflect.get(commandRegistry, 'rebuildOrder') as () => void).call(commandRegistry);
      }
    });
  });

  describe('restore', () => {
    it('renders system messages instead of dropping them', async () => {
      controller.state.sessionId = 'local-1';
      (deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionId: 'local-1',
        title: 't',
        messages: [{ role: 'system', content: 'Transcript saved to notes/x.md', type: 'text', timestamp: 1 }],
        updatedAt: 0,
      });

      await controller.restoreSession();

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith('Transcript saved to notes/x.md');
    });
  });

  describe('/resume', () => {
    it('resumes the session when an id is given', async () => {
      const client = createMockClient();
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await commandRegistry.find('resume')!.run('ses_42');

      expect(client.resumeSession).toHaveBeenCalledWith('ses_42', '/vault', expect.any(Function));
      expect(controller.getSessionId()).toBe('ses_42');
    });

    it('opens the session dropdown when no id is given', async () => {
      const onOpenSessions = vi.fn();
      const local = new CoOberViewController(deps, { ...callbacks, onOpenSessions });
      expect(local).toBeInstanceOf(CoOberViewController);

      await commandRegistry.find('resume')!.run('');

      expect(onOpenSessions).toHaveBeenCalledTimes(1);
    });

    it('shows a usage hint when no dropdown callback exists', async () => {
      await commandRegistry.find('resume')!.run('');

      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/resume'));
    });
  });

  describe('syncRuntimeSession capability gating', () => {
    it('falls back to resume when the agent cannot load sessions', async () => {
      const client = createMockClient({
        getAgentCapabilities: vi.fn(() => ({ loadSession: false, sessionCapabilities: { resume: true } })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.syncRuntimeSession('ses_a');

      expect(client.loadSession).not.toHaveBeenCalled();
      expect(client.resumeSession).toHaveBeenCalledWith('ses_a', '/vault', undefined);
    });

    it('surfaces a clear notice when neither load nor resume is supported', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = createMockClient({ getAgentCapabilities: vi.fn(() => ({ loadSession: false })) });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

      await controller.syncRuntimeSession('ses_a');

      expect(client.loadSession).not.toHaveBeenCalled();
      expect(client.resumeSession).not.toHaveBeenCalled();
      expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().session.syncUnsupported);
      warn.mockRestore();
    });
  });

  describe('note content cache', () => {
    it('reuses cached notes and drops the entry on invalidateNoteCache', async () => {
      controller.state.sessionId = 'local-1';
      const resolve = deps.resolver.resolveNote as ReturnType<typeof vi.fn>;
      resolve.mockResolvedValue({ name: 'a', content: 'body' });
      const ref = noteRef('a.md');

      await controller.buildParts('q', [ref]);
      await controller.buildParts('q', [ref]);
      expect(resolve).toHaveBeenCalledTimes(1);

      controller.invalidateNoteCache('a.md');
      await controller.buildParts('q', [ref]);
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently used entry beyond the cache cap', async () => {
      controller.state.sessionId = 'local-1';
      const resolve = deps.resolver.resolveNote as ReturnType<typeof vi.fn>;
      resolve.mockImplementation((p: string) => Promise.resolve({ name: p, content: p }));

      for (let i = 0; i < 100; i++) await controller.buildParts('q', [noteRef(`p${i}.md`)]);
      // Touch p0 so p1 becomes the least recently used entry.
      await controller.buildParts('q', [noteRef('p0.md')]);
      expect(resolve).toHaveBeenCalledTimes(100);

      resolve.mockClear();
      await controller.buildParts('q', [noteRef('new.md')]);
      // Insertion at the cap evicts p1, not the freshly touched p0.
      expect(resolve.mock.calls.map((c) => c[0])).toEqual(['new.md']);

      await controller.buildParts('q', [noteRef('p0.md')]);
      expect(resolve).toHaveBeenCalledTimes(1);
      await controller.buildParts('q', [noteRef('p1.md')]);
      expect(resolve.mock.calls.map((c) => c[0])).toEqual(['new.md', 'p1.md']);
    });
  });

  describe('prompt capability gating', () => {
    it('skips note embedding when the agent reports no embeddedContext', async () => {
      const client = createMockClient({
        getAgentCapabilities: vi.fn(() => ({ promptCapabilities: { embeddedContext: false } })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'local-1';

      const parts = await controller.buildParts('question', [noteRef('a.md')]);

      expect(deps.resolver.resolveNote).not.toHaveBeenCalled();
      // The system prompt documents the `=== NOTE:` marker, so assert on the block footer instead.
      expect(parts.some((p) => (p.text ?? '').includes('=== END NOTE ==='))).toBe(false);
      expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'question' });
    });

    it('does not send image parts when the agent lost image capability', async () => {
      const client = createMockClient({
        getAgentCapabilities: vi.fn(() => ({ promptCapabilities: { image: false } })),
      });
      (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
      controller.state.sessionId = 'local-1';
      callbacks.getPendingImageParts = () => [{ type: 'image', mimeType: 'image/png', data: 'AAA' }];

      await controller.send('look', []);

      const parts = client.sendMessage.mock.calls[0][1] as Array<{ type: string }>;
      expect(parts.some((p) => p.type === 'image')).toBe(false);
    });
  });

  describe('builtin slash registration follows the locale', () => {
    it('re-registers builtin titles when the locale changes', async () => {
      setLocale('en');
      const enTitle = commandRegistry.find('compact')!.title;

      setLocale('zh');
      const zhTitle = commandRegistry.find('compact')!.title;
      expect(zhTitle).not.toBe(enTitle);
      expect(zhTitle).toBe(zhLocale.slashTitles.compact);

      setLocale('en');
      expect(commandRegistry.find('compact')!.title).toBe(enTitle);
    });
  });
});

describe('CoOberViewController — side chat (/btw)', () => {
  let deps: ControllerDeps;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let controller: CoOberViewController;
  let addError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLocale('en');
    deps = createMockDeps();
    callbacks = createMockCallbacks();
    addError = vi.fn();
    (deps.renderer as unknown as { addError: ReturnType<typeof vi.fn> }).addError = addError;
    (deps.renderer as unknown as { addUserMessage: ReturnType<typeof vi.fn> }).addUserMessage = vi.fn();
    controller = new CoOberViewController(deps, callbacks);
  });

  function forkClient(capOverrides: Record<string, unknown> = {}) {
    const client = createMockClient({
      getAgentCapabilities: vi.fn(() => ({ sessionCapabilities: { fork: true, close: true } })),
      ...capOverrides,
    });
    (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    return client;
  }

  it('registers /btw as a builtin slash command', () => {
    const def = commandRegistry.find('btw');
    expect(def).toBeDefined();
    expect(def!.title).toBe(t().slashTitles.btw);
    expect(def!.enabled?.()).toBe(false);
  });

  it('reports not-connected when there is no client', async () => {
    await controller.startSideChat('hello');
    expect(addError).toHaveBeenCalledWith(t().sideChat.notConnected);
  });

  it('refuses when the agent cannot fork sessions', async () => {
    const client = createMockClient();
    (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    await controller.startSideChat('hello');
    expect(addError).toHaveBeenCalledWith(t().sideChat.forkUnsupported);
    expect(client.forkSession).not.toHaveBeenCalled();
    expect(callbacks.onOpenSideChat).not.toHaveBeenCalled();
  });

  it('defers while the main conversation is busy', async () => {
    const client = forkClient();
    (controller as unknown as { busy: boolean }).busy = true;
    await controller.startSideChat('hello');
    expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith(t().sideChat.busy);
    expect(client.forkSession).not.toHaveBeenCalled();
  });

  it('forks once, leaves the main session untouched, and routes asks to the side session', async () => {
    const client = forkClient();
    controller.state.sessionId = 'local-1';

    await controller.startSideChat('what is X?');

    expect(client.forkSession).toHaveBeenCalledTimes(1);
    expect(client.forkSession).toHaveBeenCalledWith('local-1', '/vault');
    expect(callbacks.onOpenSideChat).toHaveBeenCalledTimes(1);
    const sideCalls = (callbacks.onOpenSideChat as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [(text: string, onChunk: (u: NormalizedUpdate) => void) => Promise<AcpResponse>, string]
    >;
    const ask = sideCalls[0][0];
    const question = sideCalls[0][1];
    expect(question).toBe('what is X?');
    expect(controller.getSessionId()).toBe('local-1');
    expect(deps.renderer.addUserMessage).not.toHaveBeenCalled();
    expect(deps.sessionStore.append).not.toHaveBeenCalled();

    await ask('follow up', () => {});
    expect(client.sendMessage).toHaveBeenCalledWith('forked-session', [{ type: 'text', text: 'follow up' }], expect.any(Function));

    await controller.startSideChat('another question');
    expect(client.forkSession).toHaveBeenCalledTimes(1);
    expect(callbacks.onOpenSideChat).toHaveBeenCalledTimes(2);
  });

  it('closes the side session on endSideChat and rejects later asks', async () => {
    const client = forkClient();
    controller.state.sessionId = 'local-1';
    await controller.startSideChat('hi');
    const ask = (callbacks.onOpenSideChat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (
      text: string,
      onChunk: (u: NormalizedUpdate) => void,
    ) => Promise<AcpResponse>;

    controller.endSideChat();

    expect(client.closeSession).toHaveBeenCalledWith('forked-session');
    await expect(ask('later', () => {})).rejects.toThrow(t().sideChat.notConnected);
  });

  it('skips the close RPC when the agent lacks the close capability', async () => {
    const client = forkClient({
      getAgentCapabilities: vi.fn(() => ({ sessionCapabilities: { fork: true } })),
    });
    controller.state.sessionId = 'local-1';
    await controller.startSideChat('hi');

    controller.endSideChat();
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it('abortSideChat cancels the side session turn', async () => {
    const client = forkClient();
    controller.state.sessionId = 'local-1';
    await controller.startSideChat('hi');

    controller.abortSideChat();

    expect(client.cancel).toHaveBeenCalledWith('forked-session');
  });

  it('abortSideChat is inert without an active side session', () => {
    const client = forkClient();

    controller.abortSideChat();

    expect(client.cancel).not.toHaveBeenCalled();
  });

  it('tears the panel down from resetConversationView', async () => {
    const client = forkClient();
    controller.state.sessionId = 'local-1';
    await controller.startSideChat('hi');

    controller.resetConversationView();

    expect(callbacks.onCloseSideChat).toHaveBeenCalledTimes(1);
    expect(client.closeSession).toHaveBeenCalledWith('forked-session');
  });

  it('routes /btw <question> through the slash registry', async () => {
    const client = forkClient();
    controller.state.sessionId = 'local-1';

    await commandRegistry.find('btw')!.run('quick question');

    expect(client.forkSession).toHaveBeenCalledWith('local-1', '/vault');
    expect(callbacks.onOpenSideChat).toHaveBeenCalledWith(expect.any(Function), 'quick question');
  });

  it('surfaces fork failures as errors', async () => {
    forkClient({ forkSession: vi.fn().mockRejectedValue(new Error('fork boom')) });
    controller.state.sessionId = 'local-1';

    await controller.startSideChat('hi');

    expect(addError).toHaveBeenCalledWith(expect.stringContaining('fork boom'));
    expect(callbacks.onOpenSideChat).not.toHaveBeenCalled();
  });
});

describe('CoOberViewController — queue visualization and auto titles', () => {
  let deps: ControllerDeps;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let controller: CoOberViewController;

  beforeEach(() => {
    setLocale('en');
    deps = createMockDeps();
    callbacks = createMockCallbacks();
    controller = new CoOberViewController(deps, callbacks);
  });

  function connectedClient() {
    const gate = deferred<AcpResponse>();
    const client = createMockClient({
      sendMessage: vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ stopReason: 'end_turn' }),
    });
    (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    return { gate, client };
  }

  function lastSentText(client: ReturnType<typeof createMockClient>): string {
    return sentText(client, client.sendMessage.mock.calls.length - 1);
  }

  function sentText(client: ReturnType<typeof createMockClient>, index: number): string {
    const calls = client.sendMessage.mock.calls as unknown as Array<[string, Array<{ text?: string }>, unknown]>;
    const parts = calls[index]?.[1] ?? [];
    return String(parts[parts.length - 1]?.text ?? '');
  }

  function resolvedClient() {
    const client = createMockClient();
    (deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
    (deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    return client;
  }

  it('merges consecutive plain prompts queued during a busy turn into one send', async () => {
    const { gate, client } = connectedClient();
    const first = controller.send('working', []);
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

    await controller.send('more a', []);
    await controller.send('more b', []);
    expect(controller.queuedCount()).toBe(2);

    gate.resolve({ stopReason: 'end_turn' });
    await first;
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
    expect(lastSentText(client)).toBe('more a\n\nmore b');
    expect(controller.queuedCount()).toBe(0);
  });

  it('does not merge slash-like prompts with their neighbours', async () => {
    const { gate, client } = connectedClient();
    const first = controller.send('working', []);
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

    await controller.send('/notacommand half', []);
    await controller.send('second half', []);

    gate.resolve({ stopReason: 'end_turn' });
    await first;
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(3));
    expect(sentText(client, 1)).toBe('/notacommand half');
    expect(sentText(client, 2)).toBe('second half');
  });

  it('renders queue items with a remove button that drops one entry', async () => {
    const el = document.createElement('div');
    controller.queueIndicatorEl = el;
    (controller as unknown as { busy: boolean }).busy = true;

    await controller.send('alpha', []);
    await controller.send('beta', []);

    expect(controller.queuedCount()).toBe(2);
    expect(el.querySelector('.co-ober-queue-text')?.textContent).toBe(t().queue.many.replace('{count}', '2'));
    let items = el.querySelectorAll('.co-ober-queue-item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.co-ober-queue-item-text')?.textContent).toBe('alpha');
    expect(items[0].querySelector('.co-ober-queue-remove')?.getAttribute('aria-label')).toBe(t().queue.remove);

    (items[0].querySelector('.co-ober-queue-remove') as HTMLElement).click();
    expect(controller.queuedCount()).toBe(1);
    items = el.querySelectorAll('.co-ober-queue-item');
    expect(items[0].querySelector('.co-ober-queue-item-text')?.textContent).toBe('beta');

    (controller as unknown as { busy: boolean }).busy = false;
    controller.queueIndicatorEl = null;
  });

  it('hides the indicator once the queue drains empty', async () => {
    const el = document.createElement('div');
    controller.queueIndicatorEl = el;
    (controller as unknown as { busy: boolean }).busy = true;
    await controller.send('alpha', []);
    expect(el.classList.contains('co-ober-visible')).toBe(true);

    (controller as unknown as { busy: boolean }).busy = false;
    await (controller as unknown as { drainQueue: () => Promise<void> }).drainQueue();
    expect(el.classList.contains('co-ober-visible')).toBe(false);
    controller.queueIndicatorEl = null;
  });

  it('derives compact titles from message text', () => {
    expect(deriveSessionTitle('hello   world')).toBe('hello world');
    expect(deriveSessionTitle('x'.repeat(60))).toBe(`${'x'.repeat(47)}…`);
    expect(deriveSessionTitle('/help me')).toBe('');
    expect(deriveSessionTitle('   ')).toBe('');
  });

  function storeWithMessages(messages: Array<{ role: string; content: string }>, title = 'Chat 21:00:00') {
    const rename = vi.fn(() => true);
    const save = vi.fn().mockResolvedValue(undefined);
    deps.sessionStore = {
      ...deps.sessionStore,
      get: vi.fn(() => ({ sessionId: 'auto-1', title, messages })) as unknown as ControllerDeps['sessionStore']['get'],
      rename: rename as unknown as ControllerDeps['sessionStore']['rename'],
      save: save as unknown as ControllerDeps['sessionStore']['save'],
    };
    controller = new CoOberViewController(deps, callbacks);
    controller.state.sessionId = 'auto-1';
    return { rename, save };
  }

  it('auto-titles the session after the first completed exchange', async () => {
    resolvedClient();
    const { rename, save } = storeWithMessages([
      { role: 'user', content: 'Explain the vault setup?', type: 'text', timestamp: 0 },
      { role: 'assistant', content: 'Sure.', type: 'text', timestamp: 1 },
    ] as never);

    await controller.send('Explain the vault setup?', []);

    expect(rename).toHaveBeenCalledWith('auto-1', 'Explain the vault setup?');
    expect(save).toHaveBeenCalled();
  });

  it('leaves the title alone once the conversation has more than one user turn', async () => {
    resolvedClient();
    const { rename } = storeWithMessages([
      { role: 'user', content: 'first', type: 'text', timestamp: 0 },
      { role: 'assistant', content: 'ok', type: 'text', timestamp: 1 },
      { role: 'user', content: 'first', type: 'text', timestamp: 2 },
    ] as never);

    await controller.send('second', []);

    expect(rename).not.toHaveBeenCalled();
  });

  it('waits for the assistant reply before titling', async () => {
    resolvedClient();
    const { rename } = storeWithMessages([
      { role: 'user', content: 'only question so far', type: 'text', timestamp: 0 },
    ] as never);

    await controller.send('only question so far', []);

    expect(rename).not.toHaveBeenCalled();
  });
});
