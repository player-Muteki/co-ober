// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CoOberViewController } from './CoOberViewController';
import type { ControllerCallbacks, ControllerDeps } from './CoOberViewController';
import type { AcpResponse, ContextRef, NormalizedUpdate, PromptPart, SerializedMessage } from '../types';
import { setLocale, t } from '../i18n/index';
import { AcpSessionMissingError } from '../client/AcpErrors';
import { readNativeSessionUsage } from '../opencode/NativeSessionReader';

vi.mock('../opencode/NativeSessionReader', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../opencode/NativeSessionReader')>();
	return { ...actual, readNativeSessionUsage: vi.fn().mockResolvedValue(undefined) };
});

setLocale('en');

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
			clear: noop, addUserMessage: noop, addAssistantPlaceholder: noop, removeAssistantPlaceholder: noop,
			appendText: noop, appendThinking: noop, finalizeCurrentThinking: noop, appendInterruptIndicator: noop,
			flushTextRender: vi.fn().mockResolvedValue(undefined),
			addError: noop, showUsage: noop, forceScrollToBottom: noop,
			addToolCall: noop, updateToolCall: noop, setPlanEntries: noop,
			addSystemMessage: vi.fn(),
		} as unknown as ControllerDeps['renderer'],
		input: { setStreaming: noop, focus: noop, appendValue: noop, triggerSend: noop, triggerStop: noop } as unknown as ControllerDeps['input'],
		toolbar: { setSending: noop, updateAgents: noop, updateModels: noop, updateEffort: noop, updatePermission: noop } as unknown as ControllerDeps['toolbar'],
		inlineEditPanel: { clearState: noop, pendingState: null, showDiffFromResponse: noop } as unknown as ControllerDeps['inlineEditPanel'],
		permissionBanner: { dismiss: noop, show: vi.fn() } as unknown as ControllerDeps['permissionBanner'],
		mention: { clear: noop, listAllNotes: vi.fn(() => []), addRef: noop, hasRef: vi.fn(() => false), removeRef: noop } as unknown as ControllerDeps['mention'],
		resolver: { resolveNote: vi.fn() } as unknown as ControllerDeps['resolver'],
		syncEngine: { process: vi.fn() } as unknown as ControllerDeps['syncEngine'],
		sessionStore: {
			get: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }), getOrCreate: vi.fn().mockReturnValue({ messages: [], updatedAt: 0 }), setActive: vi.fn(), save: vi.fn(), load: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), append: vi.fn(),
			sessions: new Map(), activeId: null,
		} as unknown as ControllerDeps['sessionStore'],
		welcomeView: { show: noop, hide: noop, updateStatus: noop } as unknown as ControllerDeps['welcomeView'],
		runtime: {
			settings: {
				maxNoteSize: 8000, syncRules: [], mcpServers: [], defaultAgent: 'build', defaultModel: '',
				defaultEffort: 'default', systemPrompt: '', customAgents: [], customSkills: [],
				activeCustomAgentId: '', commonModels: [], autoScrollEnabled: true,
			},
			getClient: vi.fn(() => null),
			initClient: vi.fn().mockResolvedValue(false),
			getVaultCwd: vi.fn(() => '/vault'),
		} as unknown as ControllerDeps['runtime'],
		updateContextMeter: noop,
		...overrides,
	};
}

function createMockCallbacks(): ControllerCallbacks {
	return {
		onShowWelcome: vi.fn(), onHideWelcome: vi.fn(), onShowReconnectBtn: vi.fn(), onHideReconnectBtn: vi.fn(),
		onShowNewMessagesBtn: vi.fn(), onHideNewMessagesBtn: vi.fn(), onScrollToBottom: vi.fn(), onClearUI: vi.fn(),
		onClearChips: vi.fn(), getPendingImageParts: () => [], onClearPendingImageChips: vi.fn(), onAutoRefActiveFile: vi.fn(),
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
		sendMessage: vi.fn().mockResolvedValue({ stopReason: 'end_turn', usage: { totalTokens: 10, inputTokens: 5, outputTokens: 5 } }),
		cancel: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		closeSession: vi.fn().mockResolvedValue(undefined),
		forkSession: vi.fn().mockResolvedValue('forked-session'),
		resumeSession: vi.fn().mockResolvedValue(undefined),
		getSessionSnapshot: vi.fn(() => ({
			configOptions: [], availableCommands: [], availableModels: [], availableModes: [],
			currentModelId: null, currentModeId: null,
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
			(deps.runtime.getClient as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(null)
				.mockReturnValue(client);
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
			expect(deps.renderer.appendText).toHaveBeenCalledWith('hi there', expect.stringContaining('restore-'), 2000);
			expect(deps.renderer.appendThinking).toHaveBeenCalledWith('thinking...', expect.stringContaining('restore-'), 3000);
		});

		it('routes assistant messages with content blocks to renderStructuredMessage', async () => {
			const renderStructuredMessage = vi.fn();
			deps.renderer = { ...deps.renderer, renderStructuredMessage, appendText: vi.fn() } as unknown as ControllerDeps['renderer'];
			controller.state.sessionId = 'test';
			const structured = {
				role: 'assistant', content: 'hi there', type: 'text', timestamp: 2000,
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
			callbacks.getPendingImageParts = () => images.map(i => ({ type: 'image' as const, mimeType: i.mimeType, data: i.data }));
			callbacks.onClearPendingImageChips = vi.fn();
			controller = new CoOberViewController(deps, callbacks);

			await controller.send('look', []);

			expect(addUserMessage).toHaveBeenCalledWith('look', undefined, images);
			const appendCalls = (deps.sessionStore.append as ReturnType<typeof vi.fn>).mock.calls;
			const userAppend = appendCalls.find(call => call[1]?.role === 'user');
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
				sendMessage: vi.fn()
					.mockImplementationOnce(async (_id: string, _parts: PromptPart[], handler: (update: NormalizedUpdate) => void) => {
						firstHandler = handler;
						return firstResponse.promise;
					})
					.mockImplementationOnce(async (_id: string, _parts: PromptPart[], handler: (update: NormalizedUpdate) => void) => {
						secondHandler = handler;
						return secondResponse.promise;
					}),
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
				cost: 1.5, inputTokens: 10, outputTokens: 5, reasoningTokens: 0,
				cacheReadTokens: 0, cacheWriteTokens: 0,
			});

			await controller.resumeSession('paused-session');

			expect(readNativeSessionUsage).toHaveBeenCalledWith('paused-session');
			expect(controller.state.usage?.cost).toEqual({ amount: 1.5, currency: 'USD' });
			expect(controller.state.usage?.thoughtTokens).toBeUndefined();
			expect(controller.state.usage?.contextTokens).toBeUndefined();
		});
	});

	describe('native session replay adoption', () => {
		function replayingClient() {
			return createMockClient({
				loadSession: vi.fn(async (_id: string, _cwd: string, _mcp: unknown, onReplay?: (u: NormalizedUpdate) => void) => {
					onReplay?.({ kind: 'message_chunk', role: 'user', messageId: 'u1', chunkText: 'question', accumulatedText: 'question' });
					onReplay?.({ kind: 'message_chunk', role: 'thought', messageId: 'a0', chunkText: 'pondering', accumulatedText: 'pondering' });
					onReplay?.({ kind: 'message_chunk', role: 'agent', messageId: 'a1', chunkText: 'hi', accumulatedText: 'hi' });
				}),
			});
		}

		function sharedStore(messages: SerializedMessage[] = []) {
			const shared = {
				sessionId: 'ses_native', title: 'native', opencodeSessionId: 'ses_native',
				messages, createdAt: 0, updatedAt: 0,
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
			expect(deps.renderer.appendText).toHaveBeenCalledWith('hi', expect.anything(), expect.anything());
		});

		it('refreshes cost and context from the native database when adopting', async () => {
			const client = replayingClient();
			(deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			const { override } = sharedStore();
			deps.sessionStore = { ...deps.sessionStore, ...override } as ControllerDeps['sessionStore'];
			const updateContextMeter = vi.fn();
			deps.updateContextMeter = updateContextMeter;
			(readNativeSessionUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
				cost: 0.42, inputTokens: 1000, outputTokens: 200, reasoningTokens: 50,
				cacheReadTokens: 9000, cacheWriteTokens: 0, contextTokens: 32770,
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
					onReplay?.({ kind: 'message_chunk', role: 'agent', messageId: 'a1', chunkText: 'resumed text', accumulatedText: 'resumed text' });
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
		const asstMsg = (content: string): SerializedMessage => ({ role: 'assistant', type: 'text', content, timestamp: 2 });

		function rewindSetup(messages: SerializedMessage[], clientOverrides: Record<string, unknown> = {}) {
			const shared = {
				sessionId: 'old-ses', title: 'rewind', opencodeSessionId: 'old-ses',
				messages, createdAt: 0, updatedAt: 0,
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
			const { shared, store, client, addUserMessage } = rewindSetup([userMsg('q1'), asstMsg('a1'), userMsg('q2'), asstMsg('a2')]);

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
			const historyPart = parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes(t().rewind.contextHeader));
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
			expect(parts.some((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes(t().rewind.contextHeader))).toBe(false);
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
						{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [{ value: 'gpt-4', name: 'GPT-4' }] },
						{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [] },
						{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }] },
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
			expect(parts).toEqual([{ type: 'text', text: expect.stringContaining('You are Co-Ober') }, { type: 'text', text: 'hello' }]);
		});

		it('resolves context refs', async () => {
			(deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'note', content: 'note content' });

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
			expect(parts.some(p => p.type === 'image' && p.mimeType === 'image/png' && p.data === 'aGVsbG8=')).toBe(true);
			expect(callbacks.onClearPendingImageChips).toHaveBeenCalled();
		});

		it('sends text-only parts when no images are pending', async () => {
			const client = createMockClient();
			(deps.runtime.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.runtime.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			await controller.send('hello', []);

			const parts = client.sendMessage.mock.calls[0][1] as PromptPart[];
			expect(parts.every(p => p.type === 'text')).toBe(true);
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
			(deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'note.md', content: 'note content' });
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
});
