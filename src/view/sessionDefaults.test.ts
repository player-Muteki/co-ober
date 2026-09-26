import { describe, expect, it, vi } from 'vitest';
import { applyDefaultSessionSettings } from './sessionDefaults';
import type { CoOberSettings, SessionConfigOption } from '../types';

describe('applyDefaultSessionSettings', () => {
  it('applies configured default agent, model, and effort to a new session', async () => {
    const client = {
      setMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setConfigOption: vi.fn().mockResolvedValue([] as SessionConfigOption[]),
    };
    const settings = {
      defaultAgent: 'docs',
      defaultModel: 'openai/gpt',
      defaultEffort: 'high',
    } as CoOberSettings;

    await applyDefaultSessionSettings(client, 'session-1', settings);

    expect(client.setMode).toHaveBeenCalledWith('session-1', 'docs');
    expect(client.setModel).toHaveBeenCalledWith('session-1', 'openai/gpt');
    expect(client.setConfigOption).toHaveBeenCalledWith('session-1', 'effort', 'high');
  });

  it('reports the defaults the agent refused instead of failing the session', async () => {
    const client = {
      setMode: vi.fn().mockRejectedValue(new Error('agent not found')),
      setModel: vi.fn().mockResolvedValue(undefined),
      setConfigOption: vi.fn().mockRejectedValue(new Error('no such config option')),
    };
    const settings = {
      defaultAgent: 'docs',
      defaultModel: 'openai/gpt',
      defaultEffort: 'high',
    } as CoOberSettings;

    const missed = await applyDefaultSessionSettings(client, 'session-1', settings);

    expect(client.setModel).toHaveBeenCalled();
    expect(missed).toEqual(['Default Agent', 'Default Thinking Effort']);
  });

  it('does not apply empty defaults or default effort', async () => {
    const client = {
      setMode: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setConfigOption: vi.fn().mockResolvedValue([] as SessionConfigOption[]),
    };
    const settings = {
      defaultAgent: '',
      defaultModel: '',
      defaultEffort: 'default',
    } as CoOberSettings;

    await applyDefaultSessionSettings(client, 'session-1', settings);

    expect(client.setMode).not.toHaveBeenCalled();
    expect(client.setModel).not.toHaveBeenCalled();
    expect(client.setConfigOption).not.toHaveBeenCalled();
  });
});
