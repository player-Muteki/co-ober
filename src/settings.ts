import { PluginSettingTab, Setting, Notice, TextAreaComponent } from 'obsidian';
import CopsidianPlugin from './main';
import type { PermissionLevel, SyncRule } from './types';

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
        .onChange(async (v) => { s.opencodePath = v; await this.save(); }));

    new Setting(containerEl)
      .setName('Reconnect')
      .setDesc('Re-establish connection to OpenCode')
      .addButton((b) => b.setButtonText('Reconnect').setCta()
        .onClick(async () => { await this.plugin.initClient(); new Notice('Reconnected'); }));

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
          this.plugin.client!.permissionMode = v;
        }));

    // ── System Prompt ──
    new Setting(containerEl).setName('System Prompt').setHeading();

    new Setting(containerEl)
      .setName('Custom System Prompt')
      .setDesc('Additional instructions injected into the agent system prompt')
      .addTextArea((c) => this.promptComponent(c));

    // ── Notes ──
    new Setting(containerEl).setName('Notes & Context').setHeading();

    new Setting(containerEl)
      .setName('Default Sync Folder')
      .setDesc('Folder where sync notes are created')
      .addText((t) => t.setValue(s.defaultNoteFolder)
        .onChange(async (v) => { s.defaultNoteFolder = v; await this.save(); }));

    new Setting(containerEl)
      .setName('Max Note Reference Size')
      .setDesc('Maximum bytes when reading a referenced note (default 8000)')
      .addText((t) => t.setValue('8000')
        .setPlaceholder('8000')
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) { await this.save(); new Notice('Setting saved'); }
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
      .setName('Auto-scroll')
      .setDesc('Automatically scroll to bottom on new messages')
      .addToggle((t) => t
        .setValue(true)
        .onChange(async (v) => { /* could store in settings later */ }));
  }

  private promptComponent(c: TextAreaComponent): void {
    c.setPlaceholder('Enter custom system prompt instructions...');
    c.inputEl.rows = 6;
    c.inputEl.classList.add('copsidian-prompt-input');
    c.onChange(async (v) => {
      // Store in plugin settings if we have a field for it
      // Currently no systemPrompt field in types, skip for now
    });
  }

  private addSyncRuleBlock(containerEl: HTMLElement, rule: SyncRule): void {
    const block = containerEl.createDiv({ cls: 'copsidian-sync-rule' });
    block.createEl('strong', { text: `Rule: ${rule.toolName}` });

    new Setting(block)
      .setName('Tool')
      .addDropdown((d) => d.addOptions({
        edit: 'edit', write: 'write', bash: 'bash', all: 'all',
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
      this.plugin.settings.syncRules = this.plugin.settings.syncRules.filter((r) => r.id !== rule.id);
      await this.save();
      this.display();
    };
  }

  private async save(): Promise<void> {
    await this.plugin.saveData(this.plugin.settings);
  }
}
