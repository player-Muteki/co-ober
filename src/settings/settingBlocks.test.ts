// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { addMcpServerBlock, nextRuleId } from './settingBlocks';
import type { CoOberSettings, McpServerConfig } from '../types';

installObsidianDomHelpers();

function render(caps: Parameters<typeof addMcpServerBlock>[5]): { http: HTMLOptionElement; sse: HTMLOptionElement } {
  const server = {
    type: 'stdio',
    id: 's1',
    enabled: true,
    name: 'demo',
    command: 'npx',
    args: [],
    env: [],
  } as McpServerConfig;
  const settings = { mcpServers: [server] } as unknown as CoOberSettings;
  const container = document.createElement('div');
  addMcpServerBlock(container, server, settings, vi.fn(async () => {}), vi.fn(), caps);
  const http = container.querySelector<HTMLOptionElement>('option[value="http"]');
  const sse = container.querySelector<HTMLOptionElement>('option[value="sse"]');
  if (!http || !sse) throw new Error('transport options did not render');
  return { http, sse };
}

describe('MCP transport gating reads an affirmed capability, not its absence (0.2.7 stage 2)', () => {
  it('keeps http/sse selectable only when the agent affirmed them', () => {
    const { http, sse } = render({ http: true, sse: true });
    expect(http.disabled).toBe(false);
    expect(sse.disabled).toBe(false);
  });

  it('disables a transport the agent did not affirm', () => {
    // An omitted flag used to fall through to "enabled", so the reader offered
    // a server type the agent would then reject on connect.
    const { http, sse } = render({});
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });

  it('disables a transport the agent explicitly answered false', () => {
    const { http, sse } = render({ http: false, sse: false });
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });

  it('disables both when the agent reported no transport capability at all', () => {
    const { http, sse } = render(undefined);
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });
});

describe('nextRuleId avoids an id already in use (0.2.7 stage 3)', () => {
  it('returns the bare timestamp when nothing collides', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      expect(nextRuleId([])).toBe('1700000000000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('suffixes past a collision instead of handing out a duplicate id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      // Two adds in the same millisecond used to collide and overwrite.
      const taken = [{ id: '1700000000000' }, { id: '1700000000000-1' }];
      expect(nextRuleId(taken)).toBe('1700000000000-2');
    } finally {
      vi.useRealTimers();
    }
  });
});
