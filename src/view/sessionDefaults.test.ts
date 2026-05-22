import { describe, expect, it, vi } from 'vitest';
import { applyDefaultSessionSettings } from './sessionDefaults';
import type { CopsidianSettings, SessionConfigOption } from '../types';

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
    } as CopsidianSettings;

    await applyDefaultSessionSettings(client, 'session-1', settings);

    expect(client.setMode).toHaveBeenCalledWith('session-1', 'docs');
    expect(client.setModel).toHaveBeenCalledWith('session-1', 'openai/gpt');
    expect(client.setConfigOption).toHaveBeenCalledWith('session-1', 'effort', 'high');
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
    } as CopsidianSettings;

    await applyDefaultSessionSettings(client, 'session-1', settings);

    expect(client.setMode).not.toHaveBeenCalled();
    expect(client.setModel).not.toHaveBeenCalled();
    expect(client.setConfigOption).not.toHaveBeenCalled();
  });
});
