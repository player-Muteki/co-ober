import { describe, it, expect, beforeEach } from 'vitest';
import { SessionUpdateNormalizer } from './sessionUpdateNormalizer';
import type { SessionUpdate, NormalizedUpdate } from '../types';
import { setLocale, t } from '../i18n/index';

setLocale('en');

describe('SessionUpdateNormalizer', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('aggregates agent_message_chunk correctly', () => {
    const chunk1: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Hello ' },
    };
    const chunk2: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'world!' },
    };

    const norm1 = normalizer.normalize(chunk1);
    expect(norm1).toEqual({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'Hello ',
      accumulatedText: 'Hello ',
    });

    const norm2 = normalizer.normalize(chunk2);
    expect(norm2).toEqual({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: 'world!',
      accumulatedText: 'Hello world!',
    });
  });

  it('isolates different messageIds', () => {
    normalizer.normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'A' },
    });
    const norm = normalizer.normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-2',
      content: { type: 'text', text: 'B' },
    });

    expect(norm).toEqual({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-2',
      chunkText: 'B',
      accumulatedText: 'B',
    });
  });

  it('aggregates agent_thought_chunk and user_message_chunk', () => {
    const thoughtNorm = normalizer.normalize({
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'msg-3',
      content: { type: 'text', text: 'Hmm' },
    });
    expect(thoughtNorm).toEqual({
      kind: 'message_chunk',
      role: 'thought',
      messageId: 'msg-3',
      chunkText: 'Hmm',
      accumulatedText: 'Hmm',
    });

    const userNorm = normalizer.normalize({
      sessionUpdate: 'user_message_chunk',
      messageId: 'msg-4',
      content: { type: 'text', text: 'Hi' },
    });
    expect(userNorm).toEqual({
      kind: 'message_chunk',
      role: 'user',
      messageId: 'msg-4',
      chunkText: 'Hi',
      accumulatedText: 'Hi',
    });
  });

  it('creates and updates a tool call snapshot', () => {
    const init: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Search',
      kind: 'search',
      rawInput: { q: 'test' },
    };
    const update1: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'Result 1' } }],
    };
    const update2: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Result 2' } }],
    };

    const normInit = normalizer.normalize(init);
    expect(normInit).toEqual({
      kind: 'tool_call_snapshot',
      toolCallId: 'tc-1',
      title: 'Search',
      toolKind: 'search',
      status: 'pending',
      rawInput: { q: 'test' },
      contents: [],
    });

    const normUpdate1 = normalizer.normalize(update1);
    expect(normUpdate1).toEqual({
      kind: 'tool_call_snapshot',
      toolCallId: 'tc-1',
      title: 'Search',
      toolKind: 'search',
      status: 'in_progress',
      rawInput: { q: 'test' },
      contents: [{ type: 'content', content: { type: 'text', text: 'Result 1' } }],
    });

    const normUpdate2 = normalizer.normalize(update2);
    expect(normUpdate2).toEqual({
      kind: 'tool_call_snapshot',
      toolCallId: 'tc-1',
      title: 'Search',
      toolKind: 'search',
      status: 'completed',
      rawInput: { q: 'test' },
      contents: [
        { type: 'content', content: { type: 'text', text: 'Result 1' } },
        { type: 'content', content: { type: 'text', text: 'Result 2' } },
      ],
    });
  });

  it('synthesizes a snapshot if tool_call_update arrives before (or without) tool_call', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-unknown',
      status: 'completed',
    });
    expect(norm).toEqual({
      kind: 'tool_call_snapshot',
      toolCallId: 'tc-unknown',
      title: 'tc-unknown',
      toolKind: 'other',
      status: 'completed',
      contents: [],
    });
  });

  it('resets maps properly', () => {
    normalizer.normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: 'Hello' },
    });
    normalizer.normalize({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'T', kind: 'read' });

    normalizer.reset();

    const normMsg = normalizer.normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-1',
      content: { type: 'text', text: ' world' },
    });
    expect(normMsg).toEqual({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-1',
      chunkText: ' world',
      accumulatedText: ' world',
    });

    const normUpdate = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
    });
    // After reset the map is empty, so the orphan update is rebuilt as a
    // terminal snapshot instead of being dropped.
    expect(normUpdate).toEqual({
      kind: 'tool_call_snapshot',
      toolCallId: 'tc-1',
      title: 'tc-1',
      toolKind: 'other',
      status: 'completed',
      contents: [],
    });
  });

  it('maps plan update directly', () => {
    const plan: SessionUpdate = {
      sessionUpdate: 'plan',
      entries: [{ content: 'Do this', status: 'pending', priority: 'high' }],
    };
    expect(normalizer.normalize(plan)).toEqual({
      kind: 'plan',
      entries: [{ content: 'Do this', status: 'pending', priority: 'high' }],
    });
  });

  it('maps config_option_update directly', () => {
    const config: SessionUpdate = { sessionUpdate: 'config_option_update', configOptions: [] };
    expect(normalizer.normalize(config)).toEqual({ kind: 'config_options', configOptions: [] });
  });

  it('maps available_commands_update directly', () => {
    const commands: SessionUpdate = { sessionUpdate: 'available_commands_update', availableCommands: [] };
    expect(normalizer.normalize(commands)).toEqual({ kind: 'commands', commands: [] });
  });

  it('maps usage_update directly', () => {
    const usage: SessionUpdate = { sessionUpdate: 'usage_update', totalTokens: 100, inputTokens: 50, outputTokens: 50 };
    expect(normalizer.normalize(usage)).toEqual({
      kind: 'usage',
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 50,
      thoughtTokens: undefined,
      cost: undefined,
      size: undefined,
      used: undefined,
    });
  });

  it('maps mode and model directly', () => {
    const mode: SessionUpdate = { sessionUpdate: 'current_mode_update', currentModeId: 'test', availableModes: [] };
    expect(normalizer.normalize(mode)).toEqual({ kind: 'mode', currentModeId: 'test', availableModes: [] });

    const model: SessionUpdate = { sessionUpdate: 'current_model_update', currentModelId: 'gpt4', availableModels: [] };
    expect(normalizer.normalize(model)).toEqual({ kind: 'model', currentModelId: 'gpt4', availableModels: [] });
  });

  it('maps session_info_update directly', () => {
    const info: SessionUpdate = {
      sessionUpdate: 'session_info_update',
      sessionId: 's-1',
      title: 'Hello',
      cwd: '/test',
    };
    expect(normalizer.normalize(info)).toEqual({
      kind: 'session_info',
      sessionId: 's-1',
      title: 'Hello',
      cwd: '/test',
    });
  });

  it('normalizeList fans a session_info configOptions carrier into two norms', () => {
    const info: SessionUpdate = {
      sessionUpdate: 'session_info_update',
      title: 'Hello',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [] },
      ],
    };
    expect(normalizer.normalizeList(info)).toEqual([
      { kind: 'session_info', title: 'Hello' },
      { kind: 'config_options', configOptions: info.configOptions },
    ]);
  });

  it('normalizeList keeps plain updates one-for-one', () => {
    expect(normalizer.normalizeList({ sessionUpdate: 'session_info_update', title: 'A' })).toEqual([
      { kind: 'session_info', title: 'A' },
    ]);
    const chunkList = normalizer.normalizeList({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm-1',
      content: { type: 'text', text: 'x' },
    });
    expect(chunkList).toHaveLength(1);
    expect(chunkList[0]?.kind).toBe('message_chunk');
  });

  it('normalizeList drops unknown updates', () => {
    expect(normalizer.normalizeList({ sessionUpdate: 'unknown' } as any)).toEqual([]);
  });

  it('returns null for unknown update', () => {
    expect(normalizer.normalize({ sessionUpdate: 'unknown' } as any)).toBeNull();
  });
});

describe('SessionUpdateNormalizer non-text chunks', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('passes image chunk content through without fabricating text', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg-img',
      content: { type: 'image', mimeType: 'image/png', data: 'AAA' },
    });
    expect(norm).toEqual({
      kind: 'message_chunk',
      role: 'agent',
      messageId: 'msg-img',
      chunkText: '',
      accumulatedText: '',
      content: { type: 'image', mimeType: 'image/png', data: 'AAA' },
    });
  });

  it('keeps text accumulation intact around a non-text chunk', () => {
    normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'a' } });
    normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'audio', mimeType: 'audio/wav', data: 'x' } });
    const norm = normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'b' } });
    expect(norm).toEqual({ kind: 'message_chunk', role: 'agent', messageId: 'm', chunkText: 'b', accumulatedText: 'ab' });
  });

  it('treats a text-typed chunk with missing text as empty', () => {
    const norm = normalizer.normalize({ sessionUpdate: 'user_message_chunk', messageId: 'm2', content: { type: 'text' } });
    expect(norm).toEqual({ kind: 'message_chunk', role: 'user', messageId: 'm2', chunkText: '', accumulatedText: '' });
  });
});

describe('SessionUpdateNormalizer notice, compaction and tool name', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('normalizes notice and compaction updates', () => {
    expect(normalizer.normalize({ sessionUpdate: 'notice_update', level: 'error', message: 'boom' })).toEqual({
      kind: 'notice',
      level: 'error',
      message: 'boom',
    });
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update' })).toEqual({ kind: 'compaction', summary: undefined });
  });

  it('carries the tool name and initial content onto the snapshot', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc',
      title: 'Run',
      name: 'bash',
      content: [{ type: 'content', content: { type: 'text', text: 'in' } }],
    });
    expect(norm).toEqual(
      expect.objectContaining({
        toolName: 'bash',
        contents: [{ type: 'content', content: { type: 'text', text: 'in' } }],
      }),
    );
  });

  it('merges a later name update into the tracked snapshot', () => {
    normalizer.normalize({ sessionUpdate: 'tool_call', toolCallId: 'tc', title: 'T' });
    const upd = normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tc', status: 'completed', name: 'edit' });
    expect(upd).toEqual(expect.objectContaining({ toolName: 'edit', status: 'completed' }));
  });

  it('rebuilds a missing snapshot with the name from the update', () => {
    const upd = normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tc9', status: 'completed', name: 'grep' });
    expect(upd).toEqual(expect.objectContaining({ toolName: 'grep', title: 'tc9' }));
  });
});

describe('SessionUpdateNormalizer v2 compaction state machine', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('pins one boundary at the in_progress frame and suppresses the completion patch', () => {
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'in_progress' })).toEqual({
      kind: 'compaction',
      summary: undefined,
    });
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'completed' })).toBeNull();
  });

  it('pins a completed-only frame when no in_progress preceded it', () => {
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-2', status: 'completed' })).toEqual({
      kind: 'compaction',
      summary: undefined,
    });
  });

  it('surfaces a failed compaction as an error notice and drops cancellations silently', () => {
    normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-3', status: 'in_progress' });
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-3', status: 'failed', error: 'boom' })).toEqual({
      kind: 'notice',
      level: 'error',
      message: 'boom',
    });
    normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-4', status: 'in_progress' });
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-4', status: 'cancelled' })).toBeNull();
  });

  it('falls back to the localized failure message when the frame carries no error text', () => {
    const norm = normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-5', status: 'failed' });
    expect(norm).toEqual({ kind: 'notice', level: 'error', message: t().stream.compactionFailed });
  });

  it('reset() forgets pending compaction ids so a new stream re-pins', () => {
    normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-6', status: 'in_progress' });
    normalizer.reset();
    expect(normalizer.normalize({ sessionUpdate: 'compaction_update', compactionId: 'c-6', status: 'completed' })).toEqual({
      kind: 'compaction',
      summary: undefined,
    });
  });
});

describe('SessionUpdateNormalizer state_update', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('maps the idle end-of-turn usage onto a usage update, dropping non-numbers', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'end_turn',
      usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, used: 30, size: 'huge' },
    });
    expect(norm).toEqual({
      kind: 'usage',
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      thoughtTokens: undefined,
      used: 30,
      size: undefined,
    });
  });

  it('keeps a well-formed cost from the idle usage', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'state_update',
      state: 'idle',
      usage: { totalTokens: 30, cost: { amount: 0.02, currency: 'USD' } },
    });
    expect(norm).toEqual({
      kind: 'usage',
      totalTokens: 30,
      inputTokens: undefined,
      outputTokens: undefined,
      thoughtTokens: undefined,
      used: undefined,
      size: undefined,
      cost: { amount: 0.02, currency: 'USD' },
    });
  });

  it('drops a malformed cost without losing the token counts', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'state_update',
      state: 'idle',
      usage: { totalTokens: 30, cost: { amount: 'free' } },
    });
    expect(norm).toEqual({
      kind: 'usage',
      totalTokens: 30,
      inputTokens: undefined,
      outputTokens: undefined,
      thoughtTokens: undefined,
      used: undefined,
      size: undefined,
      cost: undefined,
    });
  });

  it('ignores running/requires_action and idle frames without usage', () => {
    expect(normalizer.normalize({ sessionUpdate: 'state_update', state: 'running' })).toBeNull();
    expect(normalizer.normalize({ sessionUpdate: 'state_update', state: 'requires_action' })).toBeNull();
    expect(normalizer.normalize({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })).toBeNull();
  });

  it('maps an agent-minted cancelled status to failed, not a false completion', () => {
    const norm = normalizer.normalize({
      sessionUpdate: 'tool_call',
      toolCallId: 't-1',
      title: 'Run command',
      status: 'cancelled',
    });
    expect((norm as { status?: string }).status).toBe('failed');
  });

  it('degrades an unknown status to in_progress on snapshot and patch', () => {
    const snap = normalizer.normalize({
      sessionUpdate: 'tool_call',
      toolCallId: 't-2',
      title: 'Edit',
      status: 'paused_by_policy',
    });
    expect((snap as { status?: string }).status).toBe('in_progress');
    const patch = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't-2',
      status: 'aborted',
    });
    expect((patch as { status?: string }).status).toBe('failed');
  });
});

describe('SessionUpdateNormalizer chunks without messageId', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  const chunk = (sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk', text: string, messageId?: string): SessionUpdate =>
    messageId === undefined
      ? { sessionUpdate, content: { type: 'text', text } }
      : { sessionUpdate, messageId, content: { type: 'text', text } };

  it('keeps one id-less run in a single message under a stable synthetic id', () => {
    const first = normalizer.normalize(chunk('agent_message_chunk', 'Hello ')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    const second = normalizer.normalize(chunk('agent_message_chunk', 'world')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;

    expect(first.messageId).toBeTruthy();
    expect(second.messageId).toBe(first.messageId);
    expect(second.accumulatedText).toBe('Hello world');
  });

  it('starts a new message when the role changes mid-run', () => {
    const agent = normalizer.normalize(chunk('agent_message_chunk', 'answer')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    const thought = normalizer.normalize(chunk('agent_thought_chunk', 'hmm')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;

    expect(thought.messageId).not.toBe(agent.messageId);
    expect(thought.accumulatedText).toBe('hmm');
  });

  it('does not fold a real id into the preceding anonymous run, or the reverse', () => {
    const anonymous = normalizer.normalize(chunk('agent_message_chunk', 'anon ')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    const real = normalizer.normalize(chunk('agent_message_chunk', 'real', 'msg-9')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    const after = normalizer.normalize(chunk('agent_message_chunk', 'trailing')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;

    expect(real.messageId).toBe('msg-9');
    expect(after.messageId).not.toBe(anonymous.messageId);
    expect(after.accumulatedText).toBe('trailing');
  });

  it('numbers successive anonymous runs apart and keeps them unique across instances', () => {
    const runA = normalizer.normalize(chunk('user_message_chunk', 'one')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    normalizer.normalize(chunk('agent_message_chunk', 'two', 'msg-1'));
    const runB = normalizer.normalize(chunk('user_message_chunk', 'three')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    expect(runB.messageId).not.toBe(runA.messageId);

    // A history replay builds its own normalizer; its ids key the same persisted
    // messages, so they must not re-use the live turn's key.
    const runC = new SessionUpdateNormalizer().normalize(chunk('user_message_chunk', 'four')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    expect(runC.messageId).not.toBe(runA.messageId);
    expect(runC.messageId).not.toBe(runB.messageId);
    expect(runC.accumulatedText).toBe('four');
  });

  it('forgets the open run on reset so the next chunk starts clean', () => {
    normalizer.normalize(chunk('agent_message_chunk', 'half '));
    normalizer.reset();
    const after = normalizer.normalize(chunk('agent_message_chunk', 'whole')) as Extract<NormalizedUpdate, { kind: 'message_chunk' }>;
    expect(after.accumulatedText).toBe('whole');
  });
});

describe('a tool call that answers itself in one frame (0.2.5 stage 2)', () => {
  it('keeps the rawOutput the first frame carried', () => {
    const normalizer = new SessionUpdateNormalizer();
    const snapshot = normalizer.normalize({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read notes/idea.md',
      status: 'completed',
      rawOutput: { text: 'the body' },
    } as SessionUpdate) as Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>;

    expect(snapshot.rawOutput).toEqual({ text: 'the body' });
  });

  it('still merges a later frame’s output into it', () => {
    const normalizer = new SessionUpdateNormalizer();
    normalizer.normalize({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Write',
      rawOutput: { bytes: 3 },
    } as SessionUpdate);
    const after = normalizer.normalize({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
      rawOutput: { path: 'a.md' },
    } as SessionUpdate) as Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>;

    expect(after.rawOutput).toEqual({ bytes: 3, path: 'a.md' });
  });
});
