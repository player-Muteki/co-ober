import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from './types';

describe('DEFAULT_SETTINGS', () => {
  it('should have all required properties', () => {
    expect(DEFAULT_SETTINGS).toHaveProperty('opencodePath', 'opencode');
    expect(DEFAULT_SETTINGS).toHaveProperty('defaultAgent', 'build');
    expect(DEFAULT_SETTINGS).toHaveProperty('defaultModel', '');
    expect(DEFAULT_SETTINGS).toHaveProperty('defaultEffort', 'default');
    expect(DEFAULT_SETTINGS).toHaveProperty('permissionMode', 'safe');
    expect(DEFAULT_SETTINGS).toHaveProperty('defaultNoteFolder', 'opencode-sync');
    expect(DEFAULT_SETTINGS).toHaveProperty('systemPrompt', '');
    expect(DEFAULT_SETTINGS).toHaveProperty('maxNoteSize', 8000);
    expect(DEFAULT_SETTINGS).toHaveProperty('autoConnect', true);
    expect(DEFAULT_SETTINGS).toHaveProperty('autoScrollEnabled', true);
    expect(DEFAULT_SETTINGS).toHaveProperty('maxSessionMessages', 200);
    expect(DEFAULT_SETTINGS).toHaveProperty('sessionRetentionDays', 30);
    expect(DEFAULT_SETTINGS).toHaveProperty('mcpServers', []);
    expect(DEFAULT_SETTINGS).toHaveProperty('customSkills', []);
    expect(DEFAULT_SETTINGS).toHaveProperty('customAgents', []);
    expect(DEFAULT_SETTINGS).toHaveProperty('activeCustomAgentId', '');
    expect(DEFAULT_SETTINGS).toHaveProperty('commonModels', []);
  });

  it('should have default sync rules', () => {
    expect(DEFAULT_SETTINGS.syncRules).toHaveLength(2);
    expect(DEFAULT_SETTINGS.syncRules[0].toolName).toBe('edit');
    expect(DEFAULT_SETTINGS.syncRules[1].toolName).toBe('write');
  });

  it('should have valid permission mode', () => {
    const validModes = ['yolo', 'plan', 'safe'] as const;
    expect(validModes).toContain(DEFAULT_SETTINGS.permissionMode);
  });
});
