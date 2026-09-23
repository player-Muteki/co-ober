import { describe, it, expect } from 'vitest';
import { ChatState } from './chatState';

describe('ChatState', () => {
  it('should initialize with default state', () => {
    const state = new ChatState();
    expect(state.sessionId).toBeNull();
    expect(state.isConnected).toBe(false);
    expect(state.isStreaming).toBe(false);
    expect(state.autoScrollEnabled).toBe(true);
    expect(state.usage).toBeNull();
    expect(state.configOptions).toEqual([]);
    expect(state.availableCommands).toEqual([]);
    expect(state.availableModels).toEqual([]);
    expect(state.availableModes).toEqual([]);
    expect(state.currentModelId).toBeNull();
    expect(state.currentModeId).toBeNull();
  });

  it('should reset streaming state', () => {
    const state = new ChatState();
    state.isStreaming = true;

    state.resetStreamingState();

    expect(state.isStreaming).toBe(false);
  });

  it('should clear conversation metadata but keep session identity', () => {
    const state = new ChatState();
    state.sessionId = 's-1';
    state.isConnected = true;
    state.isStreaming = true;
    state.usage = { totalTokens: 10, inputTokens: 5, outputTokens: 5 };
    state.currentModelId = 'gpt-4';
    state.currentModeId = 'code';

    state.clear();

    expect(state.sessionId).toBe('s-1');
    expect(state.isConnected).toBe(true);
    expect(state.isStreaming).toBe(false);
    expect(state.usage).toBeNull();
    expect(state.currentModelId).toBeNull();
    expect(state.currentModeId).toBeNull();
  });

  it('should clear config metadata on clear()', () => {
    const state = new ChatState();
    state.configOptions = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm', options: [] },
    ];
    state.availableCommands = [{ name: 'help', description: 'Show help' }];
    state.availableModels = [{ modelId: 'm', name: 'Model' }];
    state.availableModes = [{ id: 'code', name: 'Code' }];

    state.clear();

    expect(state.configOptions).toEqual([]);
    expect(state.availableCommands).toEqual([]);
    expect(state.availableModels).toEqual([]);
    expect(state.availableModes).toEqual([]);
  });

  it('should reset the plan-refresh gate timestamp on clear()', () => {
    const state = new ChatState();
    expect(state.lastPlanUpdateAt).toBeNull();
    state.lastPlanUpdateAt = 12345;

    state.clear();

    expect(state.lastPlanUpdateAt).toBeNull();
  });
});
