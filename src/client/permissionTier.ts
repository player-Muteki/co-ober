import type { CoOberSettings, FsCapabilityMode, PermissionLevel, TerminalCapabilityMode } from '../types';

export interface CapabilityTierTarget {
  setFsCapabilityMode(mode: FsCapabilityMode, maxBytes?: number): void;
  setTerminalCapabilityMode(mode: TerminalCapabilityMode, timeoutMs?: number, maxOutputBytes?: number): void;
}

/**
 * Enforce the selected permission tier on client-side capabilities.
 *
 * `readonly` and `plan` both mean nothing of the user's may change, so this
 * client closes its own mutating surfaces — file writes and command
 * execution — no matter what the capability settings allow. The agent's own
 * permission prompt is not a check this client can see before honouring an
 * `fs/write_text_file` or `terminal/create` call, so the tier is the only gate
 * on that path. `safe` and `yolo` defer to the settings, and every grant they
 * let through is reported back into the transcript (see `onCapabilityGrant`).
 */
export function applyPermissionTier(target: CapabilityTierTarget, mode: PermissionLevel, settings: CoOberSettings): void {
  if (mode === 'readonly' || mode === 'plan') {
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
