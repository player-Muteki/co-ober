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
    const result = await ask(handler, { toolCall: { title: 'x' }, options: validOptions });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(unreadable).toHaveBeenCalledWith(expect.stringContaining('sessionId'));
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
