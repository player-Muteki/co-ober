import type { Vault, TFile } from 'obsidian';
import type { SyncRule } from '../types';
import { ruleMatches, buildSyncNote } from './templates';

export class SyncEngine {
  constructor(private vault: Vault, private rules: SyncRule[]) {}

  private isTFile(file: any): file is TFile {
    return file instanceof Object && 'vault' in file && 'extension' in file;
  }

  async process(ctx: import('./templates').SyncContext): Promise<void> {
    for (const rule of this.rules) {
      if (!ruleMatches(rule, ctx)) continue;
      const note = buildSyncNote(ctx, rule.folder, rule.filenameTemplate, rule.template);
      const existing = this.vault.getAbstractFileByPath(note.path);
      if (existing && this.isTFile(existing)) {
        await this.vault.modify(existing, note.content);
      } else {
        await this.vault.create(note.path, note.content);
      }
    }
  }
}
