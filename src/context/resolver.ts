import { Vault, TFile } from 'obsidian';
import { CONTEXT_NOTE_MAX_BYTES, TRUNCATION_MARKER } from '../constants';

/** Resolve note references into structured content blocks */
export class ContextResolver {
  constructor(private vault: Vault, private maxBytes = CONTEXT_NOTE_MAX_BYTES) {}

  /** Read and return note content up to maxBytes */
  async resolveNote(path: string): Promise<{ name: string; content: string } | null> {
    const abstract = this.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return null;
    try {
      const content = await this.vault.read(abstract);
      const name = abstract.basename;
      const encoded = new TextEncoder().encode(content);
      if (encoded.byteLength > this.maxBytes) {
        return { name, content: truncateUtf8(content, this.maxBytes) + TRUNCATION_MARKER };
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

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    result += char;
  }
  return result;
}
