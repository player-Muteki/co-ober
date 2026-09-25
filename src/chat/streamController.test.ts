// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamController } from './streamController';
import { setLocale } from '../i18n/index';

describe('StreamController', () => {
  let deps: any;
  let controller: StreamController;

  beforeEach(() => {
    deps = {
      state: {
        resetStreamingState: vi.fn(),
        usage: null,
        currentModeId: null,
        availableModes: null,
        currentModelId: null,
        availableModels: null,
        configOptions: null,
        availableCommands: null,
      },
      renderer: {
        removeAssistantPlaceholder: vi.fn(),
        appendText: vi.fn(),
        appendThinking: vi.fn(),
        appendAssistantImage: vi.fn(),
        finalizeCurrentThinking: vi.fn().mockReturnValue(0),
        addToolCall: vi.fn(),
        updateToolCall: vi.fn(),
        collapseToolCall: vi.fn(),
        setPlanEntries: vi.fn(),
        addSystemMessage: vi.fn(),
        flushThinkingRender: vi.fn().mockResolvedValue(undefined),
        flushTextRender: vi.fn().mockResolvedValue(undefined),
      },
      syncEngine: {
        process: vi.fn().mockResolvedValue([]),
      },
      sessionStore: {
        getOrCreate: vi.fn(),
        get: vi.fn(),
        append: vi.fn(),
        setActive: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
      },
      getSessionId: vi.fn().mockReturnValue('session-1'),
      onConfigUpdate: vi.fn(),
      onModeUpdate: vi.fn(),
      onModelsUpdate: vi.fn(),
      onCommandsUpdate: vi.fn(),
      onSyncFailure: vi.fn(),
    };
    controller = new StreamController(deps);
    vi.useFakeTimers();
  });

  it('handles message_chunk with role agent', () => {
    const session: { messages: Array<{ role: string; content: string; type: string }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });

    expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
    expect(deps.renderer.appendText).toHaveBeenCalledWith('Hello', 'msg-1');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual(expect.objectContaining({ role: 'assistant', content: 'Hello', type: 'text' }));

    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: ' world',
      accumulatedText: 'Hello world',
    });
    expect(session.messages[0].content).toBe('Hello world');
  });

  it('renders an image chunk through appendAssistantImage and persists it as an image block', () => {
    const session = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-img',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'image', mimeType: 'image/png', data: 'AAA' },
    });

    expect(deps.renderer.appendAssistantImage).toHaveBeenCalledWith('image/png', 'AAA');
    expect(deps.renderer.appendText).not.toHaveBeenCalled();
    expect(session.messages).toHaveLength(0);
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'assistant',
        contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }],
      }),
    );
  });

  it('dedupes a redelivered image frame so the base64 blob is stored once', () => {
    const frame = {
      kind: 'message_chunk' as const,
      role: 'agent' as const,
      messageId: 'msg-dup',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'image', mimeType: 'image/png', data: 'REPELLED-BLOB' },
    };
    controller.handleChunk(frame);
    controller.handleChunk(frame);
    const imageAppends = deps.sessionStore.append.mock.calls.filter((call: unknown[]) => {
      const blocks = (call[1] as { contentBlocks?: Array<{ type?: string }> }).contentBlocks;
      return Array.isArray(blocks) && blocks[0]?.type === 'image';
    });
    expect(imageAppends).toHaveLength(1);
  });

  it('persistSystemNote writes a system-role line and schedules a save', () => {
    controller.persistSystemNote('— Turn stopped: tool_calls —');
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'system', content: '— Turn stopped: tool_calls —', type: 'text' }),
    );
    expect(deps.sessionStore.getOrCreate).toHaveBeenCalledWith('session-1');
  });

  it('persistSystemNote is a no-op without a session id', () => {
    deps.getSessionId.mockReturnValueOnce(null);
    controller.persistSystemNote('orphan');
    expect(deps.sessionStore.append).not.toHaveBeenCalled();
  });

  it('persists a visible placeholder once per message and type for non-image, non-text chunks', () => {
    setLocale('en');
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-res',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'resource' },
    });
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-res',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'resource' },
    });
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'thought',
      messageId: 'msg-res',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'resource' },
    });

    expect(deps.renderer.addSystemMessage).toHaveBeenCalledTimes(1);
    expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith('[resource content — cannot be shown here]');
    expect(deps.sessionStore.append).toHaveBeenCalledTimes(1);
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'assistant', type: 'text', content: '[resource content — cannot be shown here]' }),
    );
    expect(deps.renderer.appendText).not.toHaveBeenCalled();
    expect(deps.renderer.appendThinking).not.toHaveBeenCalled();
    expect(deps.renderer.appendAssistantImage).not.toHaveBeenCalled();
  });

  it('renders notice updates as system messages with a level label', () => {
    setLocale('en');
    controller.handleChunk({ kind: 'notice', level: 'warning', message: 'Rate limited' });
    expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith('Warning: Rate limited');

    controller.handleChunk({ kind: 'notice', level: 'info', message: 'FYI' });
    expect(deps.renderer.addSystemMessage).toHaveBeenLastCalledWith('FYI');
    expect(deps.sessionStore.append).not.toHaveBeenCalled();
  });

  it('renders and persists a compaction boundary block', () => {
    setLocale('en');
    controller.handleChunk({ kind: 'compaction' });

    expect(deps.renderer.addSystemMessage).toHaveBeenCalledWith('— Context compacted by the agent —');
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'assistant', type: 'text', content: '— Context compacted by the agent —' }),
    );
  });

  it('handles message_chunk with role thought', () => {
    const session = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'message_chunk',
      role: 'thought',
      messageId: 'msg-1',
      chunkText: 'Thinking...',
      accumulatedText: 'Thinking...',
    });

    expect(deps.renderer.removeAssistantPlaceholder).toHaveBeenCalled();
    expect(deps.renderer.appendThinking).toHaveBeenCalledWith('Thinking...', 'msg-1');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual(
      expect.objectContaining({ role: 'assistant', content: 'Thinking...', type: 'thinking' }),
    );
  });

  it('handles tool_call_snapshot pending', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-1',
      title: 'Search',
      toolKind: 'search',
      status: 'pending',
      rawInput: { q: 'test' },
      contents: [],
    });
    // Pending tool calls are buffered (Phase 4), not rendered immediately
    expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
    // Flushing should render them
    controller.handleChunk({ kind: 'plan', entries: [] });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-1', 'Search', 'search', { q: 'test' }, undefined);
  });

  it('handles tool_call_snapshot completed and processes syncEngine', async () => {
    // Mock tool_call to set kind and input
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-1',
      title: 'Search',
      toolKind: 'search',
      status: 'pending',
      rawInput: { q: 'test' },
      contents: [],
    });

    const content = [{ type: 'content' as const, content: { type: 'text' as const, text: 'Result' } }];
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-1',
      title: 'Search',
      toolKind: 'search',
      status: 'completed',
      rawInput: { q: 'test' },
      rawOutput: { res: 'ok' },
      contents: content,
    });

    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith(
      'call-1',
      'completed',
      { res: 'ok' },
      content,
      { q: 'test' },
      undefined,
      'search',
    );

    expect(deps.syncEngine.process).toHaveBeenCalledWith({
      toolCallId: 'call-1',
      toolName: 'search',
      toolStatus: 'completed',
      rawInput: { q: 'test' },
      rawOutput: { res: 'ok' },
      content: 'Result',
    });

    // Ensure process resolves
    await Promise.resolve();
    expect(deps.onSyncFailure).not.toHaveBeenCalled();
  });

  it('calls collapseToolCall on completed status (safety net)', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-c1',
      title: 'X',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-c1',
      title: 'X',
      toolKind: 'read',
      status: 'completed',
      contents: [],
    });
    expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-c1');
  });

  it('calls collapseToolCall on failed status (safety net)', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-f1',
      title: 'X',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-f1',
      title: 'X',
      toolKind: 'read',
      status: 'failed',
      contents: [],
    });
    expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-f1');
  });

  it('calls collapseToolCall on in_progress to failed transition', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-pf',
      title: 'X',
      toolKind: 'execute' as any,
      status: 'in_progress',
      rawInput: { command: 'sleep' },
      contents: [],
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-pf',
      title: 'X',
      toolKind: 'execute' as any,
      status: 'failed',
      rawOutput: { error: 'timeout' },
      contents: [],
    });
    expect(deps.renderer.collapseToolCall).toHaveBeenCalledWith('call-pf');
  });

  it('handles tool_call_snapshot with sync failure', async () => {
    deps.syncEngine.process.mockResolvedValue([{ rule: { toolName: 'sync' }, error: new Error('Write error') }]);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-2',
      title: 'Sync',
      toolKind: 'other',
      status: 'completed',
      contents: [],
    });

    await Promise.resolve();
    // The error message uses i18n t().sync.ruleFailed
    expect(deps.onSyncFailure).toHaveBeenCalled();
  });

  it('handles tool_call_snapshot with syncEngine rejection', async () => {
    deps.syncEngine.process.mockRejectedValue(new Error('Fatal error'));
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-3',
      title: 'Sync',
      toolKind: 'other',
      status: 'completed',
      contents: [],
    });

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
    expect(deps.state.usage).toEqual({
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      thoughtTokens: undefined,
      cost: undefined,
    });
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
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'user',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });
  });

  it('persists tool blocks with metadata and updates status in place on completion', () => {
    const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-1',
      title: 'Search',
      toolKind: 'search',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });

    const blocks = session.messages[0].contentBlocks;
    expect(blocks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', toolCallId: 'call-1', toolTitle: 'Search', toolKind: 'search', toolStatus: 'pending' },
    ]);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-1',
      title: 'Search',
      toolKind: 'search',
      status: 'completed',
      contents: [],
    });
    expect(session.messages[0].contentBlocks![1]).toMatchObject({
      type: 'tool_use',
      toolCallId: 'call-1',
      toolStatus: 'completed',
    });
  });

  it('saveMessage appends a new message and schedules a save', () => {
    controller.saveMessage('user', 'Hi', 'text');
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'user', content: 'Hi', type: 'text' }),
    );
    expect(deps.sessionStore.setActive).toHaveBeenCalledWith('session-1');

    vi.runAllTimers();
    expect(deps.sessionStore.save).toHaveBeenCalled();
  });

  it('saveMessage stores image attachments on the persisted message', () => {
    const images = [{ mimeType: 'image/png', data: 'AAA=' }];
    controller.saveMessage('user', 'Hi', 'text', undefined, images);
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'user',
        content: 'Hi',
        type: 'text',
        images,
      }),
    );
  });

  it('saveMessage skips if no sessionId', () => {
    deps.getSessionId.mockReturnValue(null);
    controller.saveMessage('user', 'Hi', 'text');
    expect(deps.sessionStore.append).not.toHaveBeenCalled();
  });

  it('saveAssistantChunk skips if no sessionId', () => {
    deps.getSessionId.mockReturnValue(null);
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });
    expect(deps.sessionStore.getOrCreate).not.toHaveBeenCalled();
  });

  it('saveAssistantChunk handles missing session in store', () => {
    deps.sessionStore.get.mockReturnValue(undefined);
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });
    // Only check it doesn't crash
    expect(deps.sessionStore.setActive).not.toHaveBeenCalled();
  });

  it('saveAssistantChunk handles missing session in store on subsequent chunks', () => {
    const session = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValueOnce(session);
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello',
      accumulatedText: 'Hello',
    });

    deps.sessionStore.get.mockReturnValueOnce(undefined);
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: ' World',
      accumulatedText: 'Hello World',
    });
    // Doesn't crash
  });

  it('finalizeBufferedToolCalls flushes pending tools and marks them failed', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-b1',
      title: 'Read',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-b2',
      title: 'Search',
      toolKind: 'search',
      status: 'in_progress',
      rawInput: {},
      contents: [],
    });

    controller.finalizeBufferedToolCalls();

    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b1', 'Read', 'read', {}, undefined);
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b2', 'Search', 'search', {}, undefined);
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b1', 'failed');
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b2', 'failed');

    // Buffer is emptied — a second call is a no-op
    deps.renderer.addToolCall.mockClear();
    controller.finalizeBufferedToolCalls();
    expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
  });

  it('finalizeBufferedToolCalls marks persisted tool blocks failed', () => {
    const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-b3',
      title: 'Read',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.finalizeBufferedToolCalls();
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Done',
      accumulatedText: 'Done',
    });

    const toolBlock = session.messages[0].contentBlocks?.find((b) => b.type === 'tool_use');
    expect(toolBlock).toMatchObject({ toolCallId: 'call-b3', toolStatus: 'failed' });
  });

  it('reset() finalizes buffered tool calls before clearing state', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-b4',
      title: 'Read',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });

    controller.reset();

    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b4', 'Read', 'read', {}, undefined);
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b4', 'failed');
    expect(deps.state.resetStreamingState).toHaveBeenCalled();
  });

  it('reset preserves a pending save', () => {
    controller.saveMessage('user', 'Hi', 'text');
    controller.reset();
    vi.runAllTimers();

    expect(deps.state.resetStreamingState).toHaveBeenCalled();
    expect(deps.sessionStore.save).toHaveBeenCalledOnce();
  });

  it('flushes a pending save when disposed', async () => {
    controller.saveMessage('user', 'Hi', 'text');

    await controller.dispose();

    expect(deps.sessionStore.save).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(deps.sessionStore.save).toHaveBeenCalledOnce();
  });

  it('handles background save failures', async () => {
    const error = new Error('disk full');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.sessionStore.save.mockRejectedValueOnce(error);

    controller.saveMessage('user', 'Hi', 'text');
    await vi.runAllTimersAsync();

    expect(errorSpy).toHaveBeenCalledWith('[co-ober] save session:', error);
    errorSpy.mockRestore();
  });

  it('stamps streamed plan updates on state (post-turn refresh gate)', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));

    controller.handleChunk({
      kind: 'plan',
      entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }],
    });

    expect(deps.renderer.setPlanEntries).toHaveBeenCalledTimes(1);
    expect(deps.state.lastPlanUpdateAt).toBe(Date.now());
  });

  it('does not schedule saves after dispose', async () => {
    controller.saveMessage('user', 'first', 'text');
    await controller.dispose(); // flushes the pending save (1 call)

    controller.saveMessage('user', 'late', 'text');
    vi.runAllTimers();

    // dispose's own flush is the only save; the late message schedules none.
    expect(deps.sessionStore.save).toHaveBeenCalledOnce();
  });

  it('lands chunk updates on the right message after prune rewrites the array', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);
    for (let i = 0; i < 3; i++) {
      session.messages.push({ role: 'user', content: `q${i}`, type: 'text', timestamp: i });
    }

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'A', accumulatedText: 'A',
    });
    const assistant = session.messages[3];

    // Prune rewrites session.messages (marker inserted, head dropped):
    // every cached numeric index shifts by one from here on.
    session.messages = [
      { role: 'system', content: '[2 earlier messages truncated]', type: 'text', timestamp: 0 },
      ...session.messages.slice(2),
    ];

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'B', accumulatedText: 'AB',
    });

    expect(assistant.content).toBe('AB');
    expect(session.messages.filter((m) => m.content === 'AB')).toHaveLength(1);
    expect(session.messages[1].content).toBe('q2');
  });

  it('beginTurn keeps tool calls from an interrupted turn out of the next message', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'A', accumulatedText: 'A',
    });
    // Pending when the user hit Stop: genId bumped, the finally-block
    // finalize never ran, so the buffer still carries the ghost.
    controller.handleChunk({
      kind: 'tool_call_snapshot', toolCallId: 'call-ghost', title: 'Search', toolKind: 'search',
      status: 'pending', rawInput: {}, contents: [],
    });

    controller.beginTurn();

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-2', chunkText: 'B', accumulatedText: 'B',
    });

    expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
    const second = session.messages[1];
    const blocks = (second.contentBlocks ?? []) as Array<Record<string, unknown>>;
    expect(blocks.every((b) => b.type !== 'tool_use')).toBe(true);
  });
});
