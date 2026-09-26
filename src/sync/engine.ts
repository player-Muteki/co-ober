import type { Vault } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import type { SyncRule } from '../types';
import { t } from '../i18n/index';
import { ruleMatches, buildSyncNote } from './templates';
import { Mutex } from '../utils/mutex';

export interface SyncFailure {
  rule: SyncRule;
  error: Error;
}

export class SyncEngine {
  private mutex = new Mutex();

  /**
   * `readRules` is consulted for every turn instead of the list being captured
   * once: the settings tab replaces `settings.syncRules` wholesale when a rule
   * is added or deleted, so a captured array kept writing notes for rules the
   * reader had already removed and never saw the new ones.
   */
  constructor(private vault: Vault, private readRules: () => SyncRule[]) {}

  private isTFile(file: unknown): file is TFile {
    return file instanceof TFile;
  }

  async process(ctx: import('./templates').SyncContext): Promise<SyncFailure[]> {
    return this.mutex.runExclusive(async () => {
      const failures: SyncFailure[] = [];
      for (const rule of this.readRules()) {
        if (!ruleMatches(rule, ctx)) continue;
        try {
          const note = buildSyncNote(ctx, rule.folder, rule.filenameTemplate, rule.template);
          // buildSyncNote internally calls sanitizeVaultPath (8 checks);
          // invalid paths would throw before we reach here.
          await this.ensureFolder(rule.folder);
          const existing = this.vault.getAbstractFileByPath(note.path);
          if (existing && this.isTFile(existing)) {
            // The filename template can pin a rule to one path, and every turn
            // then rewrote that note. Reading first is what lets the overwrite
            // be announced instead of quietly eating what the reader edited.
            const previous = await this.readContent(existing);
            await this.vault.modify(existing, note.content);
            if (previous !== null && previous !== note.content) {
              new Notice(t().sync.overwrote.replace('{path}', note.path));
            }
          } else {
            await this.vault.create(note.path, note.content);
          }
        } catch (e) {
          console.error('[co-ober] sync rule failed:', rule.toolName, e);
          failures.push({ rule, error: e instanceof Error ? e : new Error(String(e)) });
        }
      }
      return failures;
    });
  }

  private async readContent(file: TFile): Promise<string | null> {
    try {
      return await this.vault.cachedRead(file);
    } catch {
      // Not knowing what was there is not a licence to claim it was replaced.
      return null;
    }
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
