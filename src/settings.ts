import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { existsSync } from 'fs';
import { delimiter, isAbsolute } from 'path';
import CopsidianPlugin from './main';
import { VIEW_TYPE } from './types';
import type { PermissionLevel, SyncRule } from './types';
import { setLocale } from './i18n/index';

export class CopsidianSettingsTab extends PluginSettingTab {
  constructor(private plugin: CopsidianPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    // ── Connection ──
    new Setting(containerEl).setName('Connection').setHeading();

    new Setting(containerEl)
      .setName('OpenCode CLI Path')
      .setDesc('Path to opencode executable (use "opencode" for PATH)')
      .addText((t) => t.setValue(s.opencodePath)
        .onChange(async (v) => {
          const trimmed = v.trim();
          if (this.validateOpencodePath(trimmed)) {
            s.opencodePath = trimmed;
            await this.save();
          }
        }));

    new Setting(containerEl)
      .setName('Reconnect')
      .setDesc('Re-establish connection to OpenCode')
      .addButton((b) => b.setButtonText('Reconnect').setCta()
        .onClick(async () => { await this.plugin.initClient(); new Notice('Reconnected'); }));

    new Setting(containerEl)
      .setName('Autostart OpenCode')
      .setDesc('Connect to OpenCode when Obsidian starts')
      .addToggle((t) => t.setValue(s.autoConnect ?? true)
        .onChange(async (v) => { s.autoConnect = v; await this.save(); }));

    // ── Agent ──
    new Setting(containerEl).setName('Agent').setHeading();

    new Setting(containerEl)
      .setName('Default Agent')
      .addDropdown((d) => d.addOptions({ build: 'build', plan: 'plan', docs: 'docs' })
        .setValue(s.defaultAgent)
        .onChange(async (v) => { s.defaultAgent = v; await this.save(); }));

    new Setting(containerEl)
      .setName('Permission Mode')
      .setDesc('Auto-approve behavior for tool permissions')
      .addDropdown((d) => d.addOptions({
        yolo: 'Yolo — auto-approve all',
        plan: 'Plan — auto-approve safe',
        safe: 'Safe — confirm all',
      })
        .setValue(s.permissionMode)
        .onChange(async (v) => {
          s.permissionMode = v as PermissionLevel;
          await this.save();
          if (this.plugin.client) this.plugin.client.permissionMode = v;
        }));

    // ── System Prompt ──
    new Setting(containerEl).setName('System Prompt').setHeading();

    new Setting(containerEl)
      .setName('Custom System Prompt')
      .setDesc('Additional instructions injected into the agent system prompt')
      .addTextArea((c) => {
        c.setPlaceholder('Enter custom system prompt instructions...');
        c.inputEl.rows = 6;
        c.inputEl.classList.add('copsidian-prompt-input');
        c.onChange(async (v) => {
          s.systemPrompt = v;
          await this.save();
        });
      });

    // ── Notes & Context ──
    new Setting(containerEl).setName('Notes & Context').setHeading();

    new Setting(containerEl)
      .setName('Default Sync Folder')
      .setDesc('Folder where sync notes are created')
      .addText((t) => t.setValue(s.defaultNoteFolder)
        .onChange(async (v) => { s.defaultNoteFolder = v; await this.save(); }));

    new Setting(containerEl)
      .setName('Max Note Reference Size')
      .setDesc('Maximum bytes when reading a referenced note (default 8000)')
      .addText((t) => t.setValue(String(s.maxNoteSize))
        .setPlaceholder('8000')
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) { s.maxNoteSize = n; await this.save(); new Notice('Setting saved'); }
        }));

    // ── Sync Rules ──
    new Setting(containerEl).setName('Sync Rules').setHeading();

    for (const rule of s.syncRules) {
      this.addSyncRuleBlock(containerEl, rule);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText('+ Add Rule')
        .onClick(async () => {
          const rule: SyncRule = {
            id: Date.now().toString(),
            enabled: true,
            toolName: 'edit',
            folder: s.defaultNoteFolder,
            filenameTemplate: '{{tool}}-{{date}}-{{shortId}}',
          };
          s.syncRules.push(rule);
          await this.save();
          this.display();
        }));

    // ── Appearance ──
    new Setting(containerEl).setName('Appearance').setHeading();

    new Setting(containerEl)
      .setName('Language')
      .setDesc('UI language (requires restart to apply to open views)')
      .addDropdown((d) => d.addOptions({ en: 'English', zh: '中文' })
        .setValue(s.language)
        .onChange(async (v) => { s.language = v; setLocale(v); await this.save(); }));

    new Setting(containerEl)
      .setName('Auto-scroll')
      .setDesc('Automatically scroll to bottom on new messages')
      .addToggle((t) => t.setValue(s.autoScrollEnabled ?? true)
        .onChange(async (v) => {
          s.autoScrollEnabled = v;
          await this.save();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            const view = leaf.view as any;
            if (typeof view?.setAutoScrollEnabled === 'function') {
              view.setAutoScrollEnabled(v);
            }
          }
        }));

    // ── Session Limits ──
    new Setting(containerEl).setName('Session Limits').setHeading();

    new Setting(containerEl)
      .setName('Max Messages per Session')
      .setDesc('Truncate sessions when they exceed this limit (default 200)')
      .addText((t) => t.setValue(String(s.maxSessionMessages ?? 200))
        .setPlaceholder('200')
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            s.maxSessionMessages = n;
            await this.save();
          }
        }));

    new Setting(containerEl)
      .setName('Session Retention Days')
      .setDesc('Remove empty sessions older than this (default 30)')
      .addText((t) => t.setValue(String(s.sessionRetentionDays ?? 30))
        .setPlaceholder('30')
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            s.sessionRetentionDays = n;
            await this.save();
          }
        }));
  }

  private addSyncRuleBlock(containerEl: HTMLElement, rule: SyncRule): void {
    const block = containerEl.createDiv({ cls: 'copsidian-sync-rule' });
    block.createEl('strong', { text: `Rule: ${rule.toolName}` });

    new Setting(block)
      .setName('Tool')
      .addDropdown((d) => d.addOptions({
        read: 'read',
        edit: 'edit',
        write: 'write',
        execute: 'execute',
        fetch: 'fetch',
        search: 'search',
        other: 'other',
        all: '*',
      })
        .setValue(rule.toolName)
        .onChange(async (v) => { rule.toolName = v; await this.save(); }));

    new Setting(block)
      .setName('Folder')
      .addText((t) => t.setValue(rule.folder)
        .onChange(async (v) => { rule.folder = v; await this.save(); }));

    new Setting(block)
      .setName('Filename Template')
      .setDesc('Variables: {{tool}}, {{date}}, {{shortId}}')
      .addText((t) => t.setValue(rule.filenameTemplate)
        .onChange(async (v) => { rule.filenameTemplate = v; await this.save(); }));

    const delBtn = block.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    delBtn.onclick = async () => {
      this.plugin.settings.syncRules = this.plugin.settings.syncRules.filter((r: SyncRule) => r.id !== rule.id);
      await this.save();
      this.display();
    };
  }

  private async save(): Promise<void> {
    await this.plugin.savePluginData();
  }

  private validateOpencodePath(path: string): boolean {
    if (!path) return false;
    if (isAbsolute(path) || path.includes('/') || path.includes('\\')) {
      if (existsSync(path)) return true;
      new Notice(`Warning: opencode path "${path}" not found`);
      return false;
    }

    const executableNames = process.platform === 'win32' ? [path, `${path}.cmd`, `${path}.exe`] : [path];
    const found = (process.env.PATH ?? '')
      .split(delimiter)
      .some((dir) => executableNames.some((name) => existsSync(`${dir}/${name}`)));

    if (!found) new Notice(`Warning: opencode path "${path}" not found`);
    return found;
  }
}
