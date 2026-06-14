import type { AvailableCommand } from '../types';

/** Category grouping for the slash popover. */
export type SlashCategory = 'session' | 'view' | 'agent';

/** Source badge shown in the popover for custom commands. */
export type CommandSource = 'builtin' | 'acp' | 'custom';

/**
 * Full definition of a single slash command.
 *
 * Mirrors the shape used by OpenCode's TUI commands but adapted
 * for copsilot's local + ACP-hybrid execution model.
 */
export interface SlashCommandDef {
  /** Stable unique id, e.g. "compact" or "session.new" */
  id: string;
  /** The /-trigger, e.g. "compact" → /compact */
  trigger: string;
  /** Alternative triggers, e.g. ["summarize"] for /compact */
  aliases?: string[];
  /** Human-readable title shown in the popover. */
  title: string;
  /** Short description shown beside the title. */
  description: string;
  /** Grouping key for the popover section headers. */
  category: SlashCategory;
  /** Whether it runs locally or is forwarded via ACP. */
  type: CommandSource;
  /** Optional Obsidian icon name (for future use). */
  icon?: string;
  /** Optional runtime gate — command is hidden when this returns false. */
  enabled?: () => boolean;
  /** Execute the command. Receives parsed args. */
  run: (args: string) => Promise<void>;
}

/**
 * Central registry for all slash commands.
 *
 * Three sources feed into the registry:
 *  1. **Builtin** – registered at startup, executed locally.
 *  2. **ACP** – synced from `available_commands_update` notifications.
 *  3. **Custom** – (future) from sync data / MCP / Skill definitions.
 */
export class CommandRegistry {
  /** trigger → builtin definition (includes aliases as extra keys). */
  private builtins = new Map<string, SlashCommandDef>();
  /** ACP-synced commands, indexed by name. */
  private acpCommands = new Map<string, SlashCommandDef>();
  /** All definitions in display order (for popover). */
  private ordered: SlashCommandDef[] = [];

  // ── Registration ──

  registerBuiltin(def: SlashCommandDef): void {
    this.builtins.set(def.trigger, def);
    for (const alias of def.aliases ?? []) {
      this.builtins.set(alias, def);
    }
    this.rebuildOrder();
  }

  /** Replace the ACP command list (called on every update). */
  updateAcpCommands(commands: AvailableCommand[]): void {
    this.acpCommands.clear();
    for (const cmd of commands) {
      this.acpCommands.set(cmd.name, {
        id: cmd.name,
        trigger: cmd.name,
        title: cmd.name,
        description: cmd.description ?? '',
        category: 'agent',
        type: 'acp',
        run: async () => { /* dispatched by send() path */ },
      });
    }
    this.rebuildOrder();
  }

  // ── Lookup ──

  /** Find all definitions whose trigger starts with `prefix`. */
  search(prefix: string): SlashCommandDef[] {
    const lower = prefix.toLowerCase();
    return this.ordered.filter(
      (d) =>
        d.trigger.startsWith(lower) ||
        (d.aliases ?? []).some((a) => a.startsWith(lower)),
    );
  }

  /** Find a single def by exact trigger name (with or without leading /). */
  find(name: string): SlashCommandDef | undefined {
    const key = name.replace(/^\//, '').toLowerCase();
    return this.builtins.get(key) ?? this.acpCommands.get(key);
  }

  isBuiltin(name: string): boolean {
    return this.builtins.has(name.replace(/^\//, '').toLowerCase());
  }

  /** Full ordered list for popover rendering. */
  getAll(): SlashCommandDef[] {
    return this.ordered;
  }

  // ── Internals ──

  private rebuildOrder(): void {
    const seen = new Set<string>();
    this.ordered = [];

    // Builtins first (ordered by priority within category)
    const builtins = [...this.builtins.values()].filter((d) => {
      const key = d.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.ordered.push(...builtins);

    // ACP commands after (no duplicates with builtins)
    for (const cmd of this.acpCommands.values()) {
      if (!seen.has(cmd.id)) {
        seen.add(cmd.id);
        this.ordered.push(cmd);
      }
    }
  }
}

/** Singleton shared across the app. */
export const commandRegistry = new CommandRegistry();
