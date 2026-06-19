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
				finalizeCurrentThinking: vi.fn().mockReturnValue(0),
				addToolCall: vi.fn(),
				updateToolCall: vi.fn(),
				collapseToolCall: vi.fn(),
				setPlanEntries: vi.fn(),
				flushThinkingRender: vi.fn().mockResolvedValue(undefined),
				flushTextRender: vi.fn().mockResolvedValue(undefined),
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

	it('handles message_chunk with role agent', () => {
		const session: { messages: Array<{ role: string; content: string; type: string }>; updatedAt: number } = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValue(session);

		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'Hello', accumulatedText: 'Hello' });

		expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
		expect(deps.renderer.appendText).toHaveBeenCalledWith('Hello', 'msg-1');
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Hello', type: 'text' }));

		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: ' world', accumulatedText: 'Hello world' });
		expect(session.messages[0].content).toBe('Hello world');
	});

	it('handles message_chunk with role thought', () => {
		const session = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValue(session);

		controller.handleChunk({ kind: 'message_chunk', role: 'thought', messageId: 'msg-1', chunkText: 'Thinking...', accumulatedText: 'Thinking...' });

		expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
		expect(deps.renderer.appendThinking).toHaveBeenCalledWith('Thinking...', 'msg-1');
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Thinking...', type: 'thinking' }));
	});

	it('handles tool_call_snapshot pending', () => {
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-1', title: 'Search', toolKind: 'search', status: 'pending', rawInput: { q: 'test' }, contents: [] });
		// Pending tool calls are buffered (Phase 4), not rendered immediately
		expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
		// Flushing should render them
		controller.handleChunk({ kind: 'plan', entries: [] });
		expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-1', 'Search', 'search', { q: 'test' }, undefined);
	});

	it('handles tool_call_snapshot completed and processes syncEngine', async () => {
		// Mock tool_call to set kind and input
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-1', title: 'Search', toolKind: 'search', status: 'pending', rawInput: { q: 'test' }, contents: [] });

		const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'Result' } }];
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-1', title: 'Search', toolKind: 'search', status: 'completed', rawInput: { q: 'test' }, rawOutput: { res: 'ok' }, contents: content });

		expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-1', 'completed', { res: 'ok' }, content, { q: 'test' }, undefined, 'search');

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

	it('calls collapseToolCall on completed status (safety net)', () => {
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-c1', title: 'X', toolKind: 'read', status: 'pending', rawInput: {}, contents: [] });
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-c1', title: 'X', toolKind: 'read', status: 'completed', contents: [] });
		expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-c1');
	});

	it('calls collapseToolCall on failed status (safety net)', () => {
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-f1', title: 'X', toolKind: 'read', status: 'pending', rawInput: {}, contents: [] });
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-f1', title: 'X', toolKind: 'read', status: 'failed', contents: [] });
		expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-f1');
	});

	it('calls collapseToolCall on in_progress to failed transition', () => {
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-pf', title: 'X', toolKind: "execute" as any, status: 'in_progress', rawInput: { command: 'sleep' }, contents: [] });
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-pf', title: 'X', toolKind: "execute" as any, status: 'failed', rawOutput: { error: 'timeout' }, contents: [] });
		expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-pf');
	});

	it('handles tool_call_snapshot with sync failure', async () => {
		deps.syncEngine.process.mockResolvedValue([{ rule: { toolName: 'sync' }, error: new Error('Write error') }]);

		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-2', title: 'Sync', toolKind: 'other', status: 'completed', contents: [] });

		await Promise.resolve();
		// The error message uses i18n t().sync.ruleFailed
		expect(deps.onSyncFailure).toHaveBeenCalled();
	});

	it('handles tool_call_snapshot with syncEngine rejection', async () => {
		deps.syncEngine.process.mockRejectedValue(new Error('Fatal error'));
		controller.handleChunk({ kind: 'tool_call_snapshot', toolCallId: 'call-3', title: 'Sync', toolKind: 'other', status: 'completed', contents: [] });

		// Flush microtasks
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(deps.onSyncFailure).toHaveBeenCalledWith('Fatal error');
	});

	it('handles plan chunk', () => {
		controller.handleChunk({ kind: 'plan', entries: [] });
		expect(deps.renderer.setPlanEntries).toHaveBeenCalledWith([]);
	});

	it('handles config_options update', () => {
		controller.handleChunk({ kind: 'config_options', configOptions: [] });
		expect(deps.state.configOptions).toEqual([]);
		expect(deps.onConfigUpdate).toHaveBeenCalledWith([]);
	});

	it('handles available commands update', () => {
		controller.handleChunk({ kind: 'commands', commands: [] });
		expect(deps.state.availableCommands).toEqual([]);
		expect(deps.onCommandsUpdate).toHaveBeenCalledWith([]);
	});

	it('handles usage update', () => {
		controller.handleChunk({ kind: 'usage', totalTokens: 100, inputTokens: 50, outputTokens: 50 });
		expect(deps.state.usage).toEqual({ totalTokens: 100, inputTokens: 50, outputTokens: 50, thoughtTokens: undefined, cost: undefined });
	});

	it('handles mode update', () => {
		controller.handleChunk({ kind: 'mode', currentModeId: 'mode-1', availableModes: [] });
		expect(deps.state.currentModeId).toBe('mode-1');
		expect(deps.state.availableModes).toEqual([]);
		expect(deps.onModeUpdate).toHaveBeenCalledWith('mode-1', []);
	});

	it('handles model update', () => {
		controller.handleChunk({ kind: 'model', currentModelId: 'model-1', availableModels: [] });
		expect(deps.state.currentModelId).toBe('model-1');
		expect(deps.state.availableModels).toEqual([]);
		expect(deps.onModelsUpdate).toHaveBeenCalledWith('model-1', []);
	});

	it('handles session_info', () => {
		const session = { title: 'Old Title' };
		deps.sessionStore.get.mockReturnValue(session);
		controller.handleChunk({ kind: 'session_info', title: 'New Title' });
		expect(session.title).toBe('New Title');
	});

	it('handles session_info with missing sessionId', () => {
		deps.getSessionId.mockReturnValue(null);
		const session = { title: 'Old Title' };
		deps.sessionStore.get.mockReturnValue(session);
		controller.handleChunk({ kind: 'session_info', title: 'New Title' });
		// should safely do nothing
		expect(session.title).toBe('Old Title');
	});

	it('handles message_chunk with role user', () => {
		// Just for branch coverage
		controller.handleChunk({ kind: 'message_chunk', role: 'user', messageId: 'msg-1', chunkText: 'Hello', accumulatedText: 'Hello' });
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
		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'Hello', accumulatedText: 'Hello' });
		expect(deps.sessionStore.getOrCreate).not.toHaveBeenCalled();
	});

	it('saveAssistantChunk handles missing session in store', () => {
		deps.sessionStore.get.mockReturnValue(undefined);
		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'Hello', accumulatedText: 'Hello' });
		// Only check it doesn't crash
		expect(deps.sessionStore.setActive).not.toHaveBeenCalled();
	});

	it('saveAssistantChunk handles missing session in store on subsequent chunks', () => {
		const session = { messages: [], updatedAt: 0 };
		deps.sessionStore.get.mockReturnValueOnce(session);
		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'Hello', accumulatedText: 'Hello' });

		deps.sessionStore.get.mockReturnValueOnce(undefined);
		controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: ' World', accumulatedText: 'Hello World' });
		// Doesn't crash
	});

	it('reset clears pending state and save timer', () => {
		controller.saveMessage('user', 'Hi', 'text');
		controller.reset();
		expect(deps.state.resetStreamingState).toHaveBeenCalled();
	});
});