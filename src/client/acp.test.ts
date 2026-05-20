import { describe, it, expect, beforeEach } from 'vitest';
import { AcpClient } from './acp';

function createClient(): AcpClient {
  return new (AcpClient as any)('opencode');
}

describe('AcpClient', () => {
  describe('parseUpdate', () => {
    let client: AcpClient;

    beforeEach(() => {
      client = createClient();
    });

    it('should return null for empty input', () => {
      const result = (client as any).parseUpdate(null);
      expect(result).toBeNull();
    });

    it('should return null for non-object input', () => {
      const result = (client as any).parseUpdate(undefined);
      expect(result).toBeNull();
    });

    it('should return null for missing sessionUpdate field', () => {
      const result = (client as any).parseUpdate({ foo: 'bar' });
      expect(result).toBeNull();
    });

    it('should parse agent_message_chunk', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg1',
        content: { type: 'text', text: 'hello' },
      });
      expect(result).toEqual({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg1',
        content: { type: 'text', text: 'hello' },
      });
    });

    it('should parse agent_thought_chunk', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'msg2',
        content: { type: 'text', text: 'thinking...' },
      });
      expect(result).toEqual({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'msg2',
        content: { type: 'text', text: 'thinking...' },
      });
    });

    it('should parse tool_call', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'edit file',
        kind: 'edit',
        status: 'pending',
        rawInput: { filePath: 'test.md' },
        locations: [{ path: 'test.md' }],
      });
      expect(result.sessionUpdate).toBe('tool_call');
      expect(result.toolCallId).toBe('tc1');
      expect(result.title).toBe('edit file');
    });

    it('should parse tool_call_update with completion', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        kind: 'edit',
        title: 'edit file',
        rawInput: { filePath: 'test.md' },
        rawOutput: { output: 'done' },
        content: [{ type: 'diff', path: 'test.md', oldText: 'old', newText: 'new' }],
      });
      expect(result.sessionUpdate).toBe('tool_call_update');
      expect(result.status).toBe('completed');
    });

    it('should parse plan', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'plan',
        entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }],
      });
      expect(result.sessionUpdate).toBe('plan');
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].content).toBe('Step 1');
    });

    it('should parse usage_update', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'usage_update',
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 45,
        thoughtTokens: 5,
        cost: { amount: 0.002, currency: 'USD' },
      });
      expect(result.sessionUpdate).toBe('usage_update');
      expect(result.totalTokens).toBe(100);
      expect(result.inputTokens).toBe(50);
    });

    it('should parse config_option_update', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [] }],
      });
      expect(result.sessionUpdate).toBe('config_option_update');
      expect(result.configOptions).toHaveLength(1);
    });

    it('should parse current_mode_update', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      expect(result.sessionUpdate).toBe('current_mode_update');
      expect(result.currentModeId).toBe('build');
    });

    it('should parse session_info_update', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'session_info_update',
        sessionId: 'sid123',
        title: 'My Session',
        cwd: '/vault',
      });
      expect(result.sessionUpdate).toBe('session_info_update');
      expect(result.title).toBe('My Session');
    });

    it('should return null for unknown update type', () => {
      const result = (client as any).parseUpdate({
        sessionUpdate: 'unknown_type',
        foo: 'bar',
      });
      expect(result).toBeNull();
    });
  });

  describe('applySessionSnapshot', () => {
    let client: AcpClient;

    beforeEach(() => {
      client = createClient();
    });

    it('should handle empty result', () => {
      (client as any).applySessionSnapshot({});
      expect((client as any).availableCommands.length).toBeGreaterThanOrEqual(1);
    });

    it('should apply availableCommands', () => {
      (client as any).applySessionSnapshot({
        availableCommands: [
          { name: 'search', description: 'search files' },
          { name: 'compact', description: 'compact session' },
        ],
      });
      const cmds = (client as any).availableCommands as Array<{ name: string }>;
      expect(cmds.some((c: { name: string }) => c.name === 'search')).toBe(true);
      expect(cmds.some((c: { name: string }) => c.name === 'compact')).toBe(true);
    });

    it('should apply configOptions', () => {
      (client as any).applySessionSnapshot({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'gpt-4',
            options: [{ value: 'gpt-4', name: 'GPT-4' }],
          },
        ],
      });
      expect((client as any).currentModelId).toBe('gpt-4');
    });

    it('should apply models from models field', () => {
      (client as any).applySessionSnapshot({
        models: {
          currentModelId: 'claude-3',
          availableModels: [{ modelId: 'claude-3', name: 'Claude 3' }],
        },
      });
      expect((client as any).currentModelId).toBe('claude-3');
    });

    it('should apply modes from modes field', () => {
      (client as any).applySessionSnapshot({
        modes: {
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan' }],
        },
      });
      expect((client as any).currentModeId).toBe('plan');
    });

    it('should ignore non-object result', () => {
      expect(() => (client as any).applySessionSnapshot(null)).not.toThrow();
      expect(() => (client as any).applySessionSnapshot(undefined)).not.toThrow();
      expect(() => (client as any).applySessionSnapshot('string')).not.toThrow();
    });
  });

  describe('applyConfigOptions', () => {
    let client: AcpClient;

    beforeEach(() => {
      client = createClient();
    });

    it('should extract model from config options', () => {
      (client as any).applyConfigOptions([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'claude-opus',
          options: [{ value: 'claude-opus', name: 'Claude Opus' }],
        },
      ]);
      expect((client as any).currentModelId).toBe('claude-opus');
      expect((client as any).availableModels).toHaveLength(1);
      expect((client as any).availableModels[0].modelId).toBe('claude-opus');
    });

    it('should extract mode from config options', () => {
      (client as any).applyConfigOptions([
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'build',
          options: [{ value: 'build', name: 'Build', description: 'Execute mode' }],
        },
      ]);
      expect((client as any).currentModeId).toBe('build');
      expect((client as any).availableModes).toHaveLength(1);
      expect((client as any).availableModes[0].id).toBe('build');
    });
  });
});
