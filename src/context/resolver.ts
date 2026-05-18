import { Vault, TFile } from 'obsidian';

/** Resolve note references into structured content blocks */
export class ContextResolver {
  constructor(private vault: Vault, private maxBytes = 8000) {}

  /** Read and return note content up to maxBytes */
  async resolveNote(path: string): Promise<{ name: string; content: string } | null> {
    const abstract = this.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return null;
    try {
      const content = await this.vault.read(abstract);
      const name = abstract.basename;
      if (content.length > this.maxBytes) {
        return { name, content: content.slice(0, this.maxBytes) + '... [truncated]' };
      }
      return { name, content };
    } catch {
      return null;
    }
  }

  /** Resolve multiple notes, returning structured context blocks */
  async resolveAll(paths: string[]): Promise<Array<{ name: string; content: string }>> {
    const results: Array<{ name: string; content: string }> = [];
    for (const path of paths) {
      const result = await this.resolveNote(path);
      if (result) results.push(result);
    }
    return results;
  }

  /** Get note paths matching a search query (case-insensitive basename) */
  search(query: string): Array<{ name: string; path: string }> {
    const q = query.toLowerCase();
    return this.vault
      .getMarkdownFiles()
      .filter((f: TFile) => f.basename.toLowerCase().includes(q))
      .map((f: TFile) => ({ name: f.basename, path: f.path }));
  }
}
