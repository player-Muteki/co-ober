import { describe, it, expect, beforeEach } from 'vitest';
import { SessionUpdateNormalizer } from './sessionUpdateNormalizer';
import type { SessionUpdate } from '../types';

describe('SessionUpdateNormalizer', () => {
  let normalizer: SessionUpdateNormalizer;

  beforeEach(() => {
    normalizer = new SessionUpdateNormalizer();
  });

  it('aggregates agent_message_chunk correctly', () => {
    const chunk1: SessionUpdate = { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello ' } };
    const chunk2: SessionUpdate = { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'world!' } };

    const norm1 = normalizer.normalize(chunk1);
    expect(norm1).toEqual({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'Hello ', accumulatedText: 'Hello ' });

    const norm2 = normalizer.normalize(chunk2);
    expect(norm2).toEqual({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: 'world!', accumulatedText: 'Hello world!' });
  });

  it('isolates different messageIds', () => {
    normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'A' } });
    const norm = normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-2', content: { type: 'text', text: 'B' } });

    expect(norm).toEqual({ kind: 'message_chunk', role: 'agent', messageId: 'msg-2', chunkText: 'B', accumulatedText: 'B' });
  });

  it('aggregates agent_thought_chunk and user_message_chunk', () => {
    const thoughtNorm = normalizer.normalize({ sessionUpdate: 'agent_thought_chunk', messageId: 'msg-3', content: { type: 'text', text: 'Hmm' } });
    expect(thoughtNorm).toEqual({ kind: 'message_chunk', role: 'thought', messageId: 'msg-3', chunkText: 'Hmm', accumulatedText: 'Hmm' });

    const userNorm = normalizer.normalize({ sessionUpdate: 'user_message_chunk', messageId: 'msg-4', content: { type: 'text', text: 'Hi' } });
    expect(userNorm).toEqual({ kind: 'message_chunk', role: 'user', messageId: 'msg-4', chunkText: 'Hi', accumulatedText: 'Hi' });
  });

  it('creates and updates a tool call snapshot', () => {
    const init: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Search', kind: 'search', rawInput: { q: 'test' } };
    const update1: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'Result 1' } }] };
    const update2: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Result 2' } }] };

    const normInit = normalizer.normalize(init);
    expect(normInit).toEqual({ kind: 'tool_call_snapshot', toolCallId: 'tc-1', title: 'Search', toolKind: 'search', status: 'pending', rawInput: { q: 'test' }, contents: [] });

    const normUpdate1 = normalizer.normalize(update1);
    expect(normUpdate1).toEqual({ kind: 'tool_call_snapshot', toolCallId: 'tc-1', title: 'Search', toolKind: 'search', status: 'in_progress', rawInput: { q: 'test' }, contents: [{ type: 'content', content: { type: 'text', text: 'Result 1' } }] });

    const normUpdate2 = normalizer.normalize(update2);
    expect(normUpdate2).toEqual({ kind: 'tool_call_snapshot', toolCallId: 'tc-1', title: 'Search', toolKind: 'search', status: 'completed', rawInput: { q: 'test' }, contents: [{ type: 'content', content: { type: 'text', text: 'Result 1' } }, { type: 'content', content: { type: 'text', text: 'Result 2' } }] });
  });

  it('returns null if tool_call_update comes before tool_call', () => {
    const norm = normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-unknown', status: 'completed' });
    expect(norm).toBeNull();
  });

  it('resets maps properly', () => {
    normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'Hello' } });
    normalizer.normalize({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'T', kind: 'read' });

    normalizer.reset();

    const normMsg = normalizer.normalize({ sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: ' world' } });
    expect(normMsg).toEqual({ kind: 'message_chunk', role: 'agent', messageId: 'msg-1', chunkText: ' world', accumulatedText: ' world' });

    const normUpdate = normalizer.normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
    expect(normUpdate).toBeNull();
  });

  it('maps plan update directly', () => {
    const plan: SessionUpdate = { sessionUpdate: 'plan', entries: [{ content: 'Do this', status: 'pending', priority: 'high' }] };
    expect(normalizer.normalize(plan)).toEqual({ kind: 'plan', entries: [{ content: 'Do this', status: 'pending', priority: 'high' }] });
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
    expect(normalizer.normalize(usage)).toEqual({ kind: 'usage', totalTokens: 100, inputTokens: 50, outputTokens: 50, thoughtTokens: undefined, cost: undefined, size: undefined, used: undefined });
  });

  it('maps mode and model directly', () => {
    const mode: SessionUpdate = { sessionUpdate: 'current_mode_update', currentModeId: 'test', availableModes: [] };
    expect(normalizer.normalize(mode)).toEqual({ kind: 'mode', currentModeId: 'test', availableModes: [] });

    const model: SessionUpdate = { sessionUpdate: 'current_model_update', currentModelId: 'gpt4', availableModels: [] };
    expect(normalizer.normalize(model)).toEqual({ kind: 'model', currentModelId: 'gpt4', availableModels: [] });
  });

  it('maps session_info_update directly', () => {
    const info: SessionUpdate = { sessionUpdate: 'session_info_update', sessionId: 's-1', title: 'Hello', cwd: '/test' };
    expect(normalizer.normalize(info)).toEqual({ kind: 'session_info', sessionId: 's-1', title: 'Hello', cwd: '/test' });
  });

  it('returns null for unknown update', () => {
    expect(normalizer.normalize({ sessionUpdate: 'unknown' } as any)).toBeNull();
  });
});