import { AcpProtocolError, AcpSessionMissingError } from './AcpErrors';
import { describe, it, expect, vi } from 'vitest';
import pkg from '../../package.json';
import {
  AcpClient,
  CLIENT_VERSION,
  buildMcpServers,
  normalizeAgentCapabilities,
  normalizeAuthMethods,
  parseSessionUpdate,
  extractSessionSnapshot,
  extractConfigMeta,
  mergeAvailableCommands,
} from './acp';
import { AcpRequestHandler } from './AcpRequestHandler';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import type { NormalizedUpdate, SessionUpdate } from '../types';

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
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [] },
      ],
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

  it('should coerce v2-alpha plan_update items into a plan update', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'plan_update',
      plan: {
        type: 'items',
        id: 'plan-1',
        entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }],
      },
    });
    expect(result).toEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }],
    });
  });

  it('should ignore plan_update variants we cannot render yet', () => {
    expect(parseSessionUpdate({ sessionUpdate: 'plan_update', plan: { type: 'markdown', text: '# hi' } })).toBeNull();
    expect(parseSessionUpdate({ sessionUpdate: 'plan_update', plan: { type: 'items' } })).toBeNull();
    expect(parseSessionUpdate({ sessionUpdate: 'plan_update', plan: { type: 'removal' } })).toBeNull();
  });

  it('should parse session_info_update carrying configOptions', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'session_info_update',
      title: 'Renamed',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [] },
      ],
    });
    expect(result).not.toBeNull();
    if (!result) return;
    const info = result as Extract<SessionUpdate, { sessionUpdate: 'session_info_update' }>;
    expect(info.title).toBe('Renamed');
    expect(info.configOptions).toHaveLength(1);
  });

  it('should return null for unknown update type', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'unknown_type',
      foo: 'bar',
    });
    expect(result).toBeNull();
  });
});

describe('dispatchSessionUpdate v2-alpha pre-layer', () => {
  function clientWithStream(sid: string): { client: AcpClient; norms: NormalizedUpdate[] } {
    const client = new AcpClient('opencode');
    const norms: NormalizedUpdate[] = [];
    const streams = Reflect.get(client, 'activeStreams') as Map<string, { handler: (u: NormalizedUpdate) => void; abort: AbortController }>;
    streams.set(sid, { handler: (u) => norms.push(u), abort: new AbortController() });
    Reflect.set(client, 'sessionId_', sid);
    return { client, norms };
  }

  const dispatch = (client: AcpClient, params: unknown) =>
    Reflect.get(client, 'dispatchSessionUpdate').call(client, params);

  it('fans a session_info frame with configOptions out to two norms', () => {
    const { client, norms } = clientWithStream('s1');
    dispatch(client, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'session_info_update',
        title: 'Renamed',
        configOptions: [
          { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-4', options: [{ value: 'gpt-4', name: 'GPT-4' }] },
        ],
      },
    });
    expect(norms.map((n) => n.kind)).toEqual(['session_info', 'config_options']);
    expect(Reflect.get(client, 'currentModelId')).toBe('gpt-4');
    expect(Reflect.get(client, 'sessionInfo')).toMatchObject({ title: 'Renamed' });
  });

  it('keeps a plain session_info frame single-norm', () => {
    const { client, norms } = clientWithStream('s1');
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'session_info_update', title: 'Renamed' } });
    expect(norms).toEqual([{ kind: 'session_info', sessionId: undefined, title: 'Renamed', cwd: undefined }]);
  });

  it('delivers a v2 plan_update to the stream as a plan norm', () => {
    const { client, norms } = clientWithStream('s1');
    dispatch(client, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'plan_update',
        plan: { type: 'items', id: 'plan-1', entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }] },
      },
    });
    expect(norms).toEqual([{ kind: 'plan', entries: [{ content: 'Step 1', status: 'pending', priority: 'high' }] }]);
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
  it('should include enabled stdio servers with command and name', () => {
    const result = buildMcpServers([
      {
        type: 'stdio',
        id: '1',
        enabled: true,
        name: ' filesystem ',
        command: ' npx ',
        args: [' -y ', '', '@modelcontextprotocol/server-filesystem'],
      },
    ]);

    expect(result).toEqual([
      {
        type: 'stdio',
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: [],
      },
    ]);
  });

  it('should include enabled http/sse servers with url and name', () => {
    const result = buildMcpServers([
      {
        type: 'http',
        id: '2',
        enabled: true,
        name: ' my_http ',
        url: ' http://localhost:8000 ',
        headers: [{ name: 'Auth', value: '123' }],
      },
      { type: 'sse', id: '3', enabled: true, name: ' my_sse ', url: ' http://localhost:8001 ', headers: [] },
    ]);

    expect(result).toEqual([
      { type: 'http', name: 'my_http', url: 'http://localhost:8000', headers: [{ name: 'Auth', value: '123' }] },
      { type: 'sse', name: 'my_sse', url: 'http://localhost:8001', headers: [] },
    ]);
  });

  it('should skip disabled or incomplete servers', () => {
    const result = buildMcpServers([
      { type: 'stdio', id: '1', enabled: false, name: 'off', command: 'npx', args: [] },
      { type: 'stdio', id: '2', enabled: true, name: '', command: 'npx', args: [] },
      { type: 'stdio', id: '3', enabled: true, name: 'empty', command: '', args: [] },
      { type: 'http', id: '4', enabled: true, name: 'nourl', url: '', headers: [] },
    ]);

    expect(result).toEqual([]);
  });
});

describe('AcpClient session loading', () => {
  it('passes enabled MCP servers when loading a session', async () => {
    const client = new AcpClient('opencode');
    const requestWithFallback = vi.fn().mockResolvedValue({ sessionId: 's1' });
    Reflect.set(client, 'requestWithFallback', requestWithFallback);

    await client.loadSession('s1', '/vault', [
      {
        type: 'stdio',
        id: 'fs',
        enabled: true,
        name: ' filesystem ',
        command: ' npx ',
        args: [' -y ', '', '@modelcontextprotocol/server-filesystem'],
      },
      { type: 'stdio', id: 'off', enabled: false, name: 'disabled', command: 'npx', args: [] },
    ]);

    expect(requestWithFallback).toHaveBeenCalledWith('loadSession', {
      sessionId: 's1',
      cwd: '/vault',
      mcpServers: [
        {
          type: 'stdio',
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: [],
        },
      ],
    });
    expect(client.getCurrentSessionId()).toBe('s1');
  });

  it('loadSession classifies session-missing protocol errors as AcpSessionMissingError', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(
      client,
      'requestWithFallback',
      vi.fn().mockRejectedValue(new AcpProtocolError('Session not found', 'session/load', -32000)),
    );

    await expect(client.loadSession('ses_gone')).rejects.toBeInstanceOf(AcpSessionMissingError);
    expect(client.getCurrentSessionId()).toBeUndefined();
  });

  it('loadSession rethrows unrelated errors unchanged', async () => {
    const client = new AcpClient('opencode');
    const err = new AcpProtocolError('Internal error', 'session/load', -32603);
    Reflect.set(client, 'requestWithFallback', vi.fn().mockRejectedValue(err));

    await expect(client.loadSession('ses_1')).rejects.toBe(err);
  });

  it('resumeSession classifies session-missing errors as AcpSessionMissingError', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'requestWithFallback', vi.fn().mockRejectedValue(new Error('unknown session ses_gone')));

    await expect(client.resumeSession('ses_gone')).rejects.toBeInstanceOf(AcpSessionMissingError);
  });

  it('disposeConnection bumps the connection generation', async () => {
    const client = new AcpClient('opencode');
    const before = client.generation;
    await Reflect.get(client, 'disposeConnection').call(client, new Error('gone'));
    expect(client.generation).toBe(before + 1);
  });
});

describe('AcpRequestHandler permission handling', () => {
  it('routes session/request_permission through transport dispatch and rejects when UI handler fails', async () => {
    const registrations = new Map<string, (params: unknown) => Promise<unknown>>();
    const mockTransport = {
      onRequest: vi.fn((name: string, h: (params: unknown) => Promise<unknown>) => {
        registrations.set(name, h);
      }),
      request: vi.fn(),
      notify: vi.fn(),
      start: vi.fn(),
      dispose: vi.fn(),
      rejectPending: vi.fn(),
      isClosed: false,
      onNotification: vi.fn(),
    } as unknown as AcpJsonRpcTransport;

    const uiHandler = vi.fn().mockRejectedValue(new Error('ui unavailable'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handler = new AcpRequestHandler({
      transport: mockTransport,
      vaultPath: '/test',
      onPermissionRequest: uiHandler,
    });

    // Dispatch in AcpJsonRpcTransport is exact-match: without a handler for
    // the spec wire name every permission request would answer -32601 and
    // the banner UI would be unreachable in production.
    const dispatch = registrations.get('session/request_permission');
    expect(dispatch).toBeTypeOf('function');

    const result = await dispatch!({
      sessionId: 's1',
      toolCall: { kind: 'edit', title: 'Edit file' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });

    expect(result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('cancels and surfaces a permission request that fails schema validation', async () => {
    const registrations = new Map<string, (params: unknown) => Promise<unknown>>();
    const mockTransport = {
      onRequest: vi.fn((name: string, h: (params: unknown) => Promise<unknown>) => {
        registrations.set(name, h);
      }),
      request: vi.fn(),
      notify: vi.fn(),
      start: vi.fn(),
      dispose: vi.fn(),
      rejectPending: vi.fn(),
      isClosed: false,
      onNotification: vi.fn(),
    } as unknown as AcpJsonRpcTransport;

    const unreadable = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = new AcpRequestHandler({
      transport: mockTransport,
      vaultPath: '/test',
      onPermissionRequest: vi.fn(),
      onPermissionUnreadable: unreadable,
    });

    const dispatch = registrations.get('session/request_permission')!;
    // options is missing → schema failure must not reject the RPC nor hang the banner
    const result = await dispatch({ sessionId: 's1', toolCall: { kind: 'edit', title: 'Edit file' } });

    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(unreadable).toHaveBeenCalledTimes(1);
    expect(String(unreadable.mock.calls[0][0])).toContain('options');
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('uses the current release version for ACP clientInfo', () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});

describe('AcpRequestHandler elicitation handling', () => {
  function handlerWithTransport(uiHandler?: (req: unknown) => Promise<string>, unreadable?: (s: string) => void) {
    const registrations = new Map<string, (params: unknown) => Promise<unknown>>();
    const mockTransport = {
      onRequest: vi.fn((name: string, h: (params: unknown) => Promise<unknown>) => {
        registrations.set(name, h);
      }),
      request: vi.fn(),
      notify: vi.fn(),
      start: vi.fn(),
      dispose: vi.fn(),
      rejectPending: vi.fn(),
      isClosed: false,
      onNotification: vi.fn(),
    } as unknown as AcpJsonRpcTransport;
    const handler = new AcpRequestHandler({
      transport: mockTransport,
      vaultPath: '/test',
      onPermissionRequest: uiHandler as never,
      onPermissionUnreadable: unreadable,
    });
    return { handler, registrations };
  }

  it('registers elicitation/create and routes it through the permission banner callback', async () => {
    const uiHandler = vi.fn().mockResolvedValue('accept');
    const { handler, registrations } = handlerWithTransport(uiHandler);

    const dispatch = registrations.get('elicitation/create');
    expect(dispatch).toBeTypeOf('function');

    const result = await dispatch!({
      sessionId: 's1',
      mode: 'form',
      message: 'Run the migration now?',
      requestedSchema: { type: 'object' },
    });

    expect(result).toEqual({ action: 'accept', content: {} });
    expect(uiHandler).toHaveBeenCalledTimes(1);
    const req = uiHandler.mock.calls[0][0] as {
      sessionId: string;
      toolCall: { title: string; rawInput: Record<string, unknown>; kind: string };
      options: { optionId: string; kind: string }[];
    };
    expect(req.sessionId).toBe('s1');
    expect(req.toolCall.title).toBe('Run the migration now?');
    expect(req.toolCall.rawInput.elicitation).toBe(true);
    expect(req.toolCall.kind).toBe('other');
    expect(req.options.map((o) => o.optionId)).toEqual(['accept', 'decline']);
    handler.dispose();
  });

  it('maps decline and unknown decisions to decline/cancel', async () => {
    const declineHandler = vi.fn().mockResolvedValue('decline');
    const { handler: h1, registrations: r1 } = handlerWithTransport(declineHandler);
    expect(await r1.get('elicitation/create')!({ sessionId: 's1', message: 'ok?' })).toEqual({ action: 'decline' });
    h1.dispose();

    const otherHandler = vi.fn().mockResolvedValue('whatever');
    const { handler: h2, registrations: r2 } = handlerWithTransport(otherHandler);
    expect(await r2.get('elicitation/create')!({ sessionId: 's1', message: 'ok?' })).toEqual({ action: 'cancel' });
    h2.dispose();
  });

  it('cancels and surfaces an unreadable elicitation without touching the banner', async () => {
    const uiHandler = vi.fn();
    const unreadable = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(uiHandler, unreadable);

    // sessionId must be a string when present; a number fails the schema.
    const result = await registrations.get('elicitation/create')!({ sessionId: 42 });
    expect(result).toEqual({ action: 'cancel' });
    expect(unreadable).toHaveBeenCalledTimes(1);
    expect(uiHandler).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('cancels safely when the permission handler throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(vi.fn().mockRejectedValue(new Error('ui dead')));
    expect(await registrations.get('elicitation/create')!({ sessionId: 's1', message: 'hi' })).toEqual({ action: 'cancel' });
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('advertises the elicitation form capability at initialize', () => {
    const { handler } = handlerWithTransport();
    const caps = handler.buildClientCapabilities() as { elicitation?: { form?: unknown } };
    expect(caps.elicitation).toEqual({ form: {} });
    handler.dispose();
  });
});

describe('AcpClient authentication support', () => {
  it('normalizeAuthMethods keeps only entries with a usable id', () => {
    expect(normalizeAuthMethods([
      { id: 'a', name: 'A', description: ' desc ' },
      { id: 'b' },
      { name: 'no id' },
      { id: '' },
      null,
      'x',
      { id: 42 },
    ])).toEqual([
      { id: 'a', name: 'A', description: ' desc ' },
      { id: 'b', name: 'b' },
    ]);
    expect(normalizeAuthMethods(undefined)).toEqual([]);
    expect(normalizeAuthMethods('nope')).toEqual([]);
  });

  it('authenticate sends the request and never throws', async () => {
    const client = new AcpClient('opencode');
    const request = vi.fn().mockResolvedValue({});
    Reflect.set(client, 'transport', { request });
    Reflect.set(client, 'connected', true);
    await expect(client.authenticate('m1')).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith('authenticate', { methodId: 'm1' }, undefined, undefined);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Reflect.set(client, 'transport', { request: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(client.authenticate('m1')).resolves.toBe(false);
    warnSpy.mockRestore();
    expect(await client.authenticate('')).toBe(false);

  });

  it('createSession authenticates with the preferred method and retries once on auth_required', async () => {
    const client = new AcpClient('opencode');
    const request = vi.fn(async (method: string) => {
      if (method === 'authenticate') return {};
      const newSessionCalls = request.mock.calls.filter((c: unknown[]) => c[0] === 'session/new').length;
      if (newSessionCalls === 1) throw new AcpProtocolError('Please authenticate first', 'session/new', -32001);
      return { sessionId: 's9' };
    });
    Reflect.set(client, 'transport', { request });
    Reflect.set(client, 'connected', true);
    Reflect.set(client, 'authMethods', [{ id: 'oauth', name: 'OAuth' }]);

    await expect(client.createSession('/vault')).resolves.toBe('s9');
    expect(request).toHaveBeenCalledWith('authenticate', { methodId: 'oauth' }, undefined, undefined);
    expect(request.mock.calls.filter((c: unknown[]) => c[0] === 'session/new')).toHaveLength(2);

  });

  it('createSession rethrows the original error when no auth method exists', async () => {
    const client = new AcpClient('opencode');
    const request = vi.fn().mockRejectedValue(new AcpProtocolError('auth required', 'session/new', -32001));
    Reflect.set(client, 'transport', { request });
    Reflect.set(client, 'connected', true);
    Reflect.set(client, 'authMethods', []);
    await expect(client.createSession('/vault')).rejects.toBeInstanceOf(AcpProtocolError);
    expect(request).toHaveBeenCalledTimes(1);

  });
});

describe('sendMessage flow', () => {
  const dispatch = (client: AcpClient, params: unknown): void => {
    (client as unknown as { dispatchSessionUpdate(p: unknown): void }).dispatchSessionUpdate(params);
  };
  const messageUpdate = (text: string) => ({
    sessionUpdate: 'agent_message_chunk',
    messageId: 'm1',
    content: { type: 'text', text },
  });

  it('normalizes session updates and passes them to chunkHandler', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });

    const chunkHandler = vi.fn();
    client.sendMessage('s1', [], chunkHandler).catch(() => {});

    dispatch(client, { sessionId: 's1', update: messageUpdate('Hello') });

    expect(chunkHandler).toHaveBeenCalledTimes(1);
    expect(chunkHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message_chunk',
        role: 'agent',
        messageId: 'm1',
        chunkText: 'Hello',
        accumulatedText: 'Hello',
      }),
    );
  });

  it('routes each update only to its own session stream (side-chat isolation)', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    const main = vi.fn();
    const side = vi.fn();
    client.sendMessage('s1', [], main).catch(() => {});
    client.sendMessage('s2', [], side).catch(() => {});

    dispatch(client, { sessionId: 's2', update: messageUpdate('over there') });

    expect(side).toHaveBeenCalledTimes(1);
    expect(main).not.toHaveBeenCalled();
  });

  it('delivers session-id-less updates only when a single stream is active', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    const a = vi.fn();
    const b = vi.fn();
    client.sendMessage('s1', [], a).catch(() => {});

    dispatch(client, { update: messageUpdate('legacy') });
    expect(a).toHaveBeenCalledTimes(1);

    client.sendMessage('s2', [], b).catch(() => {});
    dispatch(client, { update: messageUpdate('ambiguous') });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent stream for the same session', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue(new Promise(() => {})) });
    client.sendMessage('s1', [], vi.fn()).catch(() => {});
    await expect(client.sendMessage('s1', [], vi.fn())).rejects.toThrow(Error);
  });

  it('gates client-state application to the main or replaying session', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    Reflect.set(client, 'sessionId_', 's1');
    const applySpy = vi.spyOn(client as unknown as { applySessionUpdate(u: unknown): void }, 'applySessionUpdate');
    const chunkHandler = vi.fn();
    client.sendMessage('s1', [], chunkHandler).catch(() => {});

    dispatch(client, { sessionId: 'side-1', update: messageUpdate('from side chat') });
    expect(applySpy).not.toHaveBeenCalled();

    dispatch(client, { sessionId: 's1', update: messageUpdate('mine') });
    expect(applySpy).toHaveBeenCalledTimes(1);

    // During a replay the replaying session also owns client state.
    Reflect.set(client, 'replaySessionId', 's2');
    dispatch(client, { sessionId: 's2', update: messageUpdate('replaying') });
    expect(applySpy).toHaveBeenCalledTimes(2);
  });

  it('routes replay updates to the replay handler when no stream is active', async () => {
    const client = new AcpClient('opencode');
    const replay = vi.fn();
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    Reflect.set(client, 'replaySessionId', 's9');
    Reflect.set(client, 'replayHandler', replay);

    dispatch(client, { sessionId: 's9', update: messageUpdate('restored') });

    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'message_chunk', chunkText: 'restored' }));
  });
});

describe('requestWithFallback', () => {
  it('falls back to second candidate when first throws -32601', async () => {
    const client = new AcpClient('opencode');
    const transport = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new AcpProtocolError('Method not found', 'session/new', -32601))
        .mockResolvedValueOnce({ sessionId: 's2' }),
    };
    Reflect.set(client, 'transport', transport);

    const result = await Reflect.get(client, 'requestWithFallback').call(client, 'newSession', { cwd: '/test' });

    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(transport.request).toHaveBeenNthCalledWith(1, 'session/new', { cwd: '/test' }, undefined, undefined);
    expect(transport.request).toHaveBeenNthCalledWith(2, 'newSession', { cwd: '/test' }, undefined, undefined);
    expect(result).toEqual({ sessionId: 's2' });
  });

  it('uses cached candidate without retrying first', async () => {
    const client = new AcpClient('opencode');
    const transport = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new AcpProtocolError('Method not found', 'session/new', -32601))
        .mockResolvedValueOnce({ sessionId: 's2' })
        .mockResolvedValueOnce({ sessionId: 's3' }),
    };
    Reflect.set(client, 'transport', transport);

    // First call caches the successful candidate
    await Reflect.get(client, 'requestWithFallback').call(client, 'newSession', { cwd: '/test' });

    // Second call should use 'newSession' directly
    const result2 = await Reflect.get(client, 'requestWithFallback').call(client, 'newSession', { cwd: '/test2' });

    expect(transport.request).toHaveBeenCalledTimes(3);
    expect(transport.request).toHaveBeenNthCalledWith(3, 'newSession', { cwd: '/test2' }, undefined, undefined);
    expect(result2).toEqual({ sessionId: 's3' });
  });

  it('does not trigger fallback when first candidate throws a different error', async () => {
    const client = new AcpClient('opencode');
    const expectedError = new AcpProtocolError('Server error', 'session/new', -32000);
    const transport = {
      request: vi.fn().mockRejectedValueOnce(expectedError),
    };
    Reflect.set(client, 'transport', transport);

    await expect(
      Reflect.get(client, 'requestWithFallback').call(client, 'newSession', { cwd: '/test' }),
    ).rejects.toThrow(expectedError);

    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('throws the original -32601 error if all candidates fail', async () => {
    const client = new AcpClient('opencode');
    const expectedError1 = new AcpProtocolError('Method not found', 'session/new', -32601);
    const expectedError2 = new AcpProtocolError('Method not found', 'newSession', -32601);
    const transport = {
      request: vi.fn().mockRejectedValueOnce(expectedError1).mockRejectedValueOnce(expectedError2),
    };
    Reflect.set(client, 'transport', transport);

    await expect(
      Reflect.get(client, 'requestWithFallback').call(client, 'newSession', { cwd: '/test' }),
    ).rejects.toThrow(expectedError2);

    expect(transport.request).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeAgentCapabilities', () => {
  it('converts object-marker capabilities to booleans', () => {
    // OpenCode v1.18 signals session capabilities with empty objects.
    const caps = normalizeAgentCapabilities({
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
    });
    expect(caps).toEqual({
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      sessionCapabilities: { close: true, fork: true, list: true, resume: true },
    });
  });

  it('passes explicit booleans through unchanged', () => {
    const caps = normalizeAgentCapabilities({ sessionCapabilities: { fork: false, list: true } });
    expect(caps?.sessionCapabilities).toEqual({ fork: false, list: true });
  });

  it('drops non-boolean non-object values and empty groups', () => {
    const caps = normalizeAgentCapabilities({
      sessionCapabilities: { fork: 'yes', resume: null },
      promptCapabilities: {},
    });
    expect(caps?.sessionCapabilities).toBeUndefined();
    expect(caps?.promptCapabilities).toBeUndefined();
  });

  it('preserves authMethods and scalar fields', () => {
    const authMethods = [{ id: 'api_key', name: 'API key' }];
    const caps = normalizeAgentCapabilities({ authMethods, version: 'v1' });
    expect(caps).toEqual({ authMethods, version: 'v1' });
  });

  it('returns null for non-object input', () => {
    expect(normalizeAgentCapabilities(null)).toBeNull();
    expect(normalizeAgentCapabilities(undefined)).toBeNull();
    expect(normalizeAgentCapabilities('nope')).toBeNull();
    expect(normalizeAgentCapabilities([])).toBeNull();
  });
});

describe('AcpClient.permissionMode', () => {
  it('defaults to yolo and stores assigned permission levels', () => {
    const client = new AcpClient('opencode');
    expect(client.permissionMode).toBe('yolo');
    client.permissionMode = 'safe';
    expect(client.permissionMode).toBe('safe');
    client.permissionMode = 'plan';
    expect(client.permissionMode).toBe('plan');
  });
});
