// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CopsilotViewController } from './copsilotViewController';
import type { ControllerCallbacks, ControllerDeps } from './copsilotViewController';
import { setLocale } from '../i18n/index';

setLocale('en');

function createMockDeps(overrides: Partial<ControllerDeps> = {}): ControllerDeps {
	const noop = vi.fn();
	return {
		renderer: {
			clear: noop, addUserMessage: noop, addAssistantPlaceholder: noop, removeAssistantPlaceholder: noop,
			appendText: noop, appendThinking: noop, addError: noop, showUsage: noop, forceScrollToBottom: noop,
			addToolCall: noop, updateToolCall: noop, setPlanEntries: noop,
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
		plugin: {
			app: { vault: { adapter: { getBasePath: () => '/vault' } } },
			settings: {
				maxNoteSize: 8000, syncRules: [], mcpServers: [], defaultAgent: 'build', defaultModel: '',
				defaultEffort: 'default', systemPrompt: '', customAgents: [], customSkills: [],
				activeCustomAgentId: '', commonModels: [], autoScrollEnabled: true,
			},
			getClient: vi.fn(() => null),
			initClient: vi.fn().mockResolvedValue(false),
		} as unknown as ControllerDeps['plugin'],
		updateContextMeter: noop,
		...overrides,
	};
}

function createMockCallbacks(): ControllerCallbacks {
	return {
		onShowWelcome: vi.fn(), onHideWelcome: vi.fn(), onShowReconnectBtn: vi.fn(), onHideReconnectBtn: vi.fn(),
		onShowNewMessagesBtn: vi.fn(), onHideNewMessagesBtn: vi.fn(), onScrollToBottom: vi.fn(), onClearUI: vi.fn(),
		onClearChips: vi.fn(), onClearPendingImageChips: vi.fn(), onAutoRefActiveFile: vi.fn(),
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

describe('CopsilotViewController', () => {
	let deps: ControllerDeps;
	let callbacks: ReturnType<typeof createMockCallbacks>;
	let controller: CopsilotViewController;

	beforeEach(() => {
		deps = createMockDeps();
		callbacks = createMockCallbacks();
		controller = new CopsilotViewController(deps, callbacks);
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
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			const result = await controller.ensureClientConnected();

			expect(result).toBe(true);
			expect(controller.state.isConnected).toBe(true);
			expect(callbacks.onHideReconnectBtn).toHaveBeenCalled();
			expect(deps.welcomeView.updateStatus).toHaveBeenCalledWith(true);
		});

		it('initializes client when not connected', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(null)
				.mockReturnValue(client);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			const result = await controller.ensureClientConnected();

			expect(result).toBe(true);
			expect(deps.plugin.initClient).toHaveBeenCalled();
			expect(controller.state.isConnected).toBe(true);
		});

		it('returns false and shows reconnect on init failure', async () => {
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

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
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.reconnect();

			expect(controller.state.isConnected).toBe(true);
			expect(deps.welcomeView.updateStatus).toHaveBeenCalledWith(true);
			expect(callbacks.onHideReconnectBtn).toHaveBeenCalled();
		});

		it('throws on failure', async () => {
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

			await expect(controller.reconnect()).rejects.toThrow();
		});
	});

	describe('syncRuntimeSession', () => {
		it('does nothing for null session', async () => {
			await controller.syncRuntimeSession(null);
			expect(deps.plugin.getClient).not.toHaveBeenCalled();
		});

		it('loads session when different from current', async () => {
			const client = createMockClient({ getCurrentSessionId: vi.fn(() => 'other') });
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.syncRuntimeSession('test-session');

			expect(client.loadSession).toHaveBeenCalledWith('test-session', '/vault', []);
		});

		it('skips load when session already current', async () => {
			const client = createMockClient({ getCurrentSessionId: vi.fn(() => 'same') });
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.syncRuntimeSession('same');

			expect(client.loadSession).not.toHaveBeenCalled();
		});
	});

	describe('newSession', () => {
		it('creates session and updates state', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.newSession();

			expect(client.createSession).toHaveBeenCalledWith('/vault', []);
			expect(controller.getSessionId()).toBe('new-session');
			expect(deps.sessionStore.getOrCreate).toHaveBeenCalledWith('new-session');
			expect(deps.sessionStore.setActive).toHaveBeenCalledWith('new-session');
			expect(callbacks.onShowWelcome).toHaveBeenCalled();
			expect(callbacks.onAutoRefActiveFile).toHaveBeenCalled();
		});

		it('does nothing when client fails to connect', async () => {
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(false);

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

			expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('hello', 1000);
			expect(deps.renderer.appendText).toHaveBeenCalledWith('hi there', expect.stringContaining('restore-'), 2000);
			expect(deps.renderer.appendThinking).toHaveBeenCalledWith('thinking...', expect.stringContaining('restore-'), 3000);
		});
	});

	describe('send', () => {
		it('does nothing when busy', async () => {
			// Make the controller busy by sending
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			// First send makes it busy
			await controller.send('first', []);
			// Second send should be ignored
			await controller.send('second', []);

			// createSession called once (from ensureRuntimeSession)
			expect(client.createSession).toHaveBeenCalledTimes(1);
		});

		it('sends message and processes response', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			await controller.send('hello', []);

			expect(callbacks.onHideWelcome).toHaveBeenCalled();
			expect(deps.renderer.addUserMessage).toHaveBeenCalledWith('hello');
			expect(deps.renderer.addAssistantPlaceholder).toHaveBeenCalled();
			expect(client.sendMessage).toHaveBeenCalled();
			expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
			expect(controller.isBusy()).toBe(false);
		});

		it('sends /compact through ACP prompt (not local interception)', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			await controller.send('/compact', []);

			expect(client.sendMessage).toHaveBeenCalled();
		});

		it('handles send errors', async () => {
			const client = createMockClient({
				sendMessage: vi.fn().mockRejectedValue(new Error('network error')),
			});
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.plugin.initClient as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			await controller.send('hello', []);

			expect(deps.renderer.addError).toHaveBeenCalledWith('network error');
			expect(controller.isBusy()).toBe(false);
		});
	});

	describe('stopGeneration', () => {
		it('does nothing when not busy', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			controller.state.sessionId = 'test';

			await controller.stopGeneration();

			expect(client.cancel).not.toHaveBeenCalled();
		});

		it('cancels when busy', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			controller.state.sessionId = 'test-session';
			// Simulate busy state by calling send which sets busy internally
			// We need to intercept during the send, so set busy directly
			Reflect.set(controller, 'busy', true);
			controller.state.isStreaming = true;

			await controller.stopGeneration();

			// Now we only call abort, not cancel
			expect(client.abort).toHaveBeenCalled();
			expect(controller.isBusy()).toBe(false);
			expect(controller.state.isStreaming).toBe(false);
		});
	});

	describe('switchSession', () => {
		it('switches session and restores messages', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			(deps.sessionStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
				messages: [{ role: 'user', content: 'old msg', type: 'text', timestamp: 1000 }],
			});

			await controller.switchSession('target-session');

			expect(controller.getSessionId()).toBe('target-session');
			expect(deps.sessionStore.setActive).toHaveBeenCalledWith('target-session');
			expect(callbacks.onClearUI).toHaveBeenCalled();
			expect(callbacks.onAutoRefActiveFile).toHaveBeenCalled();
		});
	});

	describe('deleteSession', () => {
		it('removes session from store', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.deleteSession('other-session');

			expect(deps.sessionStore.remove).toHaveBeenCalledWith('other-session');
		});

		it('creates new session when deleting active', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);
			controller.state.sessionId = 'active-session';

			await controller.deleteSession('active-session');

			expect(deps.sessionStore.remove).toHaveBeenCalledWith('active-session');
			expect(client.createSession).toHaveBeenCalled();
		});
	});

	describe('forkSession', () => {
		it('forks session and updates state', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.forkSession('source-session');

			expect(client.forkSession).toHaveBeenCalledWith('source-session', '/vault');
			expect(controller.getSessionId()).toBe('forked-session');
			expect(deps.sessionStore.setActive).toHaveBeenCalledWith('forked-session');
		});
	});

	describe('resumeSession', () => {
		it('resumes session and updates state', async () => {
			const client = createMockClient();
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

			await controller.resumeSession('paused-session');

			expect(client.resumeSession).toHaveBeenCalledWith('paused-session', '/vault');
			expect(controller.getSessionId()).toBe('paused-session');
			expect(deps.sessionStore.setActive).toHaveBeenCalledWith('paused-session');
		});
	});

	describe('loadToolbarOptions', () => {
		it('does nothing without client', () => {
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
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
			(deps.plugin.getClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

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

			controller.resetConversationView();

			expect(controller.state.isStreaming).toBe(false);
			expect(controller.state.usage).toBeNull();
			expect(deps.renderer.clear).toHaveBeenCalled();
			expect(callbacks.onClearUI).toHaveBeenCalled();
			expect(callbacks.onClearChips).toHaveBeenCalled();
			expect(callbacks.onClearPendingImageChips).toHaveBeenCalled();
		});
	});

	describe('buildParts', () => {
		it('builds parts with text only', async () => {
			const parts = await controller.buildParts('hello', []);
			expect(parts).toEqual([{ type: 'text', text: expect.stringContaining('Copsilot') }, { type: 'text', text: 'hello' }]);
		});

		it('resolves context refs', async () => {
			(deps.resolver.resolveNote as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'note', content: 'note content' });

			const parts = await controller.buildParts('hello', [{ id: 'n1', type: 'note', name: 'note', path: 'note.md' }]);

			expect(deps.resolver.resolveNote).toHaveBeenCalledWith('note.md');
			expect(parts.length).toBeGreaterThanOrEqual(2);
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
