// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamController } from './streamController';
import type { NormalizedUpdate } from '../types';
import { setLocale, t } from '../i18n/index';

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
      onPersistFailure: vi.fn(),
      onTitleChanged: vi.fn(),
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

  describe('stamps an interrupt into the transcript, not only the live DOM', () => {
    let session: {
      messages: Array<{ content: string; type: string; contentBlocks?: Array<{ type: string; text?: string }> }>;
      updatedAt: number;
    };

    beforeEach(() => {
      setLocale('en');
      session = { messages: [], updatedAt: 0 };
      deps.sessionStore.get.mockReturnValue(session);
    });

    const answerSoFar = (messageId: string, accumulatedText: string) =>
      controller.handleChunk({
        kind: 'message_chunk', role: 'agent', messageId, chunkText: '', accumulatedText,
      });

    it('appends the badge to the message this turn was writing', () => {
      answerSoFar('m1', 'half an answer');
      controller.persistInterruptMarker();

      expect(session.messages[0].content).toBe('half an answer\n\n*Interrupted*');
      expect(session.messages[0].contentBlocks?.[0]?.text).toBe('half an answer\n\n*Interrupted*');
    });

    it('stamps once, however many stops land on the same message', () => {
      answerSoFar('m1', 'text');
      controller.persistInterruptMarker();
      controller.persistInterruptMarker();

      expect(session.messages[0].content).toBe('text\n\n*Interrupted*');
    });

    it('leaves an older finished answer alone when this turn wrote nothing', () => {
      answerSoFar('m1', 'the first answer');
      controller.beginTurn();
      controller.persistInterruptMarker();

      expect(session.messages[0].content).toBe('the first answer');
    });

    it('skips a message the prune already took out of the transcript', () => {
      answerSoFar('m1', 'text');
      session.messages.length = 0;
      controller.persistInterruptMarker();

      expect(session.messages).toHaveLength(0);
    });

    it('schedules a save so the stamped message reaches disk', async () => {
      answerSoFar('m1', 'text');
      await vi.advanceTimersByTimeAsync(1000);
      deps.sessionStore.save.mockClear();

      controller.persistInterruptMarker();
      await vi.advanceTimersByTimeAsync(1000);

      expect(deps.sessionStore.save).toHaveBeenCalledTimes(1);
    });
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
    // Persisted as the system note it renders as: the placeholder is the client's
    // own protocol complaint, not assistant output. saveMessage('assistant', …)
    // reloaded and exported it under "Assistant", misattributing the line to the
    // agent; paintTranscript/export branch on role, so it must be 'system'.
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'system', type: 'text', content: '[resource content — cannot be shown here]' }),
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
    // Persisted as a system note, not an assistant message: paintTranscript and
    // the transcript export both branch on role, so the assistant role would
    // reload the boundary as an assistant bubble — the opposite of how the live
    // renderer draws it.
    expect(deps.sessionStore.getOrCreate).toHaveBeenCalledWith('session-1');
    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ role: 'system', type: 'text', content: '— Context compacted by the agent —' }),
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
    // Flushing should render them, carrying the status the card was buffered at
    // so a running call shows a spinner the moment it appears.
    controller.handleChunk({ kind: 'plan', entries: [] });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-1', 'Search', 'search', { q: 'test' }, undefined, 'pending');
  });

  describe('a tool call reported in several frames', () => {
    type ToolFrame = Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>;

    const frame = (
      status: 'pending' | 'in_progress' | 'completed',
      over: Partial<ToolFrame> = {},
    ): ToolFrame => ({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-dup',
      title: status === 'pending' ? 'Search' : 'Search a.md',
      toolKind: 'search',
      status,
      rawInput: status === 'pending' ? { q: '' } : { q: 'a.md' },
      contents: [],
      ...over,
    });

    it('draws one card, wearing the newest frame it was told about', () => {
      controller.handleChunk(frame('pending'));
      controller.handleChunk(frame('in_progress'));
      controller.handleChunk(frame('in_progress'));

      controller.handleChunk({ kind: 'plan', entries: [] });

      expect(deps.renderer.addToolCall).toHaveBeenCalledTimes(1);
      // The later frames describe the same call going forward, so they update the
      // buffered copy rather than queueing another card that would freeze at the
      // status it happened to be buffered with.
      expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-dup', 'Search a.md', 'search', { q: 'a.md' }, undefined, 'in_progress');
    });

    it('keeps the single card updatable and leaves one block for a reload to render', () => {
      const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
        messages: [],
        updatedAt: 0,
      };
      deps.sessionStore.get.mockReturnValue(session);

      controller.handleChunk(frame('pending'));
      controller.handleChunk(frame('in_progress'));
      controller.handleChunk(frame('in_progress'));
      controller.handleChunk({ kind: 'plan', entries: [] });

      controller.handleChunk(frame('completed', { rawOutput: { res: 'ok' } }));

      expect(deps.renderer.addToolCall).toHaveBeenCalledTimes(1);
      expect(deps.renderer.updateToolCall).toHaveBeenCalledWith(
        'call-dup',
        'completed',
        { res: 'ok' },
        [],
        { q: 'a.md' },
        undefined,
        'search',
      );

      controller.handleChunk({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'msg-dup',
        chunkText: 'Done',
        accumulatedText: 'Done',
      });
      const toolBlocks = (session.messages[0].contentBlocks ?? []).filter((b) => b.type === 'tool_use');
      expect(toolBlocks).toHaveLength(1);
      expect(toolBlocks[0]).toMatchObject({ toolCallId: 'call-dup', toolStatus: 'completed' });
    });

    it('routes a frame that arrives after its card was drawn onto that card', () => {
      controller.handleChunk(frame('pending'));
      // Any non-tool frame drains the buffer, so the card is on screen and no
      // longer reachable through it.
      controller.handleChunk({ kind: 'plan', entries: [] });
      deps.renderer.addToolCall.mockClear();
      deps.renderer.updateToolCall.mockClear();

      controller.handleChunk(frame('in_progress'));

      expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
      expect(deps.renderer.updateToolCall).toHaveBeenCalledWith(
        'call-dup',
        'in_progress',
        undefined,
        [],
        { q: 'a.md' },
        undefined,
        'search',
      );
    });

    it('leaves a finished call finished when an out-of-order frame arrives late', () => {
      controller.handleChunk(frame('pending'));
      controller.handleChunk(frame('completed'));
      deps.renderer.addToolCall.mockClear();
      deps.renderer.updateToolCall.mockClear();

      controller.handleChunk(frame('in_progress'));

      // Re-opening a step that already reported would draw a second card for it
      // and leave the first one spinning under a finished answer.
      expect(deps.renderer.addToolCall).not.toHaveBeenCalled();
      expect(deps.renderer.updateToolCall).not.toHaveBeenCalled();
    });

    it('still gives two calls in flight their own cards', () => {
      controller.handleChunk(frame('pending'));
      controller.handleChunk({ ...frame('pending'), toolCallId: 'call-other', title: 'Read', toolKind: 'read' });

      controller.handleChunk({ kind: 'plan', entries: [] });

      expect(deps.renderer.addToolCall).toHaveBeenCalledTimes(2);
    });
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

  it('takes the tool text result from whichever slot carries it, not only the first', async () => {
    // A tool that answers with an image before its text leaves the readable
    // result in a later content slot. Reading only slot 0 saw the image, passed
    // content:'' to sync, and the note fell through to rawOutput or "(no output)"
    // — a wrong source the transcript card itself never shows. The sync context
    // must carry the first text block the agent actually sent.
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-text',
      title: 'Look',
      toolKind: 'fetch',
      status: 'pending',
      rawInput: { url: 'x' },
      contents: [],
    });

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-text',
      title: 'Look',
      toolKind: 'fetch',
      status: 'completed',
      rawInput: { url: 'x' },
      contents: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
        { type: 'content', content: { type: 'text', text: 'The page says hello' } },
      ],
    });

    expect(deps.syncEngine.process).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'The page says hello' }),
    );
    await Promise.resolve();
  });

  it('renders a tool call the agent only reports finished', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-late',
      title: 'Run tests',
      toolKind: 'execute',
      status: 'completed',
      rawInput: { cmd: 'npm test' },
      rawOutput: { ok: true },
      contents: [],
    });

    // Cards are made from pending snapshots; an update with no card in front
    // of it had no element to write into, so the step disappeared from the
    // live transcript and from the blocks a reload renders.
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith(
      'call-late',
      'Run tests',
      'execute',
      { cmd: 'npm test' },
      undefined,
    );
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith(
      'call-late',
      'completed',
      { ok: true },
      [],
      { cmd: 'npm test' },
      undefined,
      'execute',
    );

    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-late',
      chunkText: 'done',
      accumulatedText: 'done',
    });
    // The saved turn keeps its tool step: text leads and the tracked blocks
    // follow, so ask that the card landed among them rather than fixing the
    // shape of a block list this controller assembles on purpose.
    expect(session.messages[0]).toEqual(
      expect.objectContaining({
        contentBlocks: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', toolCallId: 'call-late', toolStatus: 'completed' }),
        ]),
      }),
    );
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

  it('takes a reported zero as the reading it is', () => {
    controller.handleChunk({ kind: 'usage', totalTokens: 100, used: 90, size: 200000 });
    // The frame after a compaction says the window is empty. Truthiness threw
    // the zeros away, so the meter kept the figure from before the reading that
    // emptied it, and a free window went on looking nearly full.
    controller.handleChunk({ kind: 'usage', used: 0, size: 0 });
    expect(deps.state.usage).toMatchObject({ contextTokens: 0, contextWindow: 0 });
  });

  it('does not read window occupancy as tokens consumed on the first frame', () => {
    // A usage_update that names `used` but no total is describing how full the
    // context window is, not how many tokens the agent spent. Seeding the
    // token total from it minted a footer figure ("45000 tokens") for work this
    // frame never reported consuming — the merge branch already keeps the two
    // apart, so the seed was the only place occupancy became a cost.
    controller.handleChunk({ kind: 'usage', used: 45000, size: 200000 });
    expect(deps.state.usage).toMatchObject({
      totalTokens: 0,
      contextTokens: 45000,
      contextWindow: 200000,
    });
  });

  it('re-reads a newer token total instead of keeping the first frame’s', () => {
    controller.handleChunk({ kind: 'usage', totalTokens: 100, inputTokens: 50, outputTokens: 50 });
    // A later usage_update that re-reports the totals is a newer reading, not a
    // duplicate. The merge only re-read cost/size/used, so the refreshed
    // figures were thrown away and the footer kept the stale count.
    controller.handleChunk({
      kind: 'usage',
      totalTokens: 180,
      inputTokens: 100,
      outputTokens: 80,
      thoughtTokens: 20,
      used: 200,
      size: 200000,
    });
    expect(deps.state.usage).toMatchObject({
      totalTokens: 180,
      inputTokens: 100,
      outputTokens: 80,
      thoughtTokens: 20,
      contextTokens: 200,
      contextWindow: 200000,
    });
  });

  it('handles mode update', () => {    controller.handleChunk({ kind: 'mode', currentModeId: 'mode-1', availableModes: [] });
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

  it('keeps the modes a frame that named only the current one was about', () => {
    deps.state.availableModes = [{ id: 'plan', name: 'Plan' }];
    // The push out to the toolbar still carries the list that survived, so the
    // selector is re-projected rather than emptied.
    controller.handleChunk({ kind: 'mode', currentModeId: 'plan', availableModes: undefined });
    expect(deps.state.availableModes).toEqual([{ id: 'plan', name: 'Plan' }]);
    expect(deps.onModeUpdate).toHaveBeenCalledWith('plan', [{ id: 'plan', name: 'Plan' }]);
  });

  it('keeps the models a frame that named only the current one was about', () => {
    deps.state.availableModels = [{ modelId: 'claude-2', name: 'Claude 2' }];
    controller.handleChunk({ kind: 'model', currentModelId: 'claude-2', availableModels: undefined });
    expect(deps.state.availableModels).toEqual([{ modelId: 'claude-2', name: 'Claude 2' }]);
    expect(deps.onModelsUpdate).toHaveBeenCalledWith('claude-2', [{ modelId: 'claude-2', name: 'Claude 2' }]);
  });

  it('honours a list an agent says is empty', () => {
    deps.state.availableModes = [{ id: 'plan', name: 'Plan' }];
    // Absence is the only thing that keeps the old list. An agent that answers
    // with no modes at all is correcting the tab, not resting.
    controller.handleChunk({ kind: 'mode', currentModeId: 'build', availableModes: [] });
    expect(deps.state.availableModes).toEqual([]);
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

  describe('an agent-side rename repaints the tab strip (0.2.49 stage A)', () => {
    it('raises onTitleChanged on the successful store-write branch', () => {
      const session = { title: 'Old Title' };
      deps.sessionStore.get.mockReturnValue(session);
      controller.handleChunk({ kind: 'session_info', sessionId: 'sid-1', title: 'Renamed by agent' });

      // `sessionDropdown` reads the store live, `tabDescriptors` reads the
      // snapshot. Without this signal the two adjacent widgets disagree on
      // the same session name until some other code path re-raises it — the
      // exact 0.2.42 stage B / 0.2.47 stage B shape, on the wire-driven
      // mutator the two user-driven fixes left standing.
      expect(deps.onTitleChanged).toHaveBeenCalledWith('sid-1');
    });

    it('does not raise onTitleChanged when the sid is missing', () => {
      deps.getSessionId.mockReturnValue(null);
      controller.handleChunk({ kind: 'session_info', title: 'Renamed' });
      expect(deps.onTitleChanged).not.toHaveBeenCalled();
    });

    it('does not raise onTitleChanged when the store has no such session', () => {
      deps.sessionStore.get.mockReturnValue(undefined);
      controller.handleChunk({ kind: 'session_info', sessionId: 'sid-1', title: 'Renamed' });
      expect(deps.onTitleChanged).not.toHaveBeenCalled();
    });

    it('does not raise onTitleChanged when the chunk carries no title', () => {
      const session = { title: 'Old Title' };
      deps.sessionStore.get.mockReturnValue(session);
      controller.handleChunk({ kind: 'session_info', sessionId: 'sid-1' });
      expect(deps.onTitleChanged).not.toHaveBeenCalled();
      expect(session.title).toBe('Old Title');
    });
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
    // A background turn persisting its own message must not move the
    // conversation the user is looking at.
    expect(deps.sessionStore.setActive).not.toHaveBeenCalled();

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

    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b1', 'Read', 'read', {}, undefined, 'pending');
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b2', 'Search', 'search', {}, undefined, 'in_progress');
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b1', 'failed', { error: t().interrupted.badge });
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b2', 'failed', { error: t().interrupted.badge });

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

  it('finalizeBufferedToolCalls reaches a card that was flushed before the stop', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-drained',
      title: 'Read',
      toolKind: 'read',
      status: 'in_progress',
      rawInput: {},
      contents: [],
    });
    // A plan frame drains the buffer, so the card is on screen and the buffer
    // this method used to work through is empty.
    controller.handleChunk({ kind: 'plan', entries: [] });
    deps.renderer.updateToolCall.mockClear();

    controller.finalizeBufferedToolCalls();

    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-drained', 'failed', { error: t().interrupted.badge });
  });

  it('persists a turn of only tool calls so its cards survive a reload', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-only',
      title: 'Bash',
      toolKind: 'execute',
      status: 'in_progress',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-only',
      title: 'Bash',
      toolKind: 'execute',
      status: 'completed',
      rawInput: {},
      contents: [],
    });

    controller.finalizeBufferedToolCalls();

    expect(deps.sessionStore.append).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        role: 'assistant',
        type: 'tool-call',
        contentBlocks: [expect.objectContaining({ type: 'tool_use', toolCallId: 'call-only', toolStatus: 'completed' })],
      }),
    );
  });

  it('writes the tool-only message once, however many times the turn is finalized', () => {
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-twice',
      title: 'Read',
      toolKind: 'read',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    deps.sessionStore.append.mockClear();

    controller.finalizeBufferedToolCalls();
    controller.finalizeBufferedToolCalls();

    expect(deps.sessionStore.append).toHaveBeenCalledOnce();
  });

  it('attaches a card that surfaced after its answer was written to that answer', () => {
    const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-tail',
      chunkText: 'Working on it',
      accumulatedText: 'Working on it',
    });
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'call-tail',
      title: 'Read',
      toolKind: 'read',
      status: 'in_progress',
      rawInput: {},
      contents: [],
    });
    // Stop arrives with no further chunk to run the sync that normally collects
    // this card onto the message above it.
    controller.finalizeBufferedToolCalls();

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].contentBlocks).toEqual([
      expect.objectContaining({ type: 'text', text: 'Working on it' }),
      expect.objectContaining({ type: 'tool_use', toolCallId: 'call-tail', toolStatus: 'failed' }),
    ]);
    expect(deps.sessionStore.append).not.toHaveBeenCalled();
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

    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('call-b4', 'Read', 'read', {}, undefined, 'pending');
    expect(deps.renderer.updateToolCall).toHaveBeenCalledWith('call-b4', 'failed', { error: t().interrupted.badge });
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
    // Logging it is not enough: the tab has to find out its transcript is missing.
    expect(deps.onPersistFailure).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  describe('a save that resolves without landing still lights the not-saved badge (0.2.48 stage B)', () => {
    // `sessionStore.save` is a thin wrapper on `plugin.savePluginData()`, and
    // 0.2.47 stage A documented that contract as never-rejects — every disk
    // failure is folded into a throttled sticky alarm and the promise
    // resolves the same way whether the write landed or threw. The `.catch`
    // above is therefore decoration for the real path; on a locked
    // `data.json`, a read-only vault, a full disk, the reply stays on screen
    // and the transcript keeps painting as saved. `lastSaveOk` already
    // publishes the truth — this call site has to read it.
    it('fires onPersistFailure when lastSaveOk is false after a resolving save', async () => {
      (deps as { lastSaveOk?: () => boolean | null }).lastSaveOk = () => false;

      controller.saveMessage('user', 'Hi', 'text');
      await vi.runAllTimersAsync();

      expect(deps.sessionStore.save).toHaveBeenCalledOnce();
      expect(deps.onPersistFailure).toHaveBeenCalledOnce();
    });

    it('does not fire onPersistFailure when lastSaveOk is true', async () => {
      // The fix must not trade one lie for another by painting the failure
      // badge on a landed write — a working disk still gets silence.
      (deps as { lastSaveOk?: () => boolean | null }).lastSaveOk = () => true;

      controller.saveMessage('user', 'Hi', 'text');
      await vi.runAllTimersAsync();

      expect(deps.onPersistFailure).not.toHaveBeenCalled();
    });

    it('does not fire onPersistFailure when lastSaveOk is null (no save has been observed)', async () => {
      // The three-state field reserves null for "no save has finished yet" —
      // a first paint on a plugin that has not persisted anything is not a
      // failure the badge can honestly name.
      (deps as { lastSaveOk?: () => boolean | null }).lastSaveOk = () => null;

      controller.saveMessage('user', 'Hi', 'text');
      await vi.runAllTimersAsync();

      expect(deps.onPersistFailure).not.toHaveBeenCalled();
    });

    it('leaves the rejecting-save path firing exactly once, not twice', async () => {
      // The `.catch` fires onPersistFailure for a genuinely rejecting store
      // (a test double or a hand-rolled fake); the new `.then` guard reads
      // lastSaveOk only when save() resolved, so a rejecting save must not
      // also trip the false-flag branch and light the badge twice.
      (deps as { lastSaveOk?: () => boolean | null }).lastSaveOk = () => false;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      deps.sessionStore.save.mockRejectedValueOnce(new Error('disk full'));

      controller.saveMessage('user', 'Hi', 'text');
      await vi.runAllTimersAsync();

      expect(deps.onPersistFailure).toHaveBeenCalledOnce();
      errorSpy.mockRestore();
    });
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
      { role: 'system', content: '[2 messages truncated]', type: 'text', timestamp: 0 },
      ...session.messages.slice(2),
    ];

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'B', accumulatedText: 'AB',
    });

    expect(assistant.content).toBe('AB');
    expect(session.messages.filter((m) => m.content === 'AB')).toHaveLength(1);
    expect(session.messages[1].content).toBe('q2');
  });

  it('recreates a transcript message when a reused messageId follows a prune that dropped it', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'A', accumulatedText: 'A',
    });
    const tracked = session.messages[session.messages.length - 1];
    expect(tracked.content).toBe('A');

    // Retention prune drops the tracked message entirely — the map entry is
    // now detached and must not swallow the next update for this messageId.
    session.messages = [];

    controller.handleChunk({
      kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'B', accumulatedText: 'AB',
    });

    expect(tracked.content).toBe('A');
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('AB');
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

describe('StreamController sub-agent render kind (0.2.50 stage A)', () => {
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
      syncEngine: { process: vi.fn().mockResolvedValue([]) },
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
      onPersistFailure: vi.fn(),
      onTitleChanged: vi.fn(),
    };
    controller = new StreamController(deps);
    vi.useFakeTimers();
  });

  it('routes a task-named call to the Sub-agent kind, live and in the persisted block', () => {
    const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);

    // OpenCode reports a spawned sub-agent as a tool call whose ACP kind is
    // `other` — identical to any uncategorized tool. Only the raw name says
    // `task`. The card must be drawn as a sub-agent off that observed name, and
    // the persisted block must carry the sub-agent kind so a reload agrees.
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'task-1',
      title: 'explore the repo',
      toolName: 'task',
      toolKind: 'other',
      status: 'completed',
      rawInput: { subagent_type: 'explore', description: 'find the auth code' },
      rawOutput: { ok: true },
      contents: [],
    });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith(
      'task-1',
      'explore the repo',
      'subagent',
      { subagent_type: 'explore', description: 'find the auth code' },
      undefined,
    );

    // A following text chunk flushes the turn's blocks onto the message.
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'done',
      accumulatedText: 'done',
    });
    const blocks = (session.messages[session.messages.length - 1].contentBlocks ?? []) as Array<Record<string, unknown>>;
    const taskBlock = blocks.find((b) => b.toolCallId === 'task-1');
    expect(taskBlock?.toolKind).toBe('subagent');
  });

  it('buffers a pending sub-agent under the Sub-agent kind when it flushes', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'sub-1',
      title: 'run tests',
      toolName: 'subagent',
      toolKind: 'other',
      status: 'pending',
      rawInput: { subagent_type: 'runner' },
      contents: [],
    });
    expect(deps.renderer.addToolCall).not.toHaveBeenCalled();

    // A non-tool frame flushes the buffer, drawing the card.
    controller.handleChunk({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'working',
      accumulatedText: 'working',
    });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith(
      'sub-1',
      'run tests',
      'subagent',
      { subagent_type: 'runner' },
      undefined,
      'pending',
    );
  });

  it('leaves an ordinary call at its reported kind', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    // Anti-remerge: the sub-agent branch must not swallow real kinds. A `read`
    // is a `read`, whatever name it carries.
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'read-1',
      title: 'read a.ts',
      toolName: 'read',
      toolKind: 'read',
      status: 'completed',
      rawInput: { file_path: '/a.ts' },
      rawOutput: { ok: true },
      contents: [],
    });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('read-1', 'read a.ts', 'read', { file_path: '/a.ts' }, undefined);
  });

  // 0.2.50 stage A follow-up: OpenCode re-sends `raw.name` on the first
  // snapshot and omits it on later frames, so a per-frame re-derivation
  // dropped a settled sub-agent back to the `other` look the raw ACP kind
  // collapses to — live and, through the persisted block, on reload. The
  // kind a frame already certified must outlive a frame that forgot the name.
  it('keeps the sub-agent kind when a settle frame drops the tool name', () => {
    const session: { messages: Array<{ contentBlocks?: Array<Record<string, unknown>> }>; updatedAt: number } = {
      messages: [],
      updatedAt: 0,
    };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'task-1',
      title: 'explore',
      toolName: 'task',
      toolKind: 'other',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    // Flush the buffer: the card is drawn as a sub-agent from the name it saw.
    controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'm1', chunkText: 'go', accumulatedText: 'go' });
    expect(deps.renderer.addToolCall).toHaveBeenCalledWith('task-1', 'explore', 'subagent', {}, undefined, 'pending');

    (deps.renderer.updateToolCall as ReturnType<typeof vi.fn>).mockClear();
    // The completing frame carries no name — the only signal that said `task`.
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'task-1',
      title: 'explore',
      toolKind: 'other',
      status: 'completed',
      rawOutput: { ok: true },
      contents: [],
    });

    // Live: the card is not repainted as a plain `other` call.
    const lastUpdate = (deps.renderer.updateToolCall as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[];
    expect(lastUpdate[lastUpdate.length - 1]).toBe('subagent');

    // Reload: the persisted block still says `subagent`, so the restored card
    // agrees with the live one instead of silently reverting.
    controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'm2', chunkText: 'x', accumulatedText: 'x' });
    const blocks = (session.messages.at(-1)?.contentBlocks ?? []) as Array<Record<string, unknown>>;
    expect(blocks.find((b) => b.toolCallId === 'task-1')?.toolKind).toBe('subagent');
  });

  it('keeps the sub-agent kind through an in-progress update that drops the name', () => {
    const session: { messages: Array<Record<string, unknown>>; updatedAt: number } = { messages: [], updatedAt: 0 };
    deps.sessionStore.get.mockReturnValue(session);

    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'task-2',
      title: 'explore',
      toolName: 'task',
      toolKind: 'other',
      status: 'pending',
      rawInput: {},
      contents: [],
    });
    controller.handleChunk({ kind: 'message_chunk', role: 'agent', messageId: 'm1', chunkText: 'go', accumulatedText: 'go' });

    (deps.renderer.updateToolCall as ReturnType<typeof vi.fn>).mockClear();
    // A mid-stream update with no name — the surfaced card must stay a sub-agent.
    controller.handleChunk({
      kind: 'tool_call_snapshot',
      toolCallId: 'task-2',
      title: 'explore',
      toolKind: 'other',
      status: 'in_progress',
      rawInput: {},
      contents: [],
    });
    const lastUpdate = (deps.renderer.updateToolCall as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[];
    expect(lastUpdate[lastUpdate.length - 1]).toBe('subagent');
  });
});
