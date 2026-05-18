import type { AvailableCommand } from '../types';

// Parse slash command from prompt text
export interface ParsedCommand {
  name: string;
  args: string;
  raw: string;
}

// Try to parse a /command from the prompt text
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

// Check if a command is built-in (compact)
export function isBuiltInCommand(name: string): boolean {
  return name === 'compact';
}

// Format command for display in toolbar
export function formatCommandDisplayName(cmd: AvailableCommand): string {
  return `/${cmd.name}`;
}
