// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamController } from './streamController';

describe('StreamController', () => {
	let deps: any;
	let controller: StreamController;

	beforeEach(() => {
		deps = {
			state: { resetStreamingState: vi.fn(), usage: null, currentModeId: null, availableModes: null, currentModelId: null, availableModels: null, configOptions: null, availableCommands: null },
			renderer: {
				removeAssistantPlaceholder: vi.fn(),
				appendText: vi.fn(),
				appendThinking: vi.fn(),
				addToolCall: vi.fn(),
				updateToolCall: vi.fn(),
				setPlanEntries: vi.fn()
			},
			syncEngine: {
				process: vi.fn().mockResolvedValue([])
			},
			sessionStore: {
				getOrCreate: vi.fn(),
				get: vi.fn(),
				append: vi.fn(),
				setActive: vi.fn(),
				save: vi.fn()
			},
			getSessionId: vi.fn().mockReturnValue('session-1'),
			onConfigUpdate: vi.fn(),
			onModeUpdate: vi.fn(),
			onModelsUpdate: vi.fn(),
			onCommandsUpdate: vi.fn(),
			onSyncFailure: vi.fn()
		};
		controller = new StreamController(deps);
		vi.useFakeTimers();
	});

	it('handles agent_message_chunk', () => {
		const session: { messages: Array<{ role: string; content: string; type: string }>; updatedAt: number } = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValue(session);

		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });

		expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
		expect(deps.renderer.appendText).toHaveBeenCalledWith('Hello', 'msg-1');
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Hello', type: 'text' }));

		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: ' world' } });
		expect(session.messages[0].content).toBe('Hello world');
	});

	it('handles agent_thought_chunk', () => {
		const session = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValue(session);

		controller.handleChunk({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Thinking...' } });

		expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
		expect(deps.renderer.appendThinking).toHaveBeenCalledWith('Thinking...', 'msg-1');
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Thinking...', type: 'thinking' }));
	});

	it('handles tool_call', () => {
		controller.handleChunk({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Search', kind: 'search', rawInput: { q: 'test' } });
		expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-1', 'Search', 'search', { q: 'test' });
	});

	it('handles tool_call_update and processes syncEngine on completion', async () => {
		// Mock tool_call to set kind and input
		controller.handleChunk({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Search', kind: 'search', rawInput: { q: 'test' } });

		const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'Result' } }];
		controller.handleChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: { res: 'ok' }, content });

		expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-1', 'completed', { res: 'ok' }, content);

		expect(deps.syncEngine.process).toHaveBeenCalledWith({
			toolCallId: 'call-1',
			toolName: 'search',
			toolStatus: 'completed',
			rawInput: { q: 'test' },
			rawOutput: { res: 'ok' },
			content: 'Result'
		});

		// Ensure process resolves
		await Promise.resolve();
		expect(deps.onSyncFailure).not.toHaveBeenCalled();
	});

	it('handles tool_call_update with sync failure', async () => {
		controller.handleChunk({ sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'Sync', kind: 'other', rawInput: {} });
		deps.syncEngine.process.mockResolvedValue([{ rule: { toolName: 'sync' }, error: new Error('Write error') }]);

		controller.handleChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed' });

		await Promise.resolve();
		// The error message uses i18n t().sync.ruleFailed
		expect(deps.onSyncFailure).toHaveBeenCalled();
	});

	it('handles tool_call_update with syncEngine rejection', async () => {
		deps.syncEngine.process.mockRejectedValue(new Error('Fatal error'));
		controller.handleChunk({ sessionUpdate: 'tool_call_update', toolCallId: 'call-3', status: 'completed' });

		// Flush microtasks
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(deps.onSyncFailure).toHaveBeenCalledWith('Fatal error');
	});

	it('handles plan chunk', () => {
		controller.handleChunk({ sessionUpdate: 'plan', entries: [] });
		expect(deps.renderer.setPlanEntries).toHaveBeenCalledWith([]);
	});

	it('handles config_option_update', () => {
		controller.handleChunk({ sessionUpdate: 'config_option_update', configOptions: [] });
		expect(deps.state.configOptions).toEqual([]);
		expect(deps.onConfigUpdate).toHaveBeenCalledWith([]);
	});

	it('handles available_commands_update', () => {
		controller.handleChunk({ sessionUpdate: 'available_commands_update', availableCommands: [] });
		expect(deps.state.availableCommands).toEqual([]);
		expect(deps.onCommandsUpdate).toHaveBeenCalledWith([]);
	});

	it('handles usage_update', () => {
		controller.handleChunk({ sessionUpdate: 'usage_update', totalTokens: 100, inputTokens: 50, outputTokens: 50 });
		expect(deps.state.usage).toEqual({ totalTokens: 100, inputTokens: 50, outputTokens: 50, thoughtTokens: undefined, cost: undefined });
	});

	it('handles current_mode_update', () => {
		controller.handleChunk({ sessionUpdate: 'current_mode_update', currentModeId: 'mode-1', availableModes: [] });
		expect(deps.state.currentModeId).toBe('mode-1');
		expect(deps.state.availableModes).toEqual([]);
		expect(deps.onModeUpdate).toHaveBeenCalledWith('mode-1', []);
	});

	it('handles current_model_update', () => {
		controller.handleChunk({ sessionUpdate: 'current_model_update', currentModelId: 'model-1', availableModels: [] });
		expect(deps.state.currentModelId).toBe('model-1');
		expect(deps.state.availableModels).toEqual([]);
		expect(deps.onModelsUpdate).toHaveBeenCalledWith('model-1', []);
	});

	it('handles session_info_update', () => {
		const session = { title: 'Old Title' };
		deps.sessionStore.get.mockReturnValue(session);
		controller.handleChunk({ sessionUpdate: 'session_info_update', title: 'New Title' });
		expect(session.title).toBe('New Title');
	});

	it('handles session_info_update with missing sessionId', () => {
		deps.getSessionId.mockReturnValue(null);
		const session = { title: 'Old Title' };
		deps.sessionStore.get.mockReturnValue(session);
		controller.handleChunk({ sessionUpdate: 'session_info_update', title: 'New Title' });
		// should safely do nothing
		expect(session.title).toBe('Old Title');
	});

	it('handles user_message_chunk', () => {
		// Just for branch coverage
		controller.handleChunk({ sessionUpdate: 'user_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });
	});

	it('saveMessage appends a new message and schedules a save', () => {
		controller.saveMessage('user', 'Hi', 'text');
		expect(deps.sessionStore.append).toHaveBeenCalledWith('session-1', expect.objectContaining({ role: 'user', content: 'Hi', type: 'text' }));
		expect(deps.sessionStore.setActive).toHaveBeenCalledWith('session-1');

		vi.runAllTimers();
		expect(deps.sessionStore.save).toHaveBeenCalled();
	});

	it('saveMessage skips if no sessionId', () => {
		deps.getSessionId.mockReturnValue(null);
		controller.saveMessage('user', 'Hi', 'text');
		expect(deps.sessionStore.append).not.toHaveBeenCalled();
	});

	it('saveAssistantChunk skips if no sessionId', () => {
		deps.getSessionId.mockReturnValue(null);
		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });
		expect(deps.sessionStore.getOrCreate).not.toHaveBeenCalled();
	});

	it('saveAssistantChunk handles missing session in store', () => {
		deps.sessionStore.get.mockReturnValue(undefined);
		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });
		// Only check it doesn't crash
		expect(deps.sessionStore.setActive).not.toHaveBeenCalled();
	});

	it('saveAssistantChunk handles missing session in store on subsequent chunks', () => {
		const session = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValueOnce(session);
		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });

		deps.sessionStore.get.mockReturnValueOnce(undefined);
		controller.handleChunk({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: ' World' } });
		// Doesn't crash
	});

	it('reset clears pending state and save timer', () => {
		controller.saveMessage('user', 'Hi', 'text');
		controller.reset();
		expect(deps.state.resetStreamingState).toHaveBeenCalled();
	});
});
