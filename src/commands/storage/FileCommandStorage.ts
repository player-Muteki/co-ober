import { type SlashCommandDef, type CommandSource } from '../registry';
import { parseCommandFile } from './FrontmatterParser';
import { type Vault, TFile, type TAbstractFile } from 'obsidian';

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

  constructor(vault: Vault, baseDir: string = '.opencode') {
    this.vault = vault;
    this.baseDir = baseDir;
  }

  async load(): Promise<SlashCommandDef[]> {
    const defs: SlashCommandDef[] = [];
    const files = this.collectFiles();

    for (const file of files) {
      try {
        const raw = await this.vault.read(file);
        const parsed = parseCommandFile(raw);
        if (!parsed) continue;

        const name = file.basename;
        // Skip non-user-invocable commands
        if (parsed.frontmatter.userInvocable === false || parsed.frontmatter['user-invocable'] === false) continue;

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
      }
    }

    this.cached = defs;
    return defs;
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
    return allMd.filter((f) => this.matchesPattern(f.path));
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
