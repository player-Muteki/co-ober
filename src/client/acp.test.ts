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
  terminalContentFrom,
  resetDropWarnings,
} from './acp';
import { AcpRequestHandler } from './AcpRequestHandler';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import { t } from '../i18n/index';
import type { NormalizedUpdate, SessionUpdate, ToolCallContent } from '../types';

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

  it('should coerce v2 plan_removed into an empty plan that clears the panel', () => {
    expect(parseSessionUpdate({ sessionUpdate: 'plan_removed' })).toEqual({ sessionUpdate: 'plan', entries: [] });
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

  it('parses notice updates with a permissive level and message', () => {
    expect(parseSessionUpdate({ sessionUpdate: 'notice_update', level: 'warning', message: 'Rate limited' })).toEqual({
      sessionUpdate: 'notice_update',
      level: 'warning',
      message: 'Rate limited',
    });
    const fallback = parseSessionUpdate({ sessionUpdate: 'notice_update', message: { text: 'nested' } });
    expect(fallback).toEqual({ sessionUpdate: 'notice_update', level: 'info', message: 'nested' });
    expect(parseSessionUpdate({ sessionUpdate: 'notice_update', level: 'error' })).toBeNull();
  });

  it('parses compaction updates with or without a summary', () => {
    expect(parseSessionUpdate({ sessionUpdate: 'compaction_update' })).toEqual({ sessionUpdate: 'compaction_update' });
    expect(parseSessionUpdate({ sessionUpdate: 'compaction_update', summary: 'older turns' })).toEqual({
      sessionUpdate: 'compaction_update',
      summary: 'older turns',
    });
  });

  it('folds the official v2 notice frame onto the internal notice_update shape', () => {
    expect(
      parseSessionUpdate({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limited', description: 'slow down' }),
    ).toEqual({ sessionUpdate: 'notice_update', level: 'warning', message: 'Rate limited — slow down' });
    expect(parseSessionUpdate({ sessionUpdate: 'notice', title: 'Only a title' })).toEqual({
      sessionUpdate: 'notice_update',
      level: 'info',
      message: 'Only a title',
    });
    expect(parseSessionUpdate({ sessionUpdate: 'notice', severity: 42, title: 'x' })).toEqual({
      sessionUpdate: 'notice_update',
      level: 'info',
      message: 'x',
    });
    expect(parseSessionUpdate({ sessionUpdate: 'notice', title: '' })).toBeNull();
    expect(parseSessionUpdate({ sessionUpdate: 'notice' })).toBeNull();
  });

  it('parses the v2 compaction frame with id, status and a ContentBlock summary', () => {
    const v2 = parseSessionUpdate({
      sessionUpdate: 'compaction_update',
      compactionId: 'c-1',
      status: 'in_progress',
      summary: [
        { type: 'text', text: 'folded' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
        { type: 'text', text: 'away' },
      ],
    });
    expect(v2).toEqual({ sessionUpdate: 'compaction_update', compactionId: 'c-1', status: 'in_progress', summary: 'folded\naway' });
    expect(parseSessionUpdate({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'failed', error: 'boom' })).toEqual({
      sessionUpdate: 'compaction_update',
      compactionId: 'c',
      status: 'failed',
      error: 'boom',
    });
  });

  it('drops compaction_summary_chunk silently (known frame, unpainted summary)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      parseSessionUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1', content: { type: 'text', text: 'partial' } }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('parses v2 state_update frames', () => {
    expect(parseSessionUpdate({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' })).toEqual({
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'end_turn',
    });
    expect(parseSessionUpdate({ sessionUpdate: 'state_update', state: 'running' })).toEqual({
      sessionUpdate: 'state_update',
      state: 'running',
    });
    expect(parseSessionUpdate({ sessionUpdate: 'state_update' })).toBeNull();
  });

  it('keeps the stable tool_call name and initial content', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read file',
      name: 'read',
      content: [{ type: 'content', content: { type: 'text', text: 'start' } }],
    });
    expect(result).toEqual(
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        name: 'read',
        content: [{ type: 'content', content: { type: 'text', text: 'start' } }],
      }),
    );
    const nullName = parseSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'T', name: null });
    expect(nullName).toEqual(expect.objectContaining({ name: undefined }));
  });

  it('coerces the v2 plan_update envelope that identifies plans by planId', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'p-1', entries: [{ content: 'a', status: 'pending', priority: 'low' }] },
    });
    expect(result).toEqual({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending', priority: 'low' }] });
  });

  it('should return null for unknown update type', () => {
    const result = parseSessionUpdate({
      sessionUpdate: 'unknown_type',
      foo: 'bar',
    });
    expect(result).toBeNull();
  });
});

describe('parseSessionUpdate drop reporting', () => {
  it('names a frame that failed validation, so the transcript can say it vanished', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: string[] = [];
    expect(parseSessionUpdate({ sessionUpdate: 'tool_call' }, (kind) => dropped.push(kind))).toBeNull();
    expect(dropped).toEqual(['tool_call']);
    warn.mockRestore();
  });

  it('names an unknown kind too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: string[] = [];
    expect(parseSessionUpdate({ sessionUpdate: 'module_chunk' }, (kind) => dropped.push(kind))).toBeNull();
    expect(dropped).toEqual(['module_chunk']);
    warn.mockRestore();
  });

  it('counts a plan_update whose content variant cannot be listed', () => {
    const dropped: string[] = [];
    expect(
      parseSessionUpdate({ sessionUpdate: 'plan_update', plan: { type: 'text', content: 'prose' } }, (kind) =>
        dropped.push(kind),
      ),
    ).toBeNull();
    expect(dropped).toEqual(['plan_update']);
  });

  it('counts a summary chunk the transcript never paints', () => {
    const dropped: string[] = [];
    expect(
      parseSessionUpdate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c-1' }, (kind) => dropped.push(kind)),
    ).toBeNull();
    expect(dropped).toEqual(['compaction_summary_chunk']);
  });

  it('stays silent about a frame it drew', () => {
    const dropped: string[] = [];
    expect(
      parseSessionUpdate(
        { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'hi' } },
        (kind) => dropped.push(kind),
      ),
    ).not.toBeNull();
    expect(dropped).toEqual([]);
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
    expect(client.getSessionSnapshot().currentModelId).toBe('gpt-4');
    expect(client.getSessionInfo()).toMatchObject({ title: 'Renamed' });
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

describe('terminalContentFrom', () => {
  it('carries the output and stays quiet about a clean exit', () => {
    expect(
      terminalContentFrom({ output: 'total 1\nsrc', truncated: false, exitStatus: { exitCode: 0, signal: null } }),
    ).toEqual({ type: 'content', content: { type: 'text', text: 'total 1\nsrc' } });
  });

  it('says the buffer was trimmed and names a failing exit code', () => {
    const item = terminalContentFrom({
      output: 'tail',
      truncated: true,
      exitStatus: { exitCode: 2, signal: null },
    }) as Extract<ToolCallContent, { type: 'content' }>;
    const text = (item.content as { text: string }).text;
    expect(text).toContain(t().tool.outputTrimmed);
    expect(text).toContain('tail');
    expect(text).toContain(t().tool.exitCode.replace('{code}', '2'));
  });

  it('reports the signal that killed the process', () => {
    const item = terminalContentFrom({ output: '', exitStatus: { exitCode: null, signal: 'SIGTERM' } }) as Extract<
      ToolCallContent,
      { type: 'content' }
    >;
    expect((item.content as { text: string }).text).toBe(t().tool.terminated.replace('{signal}', 'SIGTERM'));
  });

  it('says the terminal is gone rather than painting an empty card', () => {
    const gone = { type: 'content', content: { type: 'text', text: t().tool.terminalGone } };
    expect(terminalContentFrom(null)).toEqual(gone);
    expect(terminalContentFrom({ output: '', error: 'terminal not found' })).toEqual(gone);
  });
});

describe('AcpClient terminal reads and drift reports', () => {
  function clientWithStream(sid: string): { client: AcpClient; norms: NormalizedUpdate[]; drifts: [string | null, string][] } {
    const client = new AcpClient('opencode');
    const norms: NormalizedUpdate[] = [];
    const drifts: [string | null, string][] = [];
    const streams = Reflect.get(client, 'activeStreams') as Map<
      string,
      { handler: (u: NormalizedUpdate) => void; abort: AbortController }
    >;
    streams.set(sid, { handler: (u) => norms.push(u), abort: new AbortController() });
    Reflect.set(client, 'sessionId_', sid);
    client.onProtocolDrift = (sessionId, kind) => drifts.push([sessionId, kind]);
    return { client, norms, drifts };
  }

  const dispatch = (client: AcpClient, params: unknown) =>
    Reflect.get(client, 'dispatchSessionUpdate').call(client, params);

  it('replaces a terminal reference with the output of the process it hosts', () => {
    const { client, norms } = clientWithStream('s1');
    const readTerminal = vi.fn((id: string) => ({ output: `read ${id}`, exitStatus: { exitCode: 0, signal: null } }));
    Reflect.set(client, 'requestHandler', { readTerminal });
    dispatch(client, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'ls',
        kind: 'execute',
        content: [{ type: 'terminal', terminalId: 'term-9' }],
      },
    });
    expect(readTerminal).toHaveBeenCalledWith('term-9');
    const snapshot = norms[0] as Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>;
    expect(snapshot.contents).toEqual([{ type: 'content', content: { type: 'text', text: 'read term-9' } }]);
  });

  it('leaves a non-terminal tool frame untouched', () => {
    const { client, norms } = clientWithStream('s1');
    Reflect.set(client, 'requestHandler', { readTerminal: vi.fn() });
    dispatch(client, {
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'read',
        content: [{ type: 'content', content: { type: 'text', text: 'plain' } }],
      },
    });
    const snapshot = norms[0] as Extract<NormalizedUpdate, { kind: 'tool_call_snapshot' }>;
    expect(snapshot.contents).toEqual([{ type: 'content', content: { type: 'text', text: 'plain' } }]);
  });

  it('reports the conversation a dropped frame belonged to', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, drifts } = clientWithStream('s1');
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 'not-a-number' } });
    expect(drifts).toEqual([['s1', 'usage_update']]);
    warn.mockRestore();
  });

  it('blames a frame it would have to guess a owner for on this client’s session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, drifts } = clientWithStream('s1');
    const streams = Reflect.get(client, 'activeStreams') as Map<
      string,
      { handler: (u: NormalizedUpdate) => void; abort: AbortController }
    >;
    streams.set('s2', { handler: () => {}, abort: new AbortController() });
    dispatch(client, { update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'x' } } });
    expect(drifts).toEqual([['s1', 'session update without a sessionId']]);
    warn.mockRestore();
  });
});

describe('AcpClient frames that outlive their stream', () => {
  const streamsOf = (client: AcpClient) =>
    Reflect.get(client, 'activeStreams') as Map<string, { handler: (u: NormalizedUpdate) => void; abort: AbortController }>;

  function clientWithNoStream(): { client: AcpClient; norms: NormalizedUpdate[]; drifts: [string | null, string][] } {
    const client = new AcpClient('opencode');
    const norms: NormalizedUpdate[] = [];
    const drifts: [string | null, string][] = [];
    // The slot a Stop freed: the frame still has a session to be counted against.
    streamsOf(client).set('s1', { handler: (u) => norms.push(u), abort: new AbortController() });
    streamsOf(client).delete('s1');
    Reflect.set(client, 'sessionId_', 's1');
    client.onProtocolDrift = (sessionId, kind) => drifts.push([sessionId, kind]);
    return { client, norms, drifts };
  }

  const dispatch = (client: AcpClient, params: unknown) =>
    Reflect.get(client, 'dispatchSessionUpdate').call(client, params);

  it('counts a tail chunk nobody could draw as drift for its session', () => {
    const { client, norms, drifts } = clientWithNoStream();
    dispatch(client, {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: ' trailing' } },
    });
    expect(norms).toEqual([]);
    expect(drifts).toEqual([['s1', 'message_chunk']]);
  });

  it('counts the last tool and plan frames of an abandoned turn the same way', () => {
    const { client, drifts } = clientWithNoStream();
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' } });
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'medium' }] } });
    expect(drifts).toEqual([['s1', 'tool_call_snapshot'], ['s1', 'plan']]);
  });

  it('stays quiet about metadata that has nothing to draw either', () => {
    const { client, drifts } = clientWithNoStream();
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'usage_update', totalTokens: 12 } });
    expect(drifts).toEqual([]);
  });

  it('does not double-report a frame the replay handler still accepted', () => {
    const { client, norms, drifts } = clientWithNoStream();
    Reflect.set(client, 'replayHandler', (u: NormalizedUpdate) => norms.push(u));
    Reflect.set(client, 'replaySessionId', 's1');
    dispatch(client, {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'restored' } },
    });
    expect(norms).toHaveLength(1);
    expect(drifts).toEqual([]);
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

  it('folds the wire input hint onto the argument hint the menu reads', () => {
    const result = mergeAvailableCommands([
      { name: 'deploy', description: 'ship it', input: { hint: '<environment>' } },
    ]);
    const deploy = result.find((c) => c.name === 'deploy');
    expect(deploy?.argumentHint).toBe('<environment>');
    // The raw pair is the client's business; consumers read argumentHint only.
    expect(deploy?.input).toBeUndefined();
  });

  it('keeps an already-merged argumentHint and omits the field when there is no hint', () => {
    const result = mergeAvailableCommands([
      { name: 'a', description: '', argumentHint: '<first>' },
      { name: 'b', description: '', argumentHint: '<first>', input: { hint: '<second>' } },
      { name: 'c', description: 'bare' },
    ]);
    expect(result.find((cmd) => cmd.name === 'a')?.argumentHint).toBe('<first>');
    expect(result.find((cmd) => cmd.name === 'b')?.argumentHint).toBe('<first>');
    expect('argumentHint' in (result.find((cmd) => cmd.name === 'c') ?? {})).toBe(false);
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

    // The trailing 0 is the idle-deadline contract: session/load runs with no
    // fixed transport timeout; replay updates refresh a 30s idle timer.
    expect(requestWithFallback).toHaveBeenCalledWith(
      'loadSession',
      {
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
      },
      0,
    );
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
  function handlerWithTransport(
    uiHandler?: (req: unknown) => Promise<string>,
    unreadable?: (s: string) => void,
    elicitationHandler?: (req: unknown) => Promise<unknown>,
  ) {
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
      onElicitationRequest: elicitationHandler as never,
      onPermissionUnreadable: unreadable,
    });
    return { handler, registrations };
  }

  const ask = (
    registrations: Map<string, (params: unknown) => Promise<unknown>>,
    params: Record<string, unknown>,
  ) => registrations.get('elicitation/create')!(params);

  it('routes a form elicitation through the elicitation callback with its parsed fields', async () => {
    const answer = vi.fn().mockResolvedValue({ action: 'accept', content: { target: 'prod' } });
    const { handler, registrations } = handlerWithTransport(undefined, undefined, answer);

    expect(registrations.get('elicitation/create')).toBeTypeOf('function');
    const result = await ask(registrations, {
      sessionId: 's1',
      mode: 'form',
      message: 'Which environment?',
      requestedSchema: {
        type: 'object',
        properties: { target: { type: 'string', title: 'Target' } },
        required: ['target'],
      },
    });

    expect(result).toEqual({ action: 'accept', content: { target: 'prod' } });
    expect(answer).toHaveBeenCalledTimes(1);
    const req = answer.mock.calls[0][0] as Record<string, unknown>;
    expect(req.sessionId).toBe('s1');
    expect(req.message).toBe('Which environment?');
    expect(req.fields).toEqual([{ key: 'target', label: 'Target', required: true, kind: 'text' }]);
    expect(req.omittedFields).toEqual([]);
    handler.dispose();
  });

  it('echoes only the keys the schema asked for, so a caller cannot inject answers', async () => {
    const answer = vi.fn().mockResolvedValue({ action: 'accept', content: { target: 'prod', sessionId: 'victim', approved: true } });
    const { handler, registrations } = handlerWithTransport(undefined, undefined, answer);

    const result = await ask(registrations, {
      sessionId: 's1',
      message: 'Which environment?',
      requestedSchema: { properties: { target: { type: 'string' } } },
    });

    expect(result).toEqual({ action: 'accept', content: { target: 'prod' } });
    handler.dispose();
  });

  it('passes a decline or cancel back to the agent untouched', async () => {
    const { handler, registrations } = handlerWithTransport(undefined, undefined, vi.fn().mockResolvedValue({ action: 'decline' }));
    expect(await ask(registrations, { sessionId: 's1', message: 'ok?', requestedSchema: { properties: { a: { type: 'string' } } } }))
      .toEqual({ action: 'decline' });
    handler.dispose();

    const h2 = handlerWithTransport(undefined, undefined, vi.fn().mockResolvedValue({ action: 'cancel' }));
    expect(await ask(h2.registrations, { sessionId: 's1', message: 'ok?', requestedSchema: { properties: { a: { type: 'string' } } } }))
      .toEqual({ action: 'cancel' });
    h2.handler.dispose();
  });

  it('treats a schema that asks for no keys as a confirmation and answers it empty', async () => {
    const answer = vi.fn().mockResolvedValue({ action: 'accept', content: {} });
    const { handler, registrations } = handlerWithTransport(undefined, undefined, answer);
    expect(await ask(registrations, { sessionId: 's1', mode: 'form', message: 'Run the migration now?', requestedSchema: { type: 'object' } }))
      .toEqual({ action: 'accept', content: {} });
    expect(answer).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it('declines a schema whose keys it cannot render rather than accepting a blank answer', async () => {
    const answer = vi.fn();
    const unreadable = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(undefined, unreadable, answer);

    const result = await ask(registrations, {
      sessionId: 's1',
      message: 'Pick a shape',
      requestedSchema: { properties: { grid: { type: 'array', items: { type: 'string' } } } },
    });

    expect(result).toEqual({ action: 'decline' });
    expect(answer).not.toHaveBeenCalled();
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('grid'), 's1');
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('declines while no elicitation view is bound, instead of answering for the user', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(vi.fn().mockResolvedValue('accept'));
    const result = await ask(registrations, {
      sessionId: 's1',
      message: 'Which environment?',
      requestedSchema: { properties: { target: { type: 'string' } } },
    });
    expect(result).toEqual({ action: 'decline' });
    warnSpy.mockRestore();
    handler.dispose();
  });

  it('carries a url-mode elicitation to the view so its link can be shown', async () => {
    const answer = vi.fn().mockResolvedValue({ action: 'accept', content: {} });
    const { handler, registrations } = handlerWithTransport(undefined, undefined, answer);

    const result = await ask(registrations, {
      sessionId: 's1',
      mode: 'url',
      elicitationId: 'el-9',
      message: 'Sign in to continue',
      url: 'https://example.test/sign-in',
    });

    expect(result).toEqual({ action: 'accept', content: {} });
    const req = answer.mock.calls[0][0] as { url: string; elicitationId: string; fields: unknown[] };
    expect(req.url).toBe('https://example.test/sign-in');
    expect(req.elicitationId).toBe('el-9');
    expect(req.fields).toEqual([]);
    handler.dispose();
  });

  it('cancels and surfaces an unreadable elicitation without touching the banner', async () => {
    const uiHandler = vi.fn();
    const unreadable = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(uiHandler, unreadable);

    // sessionId must be a string when present; a number fails the schema.
    const result = await ask(registrations, { sessionId: 42 });
    expect(result).toEqual({ action: 'cancel' });
    expect(unreadable).toHaveBeenCalledTimes(1);
    expect(uiHandler).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    handler.dispose();
  });

  it('cancels safely when the elicitation handler throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler, registrations } = handlerWithTransport(undefined, undefined, vi.fn().mockRejectedValue(new Error('ui dead')));
    expect(await ask(registrations, { sessionId: 's1', message: 'hi', requestedSchema: { properties: { a: { type: 'string' } } } }))
      .toEqual({ action: 'cancel' });
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

  it('keeps client state per session: one slot per sessionId', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    Reflect.set(client, 'sessionId_', 's1');
    const chunkHandler = vi.fn();
    client.sendMessage('s1', [], chunkHandler).catch(() => {});

    // A side-chat frame lands in the side-chat's slot, not the main one.
    dispatch(client, { sessionId: 'side-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'side-mode', availableModes: [] } });
    expect(client.getSessionSnapshot().currentModeId).toBeNull();
    expect(client.getSessionSnapshotFor('side-1').currentModeId).toBe('side-mode');

    dispatch(client, { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'mine', availableModes: [] } });
    expect(client.getSessionSnapshot().currentModeId).toBe('mine');

    // During a replay the replaying session owns its own slot too.
    Reflect.set(client, 'replaySessionId', 's2');
    dispatch(client, { sessionId: 's2', update: { sessionUpdate: 'current_model_update', currentModelId: 'replayed', availableModels: [] } });
    expect(client.getSessionSnapshot().currentModelId).toBeNull();
    expect(client.getSessionSnapshotFor('s2').currentModelId).toBe('replayed');
  });

  it('forgets the metadata of a session the agent closed', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}) });
    Reflect.set(client, 'sessionId_', 's1');
    client.sendMessage('s1', [], vi.fn()).catch(() => {});

    dispatch(client, {
      sessionId: 's1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }] },
    });
    expect(client.getSessionSnapshotFor('s1').currentModeId).toBe('plan');

    await client.closeSession('s1');

    // The agent dropped the session; what it last reported for it is true of
    // nothing, and a reopened session must not look like it still had them.
    expect(client.getSessionSnapshotFor('s1').currentModeId).toBeNull();
    expect(client.getSessionSnapshotFor('s1').availableModes).toEqual([]);
  });

  it('clears per-session metadata when the connection goes away', async () => {
    const client = new AcpClient('opencode');
    Reflect.set(client, 'transport', { request: vi.fn().mockResolvedValue({}), dispose: vi.fn() });
    Reflect.set(client, 'sessionId_', 's1');
    client.sendMessage('s1', [], vi.fn()).catch(() => {});

    dispatch(client, {
      sessionId: 's1',
      update: { sessionUpdate: 'current_model_update', currentModelId: 'gone-model', availableModels: [] },
    });
    expect(client.getSessionSnapshotFor('s1').currentModelId).toBe('gone-model');

    await Reflect.get(client, 'disposeConnection').call(client, new Error('gone'));

    expect(client.getSessionSnapshotFor('s1').currentModelId).toBeNull();
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

describe('parseSessionUpdate non-text content and observability', () => {
  it('parses an image message chunk instead of dropping the frame', () => {
    const parsed = parseSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'image', mimeType: 'image/png', data: 'AAA' },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionUpdate).toBe('agent_message_chunk');
  });

  it('warns once per unknown session update kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSessionUpdate({ sessionUpdate: 'module_chunk_probe_kind' })).toBeNull();
    expect(parseSessionUpdate({ sessionUpdate: 'module_chunk_probe_kind' })).toBeNull();
    expect(parseSessionUpdate({ sessionUpdate: 'unknown_chunk_probe_kind' })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('module_chunk_probe_kind');
    warn.mockRestore();
  });
});

describe('AcpClient subprocess close during the connect handshake', () => {
  it('rejects connect() with the spawn error when the binary cannot launch', async () => {
    const client = new AcpClient('/nonexistent/co-ober-missing-binary-xyz');
    await expect(client.connect()).rejects.toThrow(/ENOENT/);
  });

  function makeClient() {
    const client = new AcpClient('opencode');
    const subprocess = {
      getStderrSnapshot: () => '',
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    Reflect.set(client, 'subprocess', subprocess);
    return { client, subprocess };
  }

  it('skips reconnect scheduling while a connect handshake is still in flight', () => {
    const { client, subprocess } = makeClient();
    const schedule = vi.fn();
    Reflect.set(client, 'scheduleReconnect', schedule);
    const dispose = vi.fn().mockResolvedValue(undefined);
    Reflect.set(client, 'disposeConnection', dispose);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A launch that fails (ENOENT) closes the subprocess before connect() sets connected.
    Reflect.set(client, 'connectingGeneration', client.generation);
    Reflect.set(client, 'connected', false);

    Reflect.get(client, 'handleSubprocessClose').call(client, subprocess, new Error('spawn ENOENT'));

    expect(dispose).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('does dispose and reconnect for a close that arrives after the handshake finished', async () => {
    const { client, subprocess } = makeClient();
    const dispose = vi.fn().mockResolvedValue(undefined);
    Reflect.set(client, 'disposeConnection', dispose);
    const schedule = vi.fn();
    Reflect.set(client, 'scheduleReconnect', schedule);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Normal runtime loss: connected is true and no handshake is pending.
    Reflect.set(client, 'connectingGeneration', null);
    Reflect.set(client, 'connected', true);

    Reflect.get(client, 'handleSubprocessClose').call(client, subprocess, new Error('exited'));
    await Promise.resolve();

    expect(dispose).toHaveBeenCalled();
    expect(schedule).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('0.2.3 stage 1 per-connection drop warnings', () => {
  const unroutableKind = 'co-ober-test/module_chunk';
  const unknownFrame = { sessionUpdate: unroutableKind };
  const malformedToolCall = { sessionUpdate: 'tool_call', title: 'edit file' };
  const mentions = (warn: { mock: { calls: unknown[][] } }, needle: string) =>
    warn.mock.calls.filter((call) => String(call[0]).includes(needle));

  it('reports an unroutable frame kind once per connection, not once per process', () => {
    resetDropWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseSessionUpdate(unknownFrame)).toBeNull();
    expect(parseSessionUpdate(unknownFrame)).toBeNull();
    expect(mentions(warn, unroutableKind)).toHaveLength(1);

    resetDropWarnings();
    expect(parseSessionUpdate(unknownFrame)).toBeNull();
    expect(mentions(warn, unroutableKind)).toHaveLength(2);
    warn.mockRestore();
  });

  it('reports a validation-rejected frame once per connection too', () => {
    resetDropWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseSessionUpdate(malformedToolCall)).toBeNull();
    expect(parseSessionUpdate(malformedToolCall)).toBeNull();
    expect(mentions(warn, 'tool_call frame rejected')).toHaveLength(1);

    resetDropWarnings();
    expect(parseSessionUpdate(malformedToolCall)).toBeNull();
    expect(mentions(warn, 'tool_call frame rejected')).toHaveLength(2);
    warn.mockRestore();
  });

  it('still counts every dropped frame after the warning went quiet', () => {
    resetDropWarnings();
    const dropped: string[] = [];

    parseSessionUpdate(unknownFrame, (kind) => dropped.push(kind));
    parseSessionUpdate(unknownFrame, (kind) => dropped.push(kind));

    expect(dropped).toEqual([unroutableKind, unroutableKind]);
  });
});
