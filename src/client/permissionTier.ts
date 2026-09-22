import type { CoOberSettings, FsCapabilityMode, PermissionLevel, TerminalCapabilityMode } from '../types';

export interface CapabilityTierTarget {
  setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void;
  setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void;
}

/**
 * Enforce the selected permission tier on client-side capabilities.
 * The readonly tier hard-disables agent file writes and terminal
 * execution regardless of the agent's own permission requests; other
 * tiers defer to the user's capability settings.
 */
export function applyPermissionTier(target: CapabilityTierTarget, mode: PermissionLevel, settings: CoOberSettings): void {
  if (mode === 'readonly') {
    target.setFsCapabilityMode('readonly');
    target.setTerminalCapabilityMode('disabled');
    return;
  }
  target.setFsCapabilityMode(settings.fsCapability ?? 'enabled', settings.maxNoteSize);
  target.setTerminalCapabilityMode(
    settings.terminalCapability ?? 'enabled',
    settings.terminalTimeoutMs,
    settings.terminalMaxOutputBytes,
  );
}
