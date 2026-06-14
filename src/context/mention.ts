import { App, TFile } from 'obsidian';
import type { ContextRef } from '../types';

export class ContextMention {
  private refs: ContextRef[] = [];

  constructor(private app: App) {}

  addRef(ref: ContextRef): void {
    if (!this.refs.some((r) => r.id === ref.id)) this.refs.push(ref);
  }

  removeRef(id: string): void { this.refs = this.refs.filter((r) => r.id !== id); }
  getAllRefs(): ContextRef[] { return [...this.refs]; }
  clear(): void { this.refs = []; }

  hasRef(id: string): boolean { return this.refs.some((r) => r.id === id); }

  /**
   * List all Markdown files in the vault using metadataCache.
   * Falls back to vault.getMarkdownFiles() if metadataCache is unavailable.
   */
  listAllNotes(): ContextRef[] {
    const vault = this.app.vault;
    const files = vault.getMarkdownFiles()
      .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0))
      .map((f: TFile) => ({
      id: f.path,
      type: 'note' as const,
      name: f.basename,
      path: f.path,
    }));
    return files;
  }
}
