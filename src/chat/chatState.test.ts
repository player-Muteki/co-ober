import { describe, it, expect } from 'vitest';
import { ChatState } from './chatState';
import type { SerializedMessage } from '../types';

describe('ChatState', () => {
  it('should initialize with default state', () => {
    const state = new ChatState();
    expect(state.sessionId).toBeNull();
    expect(state.isConnected).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state.autoScrollEnabled).toBe(true);
    expect(state.needsAttention).toBe(false);
  });

  it('should add messages', () => {
    const state = new ChatState();
    const msg: SerializedMessage = {
      role: 'user',
      content: 'Hello',
      type: 'text',
      timestamp: Date.now(),
    };
    state.addMessage(msg);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('Hello');
  });

  it('should reset streaming state', () => {
    const state = new ChatState();
    state.isStreaming = true;
    state.currentMessageId = 'msg-1';
    state.currentTextContent = 'partial';
    state.pendingTools.set('tc-1', {
      toolCallId: 'tc-1',
      title: 'test',
      kind: 'read',
      status: 'pending',
      parentEl: null,
    });

    state.resetStreamingState();

    expect(state.isStreaming).toBe(false);
    expect(state.currentMessageId).toBeNull();
    expect(state.currentTextContent).toBe('');
    expect(state.pendingTools.size).toBe(0);
  });

  it('should clear all state', () => {
    const state = new ChatState();
    state.addMessage({ role: 'user', content: 'hi', type: 'text', timestamp: 1 });
    state.usage = { totalTokens: 10, inputTokens: 5, outputTokens: 5 };
    state.currentModelId = 'gpt-4';
    state.lastError = 'oops';
    state.toolCallEls.set('tc-1', { tagName: 'DIV' } as unknown as HTMLDivElement);

    state.clear();

    expect(state.messages).toHaveLength(0);
    expect(state.usage).toBeNull();
    expect(state.currentModelId).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.toolCallEls.size).toBe(0);
    expect(state.planEl).toBeNull();
  });

  it('should clear streaming state on clear()', () => {
    const state = new ChatState();
    state.isStreaming = true;
    state.currentTextContent = 'text';

    state.clear();

    expect(state.isStreaming).toBe(false);
    expect(state.currentTextContent).toBe('');
  });
});
