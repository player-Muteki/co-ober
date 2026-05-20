import { Vault, TFile } from 'obsidian';
import type { ContextRef } from '../types';

export class ContextMention {
  private refs: ContextRef[] = [];

  constructor(private vault: Vault) {}

  addRef(ref: ContextRef): void {
    if (!this.refs.some((r) => r.id === ref.id)) this.refs.push(ref);
  }

  removeRef(id: string): void { this.refs = this.refs.filter((r) => r.id !== id); }
  getAllRefs(): ContextRef[] { return [...this.refs]; }
  clear(): void { this.refs = []; }

  hasRef(id: string): boolean { return this.refs.some((r) => r.id === id); }

  listAllNotes(): ContextRef[] {
    return this.vault.getMarkdownFiles().map((f: TFile) => ({
      id: f.path, type: 'note' as const, name: f.basename, path: f.path,
    }));
  }
}
