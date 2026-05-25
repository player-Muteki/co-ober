import { describe, it, expect, vi } from 'vitest';
import { AcpClient, CLIENT_VERSION, buildMcpServers, parseSessionUpdate, extractSessionSnapshot, extractConfigMeta, mergeAvailableCommands } from './acp';
import type { SessionUpdate } from '../types';

describe('parseSessionUpdate', () => {
  it('should return null for empty input', () => {
    expect(parseSessionUpdate(null)).toBeNull();
  });

  it('should return null for non-object input', () => {
    expect(parseSessionUpdate(undefined)).toBeNull();
  });

  it('should return null for missing sessionUpdate field', () => {
    expect(parseSessionUpdate({ foo: 'bar' })).toBeNull();
  });

  it('should parse agent_message_chunk', () => {
    const result = parseSessionUpdate({
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
    const result = parseSessionUpdate({
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
    const result = parseSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'edit file',
      kind: 'edit',
      status: 'pending',
      rawInput: { filePath: 'test.md' },
      locations: [{ path: 'test.md' }],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('tool_call');
    const tc = result as Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>;
    expect(tc.toolCallId).toBe('tc1');
    expect(tc.title).toBe('edit file');
  });

  it('should parse tool_call_update with completion', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc1',
      status: 'completed',
      kind: 'edit',
      title: 'edit file',
      rawInput: { filePath: 'test.md' },
      rawOutput: { output: 'done' },
      content: [{ type: 'diff', path: 'test.md', oldText: 'old', newText: 'new' }],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('tool_call_update');
    const tcu = result as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>;
    expect(tcu.status).toBe('completed');
  });

  it('should parse plan', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('plan');
    const plan = result as Extract<SessionUpdate, { sessionUpdate: 'plan' }>;
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].content).toBe('Step 1');
  });

  it('should parse usage_update', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'usage_update',
      totalTokens: 100,
      inputTokens: 50,
      outputTokens: 45,
      thoughtTokens: 5,
      cost: { amount: 0.002, currency: 'USD' },
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('usage_update');
    const usage = result as Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;
    expect(usage.totalTokens).toBe(100);
    expect(usage.inputTokens).toBe(50);
  });

  it('should parse config_option_update', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [] }],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('config_option_update');
    const cfg = result as Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>;
    expect(cfg.configOptions).toHaveLength(1);
  });

  it('should parse current_mode_update', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'build',
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('current_mode_update');
    const mode = result as Extract<SessionUpdate, { sessionUpdate: 'current_mode_update' }>;
    expect(mode.currentModeId).toBe('build');
  });

  it('should parse session_info_update', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'session_info_update',
      sessionId: 'sid123',
      title: 'My Session',
      cwd: '/vault',
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.sessionUpdate).toBe('session_info_update');
    const info = result as Extract<SessionUpdate, { sessionUpdate: 'session_info_update' }>;
    expect(info.title).toBe('My Session');
  });

  it('should return null for unknown update type', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'unknown_type',
      foo: 'bar',
    });
    expect(result).toBeNull();
  });
});

describe('extractSessionSnapshot', () => {
  it('should handle empty result', () => {
    const snapshot = extractSessionSnapshot({});
    expect(snapshot.availableCommands.length).toBeGreaterThanOrEqual(1);
  });

  it('should apply availableCommands', () => {
    const snapshot = extractSessionSnapshot({
      availableCommands: [
        { name: 'search', description: 'search files' },
        { name: 'compact', description: 'compact session' },
      ],
    });
    expect(snapshot.availableCommands.some((c) => c.name === 'search')).toBe(true);
    expect(snapshot.availableCommands.some((c) => c.name === 'compact')).toBe(true);
  });

  it('should apply configOptions', () => {
    const snapshot = extractSessionSnapshot({
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
    expect(snapshot.currentModelId).toBe('gpt-4');
  });

  it('should apply models from models field', () => {
    const snapshot = extractSessionSnapshot({
      models: {
        currentModelId: 'claude-3',
        availableModels: [{ modelId: 'claude-3', name: 'Claude 3' }],
      },
    });
    expect(snapshot.currentModelId).toBe('claude-3');
  });

  it('should apply modes from modes field', () => {
    const snapshot = extractSessionSnapshot({
      modes: {
        currentModeId: 'plan',
        availableModes: [{ id: 'plan', name: 'Plan' }],
      },
    });
    expect(snapshot.currentModeId).toBe('plan');
  });

  it('should ignore non-object result', () => {
    expect(() => extractSessionSnapshot(null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => extractSessionSnapshot(undefined as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => extractSessionSnapshot('string' as unknown as Record<string, unknown>)).not.toThrow();
  });
});

describe('extractConfigMeta', () => {
  it('should extract model from config options', () => {
    const meta = extractConfigMeta([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'claude-opus',
        options: [{ value: 'claude-opus', name: 'Claude Opus' }],
      },
    ]);
    expect(meta.currentModelId).toBe('claude-opus');
    expect(meta.availableModels).toHaveLength(1);
    expect(meta.availableModels[0].modelId).toBe('claude-opus');
  });

  it('should extract mode from config options', () => {
    const meta = extractConfigMeta([
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [{ value: 'build', name: 'Build', description: 'Execute mode' }],
      },
    ]);
    expect(meta.currentModeId).toBe('build');
    expect(meta.availableModes).toHaveLength(1);
    expect(meta.availableModes[0].id).toBe('build');
  });
});

describe('mergeAvailableCommands', () => {
  it('should deduplicate by name', () => {
    const result = mergeAvailableCommands([
      { name: 'search', description: 'search files' },
      { name: 'search', description: 'duplicate' },
    ]);
    expect(result).toHaveLength(2); // search + compact
    expect(result.filter((c) => c.name === 'search')).toHaveLength(1);
  });

  it('should ensure compact is present', () => {
    const result = mergeAvailableCommands([{ name: 'search', description: 'search' }]);
    expect(result.some((c) => c.name === 'compact')).toBe(true);
  });

  it('should skip empty names', () => {
    const result = mergeAvailableCommands([{ name: '', description: 'empty' }]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('compact');
  });
});

describe('buildMcpServers', () => {
  it('should include enabled servers with command and name', () => {
    const result = buildMcpServers([
      { id: '1', enabled: true, name: ' filesystem ', command: ' npx ', args: [' -y ', '', '@modelcontextprotocol/server-filesystem'] },
    ]);

    expect(result).toEqual([
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: [] },
    ]);
  });

  it('should skip disabled or incomplete servers', () => {
    const result = buildMcpServers([
      { id: '1', enabled: false, name: 'off', command: 'npx', args: [] },
      { id: '2', enabled: true, name: '', command: 'npx', args: [] },
      { id: '3', enabled: true, name: 'empty', command: '', args: [] },
    ]);

    expect(result).toEqual([]);
  });
});

describe('AcpClient session loading', () => {
  it('passes enabled MCP servers when loading a session', async () => {
    const client = new AcpClient('opencode');
    const request = vi.fn().mockResolvedValue({ sessionId: 's1' });
    Reflect.set(client, 'request', request);

    await client.loadSession('s1', '/vault', [
      { id: 'fs', enabled: true, name: ' filesystem ', command: ' npx ', args: [' -y ', '', '@modelcontextprotocol/server-filesystem'] },
      { id: 'off', enabled: false, name: 'disabled', command: 'npx', args: [] },
    ]);

    expect(request).toHaveBeenCalledWith('session/load', {
      sessionId: 's1',
      cwd: '/vault',
      mcpServers: [
        { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: [] },
      ],
    });
    expect(client.getCurrentSessionId()).toBe('s1');
  });
});


describe('AcpClient server request handling', () => {
  it('falls back to a reject decision when permission UI handler fails', async () => {
    const client = new AcpClient('opencode');
    const sent: unknown[] = [];
    Reflect.set(client, 'send', (message: unknown) => {
      sent.push(message);
      return true;
    });
    client.onPermissionRequest = vi.fn().mockRejectedValue(new Error('ui unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    Reflect.get(client, 'handleServerRequest').call(client, {
      method: 'request_permission',
      params: {
        sessionId: 's1',
        toolCall: { kind: 'edit', title: 'Edit file' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    }, 42);
    await flushPromises();

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 42,
        result: { sessionId: 's1', decision: { optionId: 'reject' } },
      },
    ]);
    consoleSpy.mockRestore();
  });

  it('uses the current release version for ACP clientInfo', () => {
    expect(CLIENT_VERSION).toBe('0.0.15');
  });
});


function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
