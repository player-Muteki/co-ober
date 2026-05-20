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
      try {
        const note = buildSyncNote(ctx, rule.folder, rule.filenameTemplate, rule.template);
        await this.ensureFolder(rule.folder);
        const existing = this.vault.getAbstractFileByPath(note.path);
        if (existing && this.isTFile(existing)) {
          await this.vault.modify(existing, note.content);
        } else {
          await this.vault.create(note.path, note.content);
        }
      } catch (e) {
        console.error('[copsidian] sync rule failed:', rule.toolName, e);
      }
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder || folder === '/') return;
    const existing = this.vault.getAbstractFileByPath(folder);
    if (existing) return;
    await this.vault.createFolder(folder);
  }
}
