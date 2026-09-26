import { describe, expect, it, vi } from 'vitest';
import { applyPermissionTier } from './permissionTier';
import type { CoOberSettings } from '../types';

function makeSettings(overrides: Partial<CoOberSettings> = {}): CoOberSettings {
  return {
    maxNoteSize: 4242,
    terminalTimeoutMs: 1234,
    terminalMaxOutputBytes: 5678,
    fsCapability: 'enabled',
    terminalCapability: 'enabled',
    ...overrides,
  } as CoOberSettings;
}

function makeTarget() {
  return {
    setFsCapabilityMode: vi.fn(),
    setTerminalCapabilityMode: vi.fn(),
  };
}

describe('applyPermissionTier', () => {
  it('readonly tier forces fs readonly and disables the terminal', () => {
    const target = makeTarget();
    applyPermissionTier(target, 'readonly', makeSettings());

    expect(target.setFsCapabilityMode).toHaveBeenCalledWith('readonly');
    expect(target.setTerminalCapabilityMode).toHaveBeenCalledWith('disabled');
  });

  it('other tiers restore the user capability settings', () => {
    const target = makeTarget();
    const settings = makeSettings({ fsCapability: 'disabled', terminalCapability: 'disabled' });
    applyPermissionTier(target, 'yolo', settings);

    expect(target.setFsCapabilityMode).toHaveBeenCalledWith('disabled', 4242);
    expect(target.setTerminalCapabilityMode).toHaveBeenCalledWith('disabled', 1234, 5678);
  });

  it('plan tier closes the client surfaces too, whatever the settings allow', () => {
    // A plan is a promise not to change anything, and the agent's own
    // permission prompt is invisible on the fs/terminal path, so the settings
    // cannot be allowed to reopen it.
    const target = makeTarget();
    applyPermissionTier(target, 'plan', makeSettings());

    expect(target.setFsCapabilityMode).toHaveBeenCalledWith('readonly');
    expect(target.setTerminalCapabilityMode).toHaveBeenCalledWith('disabled');
  });

  it('safe and yolo tiers defer to settings as well', () => {
    for (const mode of ['safe', 'yolo'] as const) {
      const target = makeTarget();
      applyPermissionTier(target, mode, makeSettings({ fsCapability: 'readonly' }));

      expect(target.setFsCapabilityMode).toHaveBeenCalledWith('readonly', 4242);
      expect(target.setTerminalCapabilityMode).toHaveBeenCalledWith('enabled', 1234, 5678);
    }
  });

  it('plan ignores a permissive fs setting rather than honouring it', () => {
    const target = makeTarget();
    applyPermissionTier(target, 'plan', makeSettings({ fsCapability: 'enabled', terminalCapability: 'enabled' }));

    expect(target.setFsCapabilityMode).not.toHaveBeenCalledWith('enabled', 4242);
    expect(target.setTerminalCapabilityMode.mock.calls[0]).toEqual(['disabled']);
  });

  it('falls back to enabled when capability settings are unset', () => {
    const target = makeTarget();
    const settings = makeSettings();
    delete (settings as Partial<CoOberSettings>).fsCapability;
    delete (settings as Partial<CoOberSettings>).terminalCapability;
    applyPermissionTier(target, 'safe', settings);

    expect(target.setFsCapabilityMode).toHaveBeenCalledWith('enabled', 4242);
    expect(target.setTerminalCapabilityMode).toHaveBeenCalledWith('enabled', 1234, 5678);
  });
});
