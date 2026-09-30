import { type SlashCommandDef, type CommandSource } from '../registry';
import { parseCommandFile } from './FrontmatterParser';
import { type Vault, TFile, type TAbstractFile, Notice } from 'obsidian';
import { t } from '../../i18n/index';

/** How many paths fit in one notice before the rest become a count. */
const MAX_LISTED_COMMAND_FILES = 3;

function listForNotice(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_COMMAND_FILES);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest})` : shown.join(', ');
}

/**
 * Scan `.opencode/commands/*.md` and `.opencode/{command,commands}/**\/*.md`
 * files in the vault and produce slash command definitions.
 *
 * The command name is derived from the filename (without `.md`).
 * Frontmatter fields control the popover entry; the body is used as the
 * command template (expanded via TemplateExpander at send time).
 *
 * File format (Opencode-compatible):
 * ```markdown
 * ---
 * description: Review staged changes
 * argument-hint: "[files]"
 * ---
 * Review the following changes: $ARGUMENTS
 * ```
 */
export class FileCommandStorage implements CommandSource {
  readonly type = 'file' as const;
  private vault: Vault;
  private baseDir: string;
  /** Store the latest defs so load() can return synchronously. */
  private cached: SlashCommandDef[] = [];
  private lastReported = '';

  constructor(vault: Vault, baseDir: string = '.opencode') {
    this.vault = vault;
    this.baseDir = baseDir;
  }

  async load(): Promise<SlashCommandDef[]> {
    const defs: SlashCommandDef[] = [];
    const unreadable: string[] = [];
    const shapeless: string[] = [];
    const ambiguous: string[] = [];
    const takenNames = new Map<string, string>();
    const files = this.collectFiles();

    for (const file of files) {
      try {
        const raw = await this.vault.read(file);
        const parsed = parseCommandFile(raw);
        // A file with no complete frontmatter block — either no opening `---`
        // at all, or one that never closes — is not a command, and the popover
        // just lost an entry the user can see on disk. Say which, without
        // claiming a missing block for a file whose block is only unfinished.
        if (!parsed) {
          shapeless.push(file.path);
          continue;
        }

        const name = file.basename;
        // Skip non-user-invocable commands
        if (parsed.frontmatter.userInvocable === false || parsed.frontmatter['user-invocable'] === false) continue;

        // The trigger is the bare basename while the scan runs several
        // directories deep, so `.opencode/commands/a/review.md` and
        // `.../b/review.md` define the same command and the registry keeps
        // whichever it was handed first. A command the reader can see on disk
        // then never appears — or worse, runs the other file's template — with
        // nothing said about it. Name the file that lost, and take the shallowest
        // path as the winner so which template reaches the agent is not decided
        // by vault enumeration order.
        const taken = takenNames.get(name.toLowerCase());
        if (taken !== undefined) {
          ambiguous.push(file.path);
          continue;
        }
        takenNames.set(name.toLowerCase(), file.path);

        const description = parsed.frontmatter.description ?? '';
        const argumentHint = parsed.frontmatter.argumentHint ?? parsed.frontmatter['argument-hint'];

        defs.push({
          id: `file:${name}`,
          trigger: name,
          title: name,
          description,
          category: 'agent',
          source: 'file',
          argumentHint,
          template: parsed.body || undefined,
          icon: 'file-text',
          run: async (_args: string) => {
            // Dispatch is handled by the controller's send() path —
            // file commands are sent as text to the ACP agent after
            // template expansion. This placeholder prevents
            // TypeScript errors when the command is intercepted
            // before run() is called.
          },
        });
      } catch (e) {
        console.error(`[co-ober] failed to read command file ${file.path}:`, e);
        unreadable.push(file.path);
      }
    }

    this.reportSkipped(unreadable, shapeless, ambiguous);
    this.cached = defs;
    return defs;
  }

  /**
   * A command that goes missing from the / popover looks like a plugin bug, not
   * like a broken file, so name the files — once per distinct set, because the
   * watcher rescans on every edit and the same broken file must not shout again.
   */
  private reportSkipped(unreadable: string[], shapeless: string[], ambiguous: string[]): void {
    const signature = `${unreadable.join('|')}#${shapeless.join('|')}#${ambiguous.join('|')}`;
    if (signature === this.lastReported) return;
    this.lastReported = signature;
    if (unreadable.length > 0) {
      new Notice(t().notice.commandFilesUnreadable.replace('{files}', listForNotice(unreadable)));
    }
    if (shapeless.length > 0) {
      new Notice(t().notice.commandFilesShapeless.replace('{files}', listForNotice(shapeless)));
    }
    if (ambiguous.length > 0) {
      new Notice(t().notice.commandFilesAmbiguous.replace('{files}', listForNotice(ambiguous)));
    }
  }

  watch(onChange: () => void): () => void {
    // vault.on/offref may not be available in all environments (e.g. tests)
    if (typeof this.vault.on !== 'function' || typeof this.vault.offref !== 'function') {
      return () => {};
    }

    const patterns = this.getPatterns();

    const handleFileChange = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      for (const pattern of patterns) {
        if (file.path.startsWith(pattern)) {
          onChange();
          return;
        }
      }
    };

    const ref = this.vault.on('modify', handleFileChange);
    const ref2 = this.vault.on('create', handleFileChange);
    const ref3 = this.vault.on('delete', handleFileChange);

    return () => {
      this.vault.offref(ref);
      this.vault.offref(ref2);
      this.vault.offref(ref3);
    };
  }

  /** Return the cached list synchronously. */
  getCached(): SlashCommandDef[] {
    return this.cached;
  }

  // ── Private ──

  private collectFiles(): TFile[] {
    const allMd = this.vault.getMarkdownFiles();
    // Shallowest first, then by path: two files that share a basename are
    // resolved in this order, so the winner is a property of the tree and not
    // of how the vault happened to enumerate it today.
    return allMd
      .filter((f) => this.matchesPattern(f.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  }

  private matchesPattern(path: string): boolean {
    const lower = path.toLowerCase();
    for (const pattern of this.getPatterns()) {
      if (lower.startsWith(pattern.toLowerCase())) return true;
    }
    return false;
  }

  private getPatterns(): string[] {
    const dir = this.baseDir.replace(/\/+$/, '');
    return [
      `${dir}/commands/`,
      `${dir}/command/`,
    ];
  }
}
