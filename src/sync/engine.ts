import type { Vault, TFile } from 'obsidian';
import type { SyncRule } from '../types';
import { ruleMatches, buildSyncNote } from './templates';
import { Mutex } from '../utils/mutex';

export interface SyncFailure {
  rule: SyncRule;
  error: Error;
}

export class SyncEngine {
  private mutex = new Mutex();

  constructor(private vault: Vault, private rules: SyncRule[]) {}

  private isTFile(file: unknown): file is TFile {
    return file instanceof Object && 'vault' in file && 'extension' in file;
  }

  async process(ctx: import('./templates').SyncContext): Promise<SyncFailure[]> {
    return this.mutex.runExclusive(async () => {
      const failures: SyncFailure[] = [];
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
          console.error('[copsilot] sync rule failed:', rule.toolName, e);
          failures.push({ rule, error: e instanceof Error ? e : new Error(String(e)) });
        }
      }
      return failures;
    });
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (!folder || folder === '/') return;
    const parts = folder.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.vault.getAbstractFileByPath(current)) continue;
      await this.vault.createFolder(current);
    }
  }
}
