import type { AvailableCommand } from '../types';

/** Result of parsing a candidate slash command from user input. */
export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

/**
 * Try to parse a /command from the beginning of the input string.
 *
 * Returns null when the input is a plain message, not a slash command.
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
  if (!match) return null;

  const name = match[1];
  const args = match[2] ?? '';

  // Reject if it looks like a mention (@...) mixed in
  if (name.startsWith('@')) return null;

  return { name, args, raw: `/${name}${args ? ' ' + args : ''}` };
}

/**
 * Format a command for display in the popover / toolbar.
 */
export function formatCommandDisplayName(cmd: AvailableCommand): string {
  return `/${cmd.name}`;
}
