import { describe, it, expect, vi } from 'vitest';
import { AcpRequestHandler } from './AcpRequestHandler';
import type { AcpJsonRpcTransport } from './AcpJsonRpcTransport';
import type { PermissionRequest } from '../types';

function makeHandler(options: {
  onPermissionRequest?: (req: PermissionRequest) => Promise<string>;
  onPermissionUnreadable?: (summary: string) => void;
}): AcpRequestHandler {
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
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('toolCall'));
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
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('no selectable options'));
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
