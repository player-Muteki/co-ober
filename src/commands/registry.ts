import type { AvailableCommand } from '../types';

/** Source badge shown in the popover for commands from different origins. */
export type CommandSourceType = 'builtin' | 'acp' | 'file' | 'mcp' | 'skill';

/** Category grouping for the slash popover. */
export type SlashCategory = 'session' | 'view' | 'agent';

/**
 * Full definition of a single slash command.
 *
 * Mirrors the shape used by the ACP protocol but extended for copsilot's
 * multi-source (builtin + ACP + file + MCP + skill) execution model.
 */
export interface SlashCommandDef {
  /** Stable unique id, e.g. "compact" or "add-dir". */
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
  /** Which origin this command came from (determines badge colour). */
  source: CommandSourceType;
  /** Optional argument hint displayed in grey (e.g. "[path/to/dir]"). */
  argumentHint?: string;
  /** Template body — expanded when the command is dispatched. */
  template?: string;
  /** Optional Obsidian icon name (for future use). */
  icon?: string;
  /** Optional runtime gate — command is hidden when this returns false. */
  enabled?: () => boolean;
  /** Execute the command. Receives parsed args. */
  run: (args: string) => Promise<void>;
}

/**
 * A pluggable source of slash commands.
 *
 * Each source provides a list of definitions and optionally watches
 * for changes (file-system watchers, reconnections, etc.).
 */
export interface CommandSource {
  readonly type: CommandSourceType;
  /** Load (or reload) all commands from this source. */
  load(): Promise<SlashCommandDef[]> | SlashCommandDef[];
  /**
   * Optional live-update hook.  Returns an unsubscribe function.
   * Called once when the source is first registered.
   */
  watch?(onChange: () => void): () => void;
}

/**
 * Central registry for all slash commands.
 *
 * Commands come from multiple pluggable sources:
 *  1. **builtin** - registered via `registerSource`, executed locally.
 *  2. **acp**    - synced from `available_commands_update` notifications.
 *  3. **file**   - from `.opencode/commands/*.md` (FileCommandStorage).
 *  4. **mcp**    - discovered from MCP prompts.
 *  5. **skill**  - from `.opencode/skills/SKILL.md` files.
 *
 * Ordering: builtins first (by registration order), then external sources
 * in registration order.  Duplicate `id`s are resolved by keeping the
 * first occurrence (builtins win over external).
 */
export class CommandRegistry {
  /** Registered source providers. */
  private sources: CommandSource[] = [];

  /** trigger → builtin definition (includes aliases as extra keys). */
  private builtins = new Map<string, SlashCommandDef>();
  /** Non-builtin definitions, indexed by trigger. */
  private externals = new Map<string, SlashCommandDef>();
  /** All definitions in display order (for popover). */
  private ordered: SlashCommandDef[] = [];
  /** Unsubscribe functions for source watchers. */
  private unwatches: Array<() => void> = [];
  /** Global onChange callback (notifies the view to refresh). */
  private onChange: (() => void) | null = null;

  // ── Lifecycle ──

  /**
   * Register a pluggable command source.
   *
   * If `watch` is provided, it is called immediately so the source can
   * push live updates through `rebuildOrder()`.
   */
  registerSource(source: CommandSource): void {
    this.sources.push(source);
    const result = source.load();
    const defs = result instanceof Promise ? [] : result;
    this.ingestSourceDefs(source.type, defs);

    if (source.watch) {
      const unwatch = source.watch(() => {
        this.reloadSource(source);
      });
      this.unwatches.push(unwatch);
    }

    // If load() returned a promise, resolve and re-ingest
    if (result instanceof Promise) {
      result.then((defs) => {
        // Remove old defs from this source first, then re-add
        this.removeSourceDefs(source.type);
        this.ingestSourceDefs(source.type, defs);
        this.rebuildOrder();
      });
    } else {
      this.rebuildOrder();
    }
  }

  /** Reload a specific source and rebuild the ordered list. */
  private async reloadSource(source: CommandSource): Promise<void> {
    try {
      const defs = await source.load();
      this.removeSourceDefs(source.type);
      this.ingestSourceDefs(source.type, defs);
      this.rebuildOrder();
    } catch (e) {
      console.error(`[copsilot] failed to reload source ${source.type}:`, e);
    }
  }

  /** Remove all definitions from a given source type. */
  private removeSourceDefs(type: CommandSourceType): void {
    for (const [key, def] of this.externals) {
      if (def.source === type) {
        this.externals.delete(key);
        // Also remove alias entries
        for (const alias of def.aliases ?? []) {
          this.externals.delete(alias);
        }
      }
    }
  }

  /** Ingest definitions from a source into the externals map. */
  private ingestSourceDefs(type: CommandSourceType, defs: SlashCommandDef[]): void {
    for (const def of defs) {
      const defWithSource = { ...def, source: type };
      const key = def.trigger.toLowerCase();
      if (!this.externals.has(key) && !this.builtins.has(key)) {
        this.externals.set(key, defWithSource);
      }
      for (const alias of def.aliases ?? []) {
        const aliasKey = alias.toLowerCase();
        if (!this.externals.has(aliasKey) && !this.builtins.has(aliasKey)) {
          this.externals.set(aliasKey, defWithSource);
        }
      }
    }
  }

  // ── Registration (legacy API, delegates to sources) ──

  /** Register a single builtin command (convenience wrapper). */
  registerBuiltin(def: SlashCommandDef): void {
    this.builtins.set(def.trigger, { ...def, source: 'builtin' });
    for (const alias of def.aliases ?? []) {
      this.builtins.set(alias, { ...def, source: 'builtin' });
    }
    this.rebuildOrder();
  }

  /** Replace all ACP-synced commands. */
  updateAcpCommands(commands: AvailableCommand[]): void {
    // Clear existing ACP entries from externals
    this.removeSourceDefs('acp');

    for (const cmd of commands) {
      const key = cmd.name.toLowerCase();
      if (this.builtins.has(key)) continue; // builtin always wins
      this.externals.set(key, {
        id: cmd.name,
        trigger: cmd.name,
        title: cmd.name,
        description: cmd.description ?? '',
        category: 'agent',
        source: 'acp',
        run: async () => { /* dispatched by send() path */ },
      });
    }
    this.rebuildOrder();
  }

  // ── Subscription ──

  /** Subscribe to command list changes (e.g. to refresh the popover). */
  subscribe(callback: () => void): () => void {
    this.onChange = callback;
    return () => { this.onChange = null; };
  }

  // ── Lookup ──

  /** Find all definitions whose trigger starts with `prefix`. */
  search(prefix: string): SlashCommandDef[] {
    const lower = prefix.toLowerCase();
    return this.ordered.filter(
      (d) =>
        d.trigger.toLowerCase().startsWith(lower) ||
        (d.aliases ?? []).some((a) => a.toLowerCase().startsWith(lower)),
    );
  }

  /** Find a single def by exact trigger name (with or without leading /). */
  find(name: string): SlashCommandDef | undefined {
    const key = name.replace(/^\//, '').toLowerCase();
    return this.builtins.get(key) ?? this.externals.get(key);
  }

  isBuiltin(name: string): boolean {
    return this.builtins.has(name.replace(/^\//, '').toLowerCase());
  }

  /** Full ordered list for popover rendering — skips disabled items. */
  getAll(): SlashCommandDef[] {
    return this.ordered.filter((d) => !d.enabled || d.enabled());
  }

  /** Grouped by category for the popover. */
  getGrouped(): Map<SlashCategory, SlashCommandDef[]> {
    const groups = new Map<SlashCategory, SlashCommandDef[]>();
    for (const def of this.getAll()) {
      const cat = def.category;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(def);
    }
    return groups;
  }

  // ── Internals ──

  private rebuildOrder(): void {
    const seen = new Set<string>();
    this.ordered = [];

    // Builtins first (ordered by registration within category)
    const builtins = [...this.builtins.values()].filter((d) => {
      const key = d.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.ordered.push(...builtins);

    // External sources after (no duplicates with builtins)
    for (const [, def] of this.externals) {
      if (!seen.has(def.id)) {
        seen.add(def.id);
        this.ordered.push(def);
      }
    }

    // Notify subscribers
    this.onChange?.();
  }

  /** Dispose all watchers (call on plugin unload). */
  dispose(): void {
    for (const unwatch of this.unwatches) {
      try { unwatch(); } catch { /* ignore */ }
    }
    this.unwatches = [];
    this.sources = [];
    this.builtins.clear();
    this.externals.clear();
    this.ordered = [];
    this.onChange = null;
  }
}

/** Singleton shared across the app. */
export const commandRegistry = new CommandRegistry();
