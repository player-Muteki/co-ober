import { describe, it, expect, beforeEach } from 'vitest';
import { SessionUpdateNormalizer } from './sessionUpdateNormalizer';
import type { SessionUpdate } from '../types';

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
