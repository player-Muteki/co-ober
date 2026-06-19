import { describe, it, expect } from 'vitest';
import {
  zAgentMessageChunk,
  zAgentThoughtChunk,
  zUserMessageChunk,
  zToolCall,
  zToolCallUpdate,
  zPlan,
  zConfigOptionUpdate,
  zAvailableCommandsUpdate,
  zCurrentModeUpdate,
  zCurrentModelUpdate,
  zSessionInfoUpdate,
  zUsageUpdate,
  zSessionUpdate,
} from './acpSchemas';

const validTextContent = { type: 'text', text: 'hello' };

describe('acpSchemas', () => {
  describe('zAgentMessageChunk', () => {
    it('accepts valid agent_message_chunk', () => {
      const r = zAgentMessageChunk.safeParse({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: validTextContent });
      expect(r.success).toBe(true);
    });

    it('rejects missing messageId', () => {
      const r = zAgentMessageChunk.safeParse({ sessionUpdate: 'agent_message_chunk', content: validTextContent });
      expect(r.success).toBe(false);
    });

    it('rejects wrong sessionUpdate literal', () => {
      const r = zAgentMessageChunk.safeParse({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: validTextContent });
      expect(r.success).toBe(false);
    });
  });

  describe('zAgentThoughtChunk', () => {
    it('accepts valid agent_thought_chunk', () => {
      const r = zAgentThoughtChunk.safeParse({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: validTextContent });
      expect(r.success).toBe(true);
    });
  });

  describe('zUserMessageChunk', () => {
    it('accepts valid user_message_chunk', () => {
      const r = zUserMessageChunk.safeParse({ sessionUpdate: 'user_message_chunk', messageId: 'm1', content: validTextContent });
      expect(r.success).toBe(true);
    });
  });

  describe('zToolCall', () => {
    it('accepts minimal tool_call', () => {
      const r = zToolCall.safeParse({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read' });
      expect(r.success).toBe(true);
    });

    it('accepts tool_call with all optional fields', () => {
      const r = zToolCall.safeParse({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/file.md' },
        locations: [{ path: '/file.md' }],
      });
      expect(r.success).toBe(true);
    });

    it('rejects missing toolCallId', () => {
      const r = zToolCall.safeParse({ sessionUpdate: 'tool_call', title: 'read' });
      expect(r.success).toBe(false);
    });

    it('rejects invalid kind', () => {
      const r = zToolCall.safeParse({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read', kind: 'invalid_kind' });
      expect(r.success).toBe(false);
    });
  });

  describe('zToolCallUpdate', () => {
    it('accepts tool_call_update with completed status', () => {
      const r = zToolCallUpdate.safeParse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        title: 'read',
        kind: 'read',
      });
      expect(r.success).toBe(true);
    });

    it('accepts tool_call_update with rawInput and rawOutput', () => {
      const r = zToolCallUpdate.safeParse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        rawInput: { query: 'test' },
        rawOutput: { result: 'ok' },
      });
      expect(r.success).toBe(true);
    });

    it('rejects invalid status', () => {
      const r = zToolCallUpdate.safeParse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'cancelled' as 'completed',
      });
      expect(r.success).toBe(false);
    });

    it('accepts content array with diff type', () => {
      const r = zToolCallUpdate.safeParse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'diff', path: '/f.md', oldText: 'a', newText: 'b' }],
      });
      expect(r.success).toBe(true);
    });

    it('accepts content array with terminal type', () => {
      const r = zToolCallUpdate.safeParse({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 't1' }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe('zPlan', () => {
    it('accepts plan with entries', () => {
      const r = zPlan.safeParse({
        sessionUpdate: 'plan',
        entries: [{ content: 'step 1', status: 'pending', priority: 'high' }],
      });
      expect(r.success).toBe(true);
    });

    it('accepts empty entries array', () => {
      const r = zPlan.safeParse({ sessionUpdate: 'plan', entries: [] });
      expect(r.success).toBe(true);
    });

    it('rejects missing entries', () => {
      const r = zPlan.safeParse({ sessionUpdate: 'plan' });
      expect(r.success).toBe(false);
    });
  });

  describe('zConfigOptionUpdate', () => {
    it('accepts valid config options', () => {
      const r = zConfigOptionUpdate.safeParse({
        sessionUpdate: 'config_option_update',
        configOptions: [{
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-4',
          options: [{ value: 'gpt-4', name: 'GPT-4' }],
        }],
      });
      expect(r.success).toBe(true);
    });

    it('rejects non-select type', () => {
      const r = zConfigOptionUpdate.safeParse({
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', name: 'M', category: 'model', type: 'checkbox', currentValue: '', options: [] }],
      });
      expect(r.success).toBe(false);
    });
  });

  describe('zAvailableCommandsUpdate', () => {
    it('accepts command list', () => {
      const r = zAvailableCommandsUpdate.safeParse({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'compact the session' }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe('zCurrentModeUpdate', () => {
    it('accepts with currentModeId only', () => {
      const r = zCurrentModeUpdate.safeParse({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
      expect(r.success).toBe(true);
    });

    it('accepts with availableModes only', () => {
      const r = zCurrentModeUpdate.safeParse({
        sessionUpdate: 'current_mode_update',
        availableModes: [{ id: 'plan', name: 'Plan' }],
      });
      expect(r.success).toBe(true);
    });

    it('accepts with all fields', () => {
      const r = zCurrentModeUpdate.safeParse({
        sessionUpdate: 'current_mode_update',
        currentModeId: 'plan',
        availableModes: [{ id: 'plan', name: 'Plan', description: 'Planning mode' }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe('zCurrentModelUpdate', () => {
    it('accepts model update', () => {
      const r = zCurrentModelUpdate.safeParse({
        sessionUpdate: 'current_model_update',
        currentModelId: 'gpt-4',
        availableModels: [{ modelId: 'gpt-4', name: 'GPT-4' }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe('zSessionInfoUpdate', () => {
    it('accepts partial session info', () => {
      const r = zSessionInfoUpdate.safeParse({ sessionUpdate: 'session_info_update', title: 'My Session' });
      expect(r.success).toBe(true);
    });

    it('accepts empty session info', () => {
      const r = zSessionInfoUpdate.safeParse({ sessionUpdate: 'session_info_update' });
      expect(r.success).toBe(true);
    });
  });

  describe('zUsageUpdate', () => {
    it('accepts usage with all fields', () => {
      const r = zUsageUpdate.safeParse({
        sessionUpdate: 'usage_update',
        used: 5000,
        size: 128000,
        totalTokens: 5000,
        inputTokens: 4000,
        outputTokens: 1000,
        thoughtTokens: 200,
        cost: { amount: 0.05, currency: 'USD' },
      });
      expect(r.success).toBe(true);
    });

    it('accepts minimal usage', () => {
      const r = zUsageUpdate.safeParse({ sessionUpdate: 'usage_update' });
      expect(r.success).toBe(true);
    });
  });

  describe('zSessionUpdate (discriminated union)', () => {
    it('validates agent_message_chunk variant', () => {
      const r = zSessionUpdate.safeParse({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: validTextContent });
      expect(r.success).toBe(true);
    });

    it('validates tool_call variant', () => {
      const r = zSessionUpdate.safeParse({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'read' });
      expect(r.success).toBe(true);
    });

    it('validates usage_update variant', () => {
      const r = zSessionUpdate.safeParse({ sessionUpdate: 'usage_update', totalTokens: 100 });
      expect(r.success).toBe(true);
    });

    it('rejects unknown sessionUpdate value', () => {
      const r = zSessionUpdate.safeParse({ sessionUpdate: 'unknown_event' });
      expect(r.success).toBe(false);
    });

    it('rejects missing sessionUpdate key', () => {
      const r = zSessionUpdate.safeParse({});
      expect(r.success).toBe(false);
    });

    it('rejects non-object input', () => {
      const r = zSessionUpdate.safeParse(null);
      expect(r.success).toBe(false);
    });
  });
});
