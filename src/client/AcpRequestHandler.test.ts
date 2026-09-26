import { describe, it, expect, vi } from 'vitest';
import { AcpRequestHandler, parseElicitationForm } from './AcpRequestHandler';
import type { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import type { CapabilityGrant, PermissionDecision, PermissionRequest, TerminalCreateParams } from '../types';

function makeHandler(options: {
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionDecision>;
  onPermissionUnreadable?: (summary: string, sessionId?: string) => void;
} = {}): AcpRequestHandler {
  const transport = { onRequest: vi.fn(() => () => {}) } as unknown as AcpJsonRpcTransport;
  return new AcpRequestHandler({
    transport,
    vaultPath: '/mock/vault',
    onPermissionRequest: options.onPermissionRequest,
    onPermissionUnreadable: options.onPermissionUnreadable,
  });
}

function ask(handler: AcpRequestHandler, params: Record<string, unknown>): Promise<unknown> {
  const fn = Reflect.get(handler, 'handleServerRequestPermission') as (p: Record<string, unknown>) => Promise<unknown>;
  return fn(params);
}

const validOptions = [
  { optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'reject-1', kind: 'reject_once', name: 'Reject once' },
];

describe('AcpRequestHandler permission outcomes', () => {
  it('reports selected only for an option id the agent offered', async () => {
    const handler = makeHandler({ onPermissionRequest: async () => 'allow-1' });
    const result = await ask(handler, { sessionId: 's1', toolCall: { title: 'edit file' }, options: validOptions });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });
    handler.dispose();
  });

  it('reports cancelled for a decision that matches no offered option', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = makeHandler({ onPermissionRequest: async () => 'reject_once' });
    const result = await ask(handler, {
      sessionId: 's1',
      toolCall: { title: 'edit file' },
      options: [{ optionId: 'proceed-9', kind: 'allow_always', name: 'Proceed' }],
    });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reject_once'));
    warn.mockRestore();
    handler.dispose();
  });

  it('accepts an agent-minted option kind and still shows the prompt', async () => {
    const seen = vi.fn<(r: PermissionRequest) => Promise<string>>(async () => 'ask-later');
    const handler = makeHandler({ onPermissionRequest: seen });
    const result = await ask(handler, {
      sessionId: 's1',
      toolCall: { title: 'write' },
      options: [{ optionId: 'ask-later', kind: 'ask_first', name: 'Ask later' }],
    });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'ask-later' } });
    expect(seen).toHaveBeenCalledTimes(1);
    handler.dispose();
  });

  it('degrades an unknown tool call kind to other before prompting', async () => {
    const seen = vi.fn<(r: PermissionRequest) => Promise<string>>(async () => 'allow-1');
    const handler = makeHandler({ onPermissionRequest: seen });
    await ask(handler, {
      sessionId: 's1',
      toolCall: { title: 'browse', kind: 'browser_automation' },
      options: validOptions,
    });
    expect(seen.mock.calls[0][0].toolCall.kind).toBe('other');
    handler.dispose();
  });

  it('keeps apply_patch as a known tool kind', async () => {
    const seen = vi.fn<(r: PermissionRequest) => Promise<string>>(async () => 'allow-1');
    const handler = makeHandler({ onPermissionRequest: seen });
    await ask(handler, {
      sessionId: 's1',
      toolCall: { title: 'patch', kind: 'apply_patch' },
      options: validOptions,
    });
    expect(seen.mock.calls[0][0].toolCall.kind).toBe('apply_patch');
    handler.dispose();
  });

  it('cancels an unreadable permission request and reports the summary', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = vi.fn();
    const handler = makeHandler({ onPermissionUnreadable: unreadable });
    // Only a structurally impossible frame fails now: string fields catch to
    // '' and malformed options are dropped, not fatal.
    const result = await ask(handler, { sessionId: 's1', toolCall: 'not-an-object', options: validOptions });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    // The session rides along, so the report lands in the tab that asked.
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('toolCall'), 's1');
    errSpy.mockRestore();
    handler.dispose();
  });

  it('names no session when the frame it could not read carried none', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = vi.fn();
    const handler = makeHandler({ onPermissionUnreadable: unreadable });
    await ask(handler, { toolCall: 'not-an-object', options: validOptions });

    // Nothing to attribute it to: the view keeps the report off some other
    // tab's transcript rather than guessing.
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('toolCall'), undefined);
    errSpy.mockRestore();
    handler.dispose();
  });

  it('prompts anyway when sessionId and title are missing and one option is malformed', async () => {
    const seen = vi.fn<(r: PermissionRequest) => Promise<string>>(async () => 'allow-1');
    const handler = makeHandler({ onPermissionRequest: seen });
    const result = await ask(handler, {
      toolCall: {},
      options: [validOptions[0], { kind: 'allow_once' }, 'garbage'],
    });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } });
    expect(seen.mock.calls[0][0].options).toHaveLength(1);
    handler.dispose();
  });

  it('cancels and reports when every offered option is malformed (nothing to click)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = vi.fn();
    const seen = vi.fn();
    const handler = makeHandler({ onPermissionRequest: seen, onPermissionUnreadable: unreadable });
    const result = await ask(handler, { sessionId: 's1', toolCall: { title: 'x' }, options: [{ nope: true }] });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(seen).not.toHaveBeenCalled();
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('no selectable options'), 's1');
    errSpy.mockRestore();
    handler.dispose();
  });

  it('falls back to the built-in reject when the prompt handler throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeHandler({
      onPermissionRequest: async () => {
        throw new Error('renderer bug');
      },
    });
    const result = await ask(handler, { sessionId: 's1', toolCall: { title: 'edit' }, options: validOptions });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } });
    errSpy.mockRestore();
    handler.dispose();
  });

  it('reports cancelled, not a reject option, when nobody answered the prompt', async () => {
    // Esc on the banner means "unanswered". Choosing reject-1 here would tell
    // the agent the user refused, which is a decision nobody made.
    const handler = makeHandler({ onPermissionRequest: async () => null });
    const result = await ask(handler, { sessionId: 's1', toolCall: { title: 'edit' }, options: validOptions });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    handler.dispose();
  });
});

describe('AcpRequestHandler fs/terminal in-band errors', () => {
  function callPrivate(handler: AcpRequestHandler, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = Reflect.get(handler, method) as (p: Record<string, unknown>) => Promise<unknown>;
    return fn.call(handler, params);
  }

  it('surfaces a failed read as a rejected request, not an empty file', async () => {
    const handler = makeHandler({});
    await expect(callPrivate(handler, 'handleReadTextFile', { path: 'definitely-missing.md' })).rejects.toThrow(/File not found/);
    handler.dispose();
  });

  it('surfaces a failed write as a rejected request, not an empty success', async () => {
    const handler = new AcpRequestHandler({
      transport: { onRequest: vi.fn(() => () => {}) } as unknown as AcpJsonRpcTransport,
      vaultPath: '/mock/vault',
      vaultIo: { writeText: async () => { throw new Error('vault locked'); } },
    });
    await expect(callPrivate(handler, 'handleWriteTextFile', { path: 'a/b.md', content: 'x' })).rejects.toThrow('vault locked');
    handler.dispose();
  });

  it('surfaces an unknown terminal as a rejected request, not blank output', async () => {
    const handler = makeHandler({});
    await expect(callPrivate(handler, 'handleTerminalOutput', { terminalId: 'term-404' })).rejects.toThrow(/Terminal not found/);
    handler.dispose();
  });
});

describe('AcpRequestHandler unasked capability grants', () => {
  function grantHandler(grants: CapabilityGrant[]): AcpRequestHandler {
    const transport = { onRequest: vi.fn(() => () => {}) } as unknown as AcpJsonRpcTransport;
    return new AcpRequestHandler({
      transport,
      vaultPath: '/mock/vault',
      vaultIo: { writeText: async () => {} },
      onCapabilityGrant: (grant) => grants.push(grant),
    });
  }

  function call(handler: AcpRequestHandler, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = Reflect.get(handler, method) as (p: Record<string, unknown>) => Promise<unknown>;
    return fn.call(handler, params);
  }

  it('records the note a write touched, as the user reads it', async () => {
    const grants: CapabilityGrant[] = [];
    const handler = grantHandler(grants);
    await call(handler, 'handleWriteTextFile', { path: '/mock/vault/notes/idea.md', content: 'x', sessionId: 's1' });
    expect(grants).toEqual([{ sessionId: 's1', kind: 'file-write', detail: 'notes/idea.md' }]);
    handler.dispose();
  });

  it('records the command line a terminal ran, arguments included', async () => {
    const grants: CapabilityGrant[] = [];
    const handler = grantHandler(grants);
    Reflect.set(handler, 'terminalManager', { create: () => ({ terminalId: 't1', pid: 42 }), dispose: vi.fn() });
    await call(handler, 'handleTerminalCreate', { command: 'git', args: ['push', 'origin'], sessionId: 's2' });
    expect(grants).toEqual([{ sessionId: 's2', kind: 'terminal', detail: 'git push origin' }]);
    handler.dispose();
  });

  it('stays silent when the write it was asked for failed', async () => {
    const grants: CapabilityGrant[] = [];
    const transport = { onRequest: vi.fn(() => () => {}) } as unknown as AcpJsonRpcTransport;
    const handler = new AcpRequestHandler({
      transport,
      vaultPath: '/mock/vault',
      vaultIo: {
        writeText: async () => {
          throw new Error('vault locked');
        },
      },
      onCapabilityGrant: (grant) => grants.push(grant),
    });
    await expect(call(handler, 'handleWriteTextFile', { path: 'a.md', content: 'x' })).rejects.toThrow('vault locked');
    expect(grants).toEqual([]);
    handler.dispose();
  });

  it('reports nothing when a refused capability was never honoured', async () => {
    const grants: CapabilityGrant[] = [];
    const handler = grantHandler(grants);
    handler.setTerminalCapabilityMode('disabled');
    // CreateTerminalResponse has no error field; a refusal that travelled in
    // band read back as a terminal created with no id.
    await expect(call(handler, 'handleTerminalCreate', { command: 'rm', args: ['-rf', '/'] })).rejects.toThrow(/disabled/);
    expect(grants).toEqual([]);
    handler.dispose();
  });

  it('keeps a grant whose frame carried no session off the active transcript', async () => {
    const grants: CapabilityGrant[] = [];
    const handler = grantHandler(grants);
    await call(handler, 'handleWriteTextFile', { path: '/mock/vault/a.md', content: 'x' });
    expect(grants).toEqual([{ sessionId: undefined, kind: 'file-write', detail: 'a.md' }]);
    handler.dispose();
  });
});

describe('AcpRequestHandler.readTerminal', () => {
  it('reads through the manager that hosts the agent’s own terminals', () => {
    const handler = makeHandler({});
    const output = vi.fn(() => ({ output: 'total 1\nsrc', truncated: false }));
    Reflect.set(handler, 'terminalManager', { output });
    expect(handler.readTerminal('term-1')).toEqual({ output: 'total 1\nsrc', truncated: false });
    expect(output).toHaveBeenCalledWith('term-1');
  });

  it('keeps the manager’s error for an id it no longer knows', () => {
    const handler = makeHandler({});
    expect(handler.readTerminal('term-404')).toMatchObject({ error: expect.stringContaining('term-404') });
    handler.dispose();
  });

  it('says nothing is there once the manager is gone', () => {
    const handler = makeHandler({});
    handler.dispose();
    expect(handler.readTerminal('term-1')).toBeNull();
  });
});

describe('parseElicitationForm', () => {
  it('reads a scalar property as an answerable field', () => {
    const { fields, omitted } = parseElicitationForm({
      properties: {
        target: { type: 'string', title: 'Target', description: 'Where to deploy' },
        retries: { type: 'number' },
        cap: { type: 'integer' },
        force: { type: 'boolean' },
      },
      required: ['target'],
    });
    expect(omitted).toEqual([]);
    expect(fields).toEqual([
      { key: 'target', label: 'Target', required: true, kind: 'text', description: 'Where to deploy' },
      { key: 'retries', label: 'retries', required: false, kind: 'number' },
      { key: 'cap', label: 'cap', required: false, kind: 'number' },
      { key: 'force', label: 'force', required: false, kind: 'boolean' },
    ]);
  });

  it('reads an enum as the choices the agent offered, in order', () => {
    const { fields } = parseElicitationForm({
      properties: {
        plain: { type: 'string', enum: ['dev', 'prod'] },
        titled: { oneOf: [{ const: 'dev', title: 'Development' }, { const: 'prod' }] },
      },
    });
    expect(fields[0].kind).toBe('enum');
    expect(fields[0].values).toEqual([{ value: 'dev', label: 'dev' }, { value: 'prod', label: 'prod' }]);
    expect(fields[1].values).toEqual([{ value: 'dev', label: 'Development' }, { value: 'prod', label: 'prod' }]);
  });

  it('keeps the renderable half of a schema and names the rest', () => {
    const { fields, omitted } = parseElicitationForm({
      properties: {
        window: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        owner: { type: 'object', properties: { id: { type: 'string' } } },
      },
      required: 'nobody should send this',
    });
    expect(fields.map((f) => f.key)).toEqual(['notes']);
    // One unreadable property costs its own answer, not the whole question.
    expect(omitted).toEqual(['window', 'owner']);
  });

  it('asks nothing of the reader when the schema has no properties to read', () => {
    for (const raw of [{ type: 'object' }, {}, 'nonsense', undefined, null, { properties: 'nope' }]) {
      expect(parseElicitationForm(raw)).toEqual({ fields: [], omitted: [] });
    }
  });
});

describe('the window an agent asked to read (0.2.5 stage 2)', () => {
  function call(handler: AcpRequestHandler, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = Reflect.get(handler, method) as (p: Record<string, unknown>) => Promise<unknown>;
    return fn.call(handler, params);
  }

  function windowHandler() {
    const handler = makeHandler({});
    handler.setFsCapabilityMode('enabled');
    const readTextFile = vi.fn(
      (
        _path: string,
        _window?: { line?: number; limit?: number },
      ) => ({ content: 'windowed' }),
    );
    Reflect.set(handler, 'fsDelegate', { readTextFile });
    return { handler, readTextFile };
  }

  it('hands line and limit down to the reader', async () => {
    const { handler, readTextFile } = windowHandler();
    const result = await call(handler, 'handleReadTextFile', {
      path: '/mock/vault/notes/a.md',
      line: 500,
      limit: 40,
    });

    expect(readTextFile).toHaveBeenCalledWith('/mock/vault/notes/a.md', { path: '/mock/vault/notes/a.md', line: 500, limit: 40 });
    expect(result).toEqual({ content: 'windowed' });
    handler.dispose();
  });

  it('asks for the whole file when the agent did not name a window', async () => {
    const { handler, readTextFile } = windowHandler();
    await call(handler, 'handleReadTextFile', { path: '/mock/vault/a.md' });

    expect(readTextFile).toHaveBeenCalledWith('/mock/vault/a.md', { path: '/mock/vault/a.md', line: undefined, limit: undefined });
    handler.dispose();
  });

  it('degrades a window it cannot read to no window, not to a wrong line', async () => {
    const { handler, readTextFile } = windowHandler();
    await call(handler, 'handleReadTextFile', { path: '/mock/vault/a.md', line: 'fifth', limit: -3 });

    const window = readTextFile.mock.calls[0][1] as { line?: number; limit?: number };
    expect(window.line).toBeUndefined();
    expect(window.limit).toBeUndefined();
    handler.dispose();
  });
});

describe('a terminal answer the protocol can read (0.2.5 stage 2)', () => {
  function call(handler: AcpRequestHandler, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = Reflect.get(handler, method) as (p: Record<string, unknown>) => Promise<unknown>;
    return fn.call(handler, params);
  }

  function terminalHandler(manager: Record<string, unknown>) {
    const handler = makeHandler({});
    handler.setTerminalCapabilityMode('enabled');
    Reflect.set(handler, 'terminalManager', { dispose: vi.fn(), ...manager });
    return handler;
  }

  it('answers a create with the id and nothing else', async () => {
    const handler = terminalHandler({ create: () => ({ terminalId: 't1', pid: 7 }) });
    expect(await call(handler, 'handleTerminalCreate', { command: 'ls', sessionId: 's1' })).toMatchObject({ terminalId: 't1' });
    handler.dispose();
  });

  it('answers a create that could not start with an error, not an id-less success', async () => {
    const handler = terminalHandler({
      create: () => {
        throw new Error('ENOENT: no such file, spawn ls');
      },
    });
    await expect(call(handler, 'handleTerminalCreate', { command: 'ls' })).rejects.toThrow(/ENOENT/);
    handler.dispose();
  });

  it('answers kill with the empty object the response type allows', async () => {
    const kill = vi.fn(() => true);
    const handler = terminalHandler({ kill });
    expect(await call(handler, 'handleTerminalKill', { terminalId: 't1' })).toEqual({});
    expect(kill).toHaveBeenCalledWith('t1');
    handler.dispose();
  });

  it('says a kill found no terminal as a refusal', async () => {
    const handler = terminalHandler({ kill: () => false });
    await expect(call(handler, 'handleTerminalKill', { terminalId: 't-404' })).rejects.toThrow(/t-404/);
    handler.dispose();
  });

  it('says a release found no terminal as a refusal', async () => {
    const handler = terminalHandler({ release: () => true });
    expect(await call(handler, 'handleTerminalRelease', { terminalId: 't1' })).toEqual({});
    handler.dispose();
  });

  it('answers wait_for_exit with how the process ended', async () => {
    const handler = terminalHandler({ waitForExit: async () => ({ exitCode: 1, signal: null }) });
    expect(await call(handler, 'handleTerminalWaitForExit', { terminalId: 't1' })).toEqual({ exitCode: 1, signal: null });
    handler.dispose();
  });

  it('refuses to report an exit for a terminal it never had', async () => {
    const handler = terminalHandler({ waitForExit: async () => null });
    await expect(call(handler, 'handleTerminalWaitForExit', { terminalId: 't-404' })).rejects.toThrow(/t-404/);
    handler.dispose();
  });

  it('passes the exit status through with the output', async () => {
    const handler = terminalHandler({ output: () => ({ output: 'done\n', truncated: false, exitStatus: { exitCode: 0 } }) });
    expect(await call(handler, 'handleTerminalOutput', { terminalId: 't1' })).toEqual({
      output: 'done\n',
      truncated: false,
      exitStatus: { exitCode: 0 },
    });
    handler.dispose();
  });
});

describe('terminal/create as the protocol writes it (0.2.6 stage 2)', () => {
  function call(handler: AcpRequestHandler, method: string, params: Record<string, unknown>): Promise<unknown> {
    const fn = Reflect.get(handler, method) as (p: Record<string, unknown>) => Promise<unknown>;
    return fn.call(handler, params);
  }

  function createHandler() {
    const create = vi.fn((_params: TerminalCreateParams) => ({ terminalId: 't1', pid: 7 }));
    const handler = makeHandler({});
    handler.setTerminalCapabilityMode('enabled');
    Reflect.set(handler, 'terminalManager', { dispose: vi.fn(), create });
    return { handler, create };
  }

  it('accepts env in the spec shape — one {name,value} per entry', async () => {
    const { handler, create } = createHandler();
    await call(handler, 'handleTerminalCreate', {
      command: 'git',
      env: [
        { name: 'GIT_AUTHOR_NAME', value: 'qs' },
        { name: 'LC_ALL', value: 'C' },
      ],
    });

    expect(create.mock.calls[0][0]).toMatchObject({ env: { GIT_AUTHOR_NAME: 'qs', LC_ALL: 'C' } });
    handler.dispose();
  });

  it('still accepts the map shape some agents send', async () => {
    const { handler, create } = createHandler();
    await call(handler, 'handleTerminalCreate', { command: 'git', env: { LC_ALL: 'C' } });

    expect(create.mock.calls[0][0]).toMatchObject({ env: { LC_ALL: 'C' } });
    handler.dispose();
  });

  it('keeps the usable variables when one entry is unreadable', async () => {
    const { handler, create } = createHandler();
    await call(handler, 'handleTerminalCreate', {
      command: 'git',
      env: [{ name: 'KEEP', value: '1' }, { name: 42 }, 'nope', { value: 'nameless' }],
    });

    expect(create.mock.calls[0][0]).toMatchObject({ env: { KEEP: '1' } });
    handler.dispose();
  });

  it('runs with no env at all when the agent omitted it', async () => {
    const { handler, create } = createHandler();
    await call(handler, 'handleTerminalCreate', { command: 'ls', cwd: null });

    expect(create.mock.calls[0][0]).toMatchObject({ env: undefined, cwd: undefined });
    handler.dispose();
  });

  it('passes the agent\'s own output ceiling to the manager', async () => {
    const { handler, create } = createHandler();
    await call(handler, 'handleTerminalCreate', { command: 'ls', outputByteLimit: 2048 });

    expect(create.mock.calls[0][0]).toMatchObject({ outputByteLimit: 2048 });
    handler.dispose();
  });

  it('names the field a create actually failed on', async () => {
    const { handler } = createHandler();
    // The command was there; `args` was not. Saying "Missing required
    // parameter: command" would send the agent off to fix the wrong field.
    await expect(call(handler, 'handleTerminalCreate', { command: 'ls', args: 'origin' })).rejects.toThrow(/args/);
    handler.dispose();
  });
});
