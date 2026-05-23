import { PluginSettingTab, Setting, Notice } from 'obsidian';
import { existsSync } from 'fs';
import { delimiter, isAbsolute } from 'path';
import CopsidianPlugin from './main';
import { VIEW_TYPE } from './types';
import type { AvailableCommand, CustomAgentDefinition, CustomSkillDefinition, McpServerConfig, ModeOption, ModelOption, PermissionLevel, SyncRule } from './types';
import type { OpencodeClient } from './client';
import { setLocale, t as locale } from './i18n/index';
import { CLIENT_VERSION } from './client/acp';

interface AutoScrollView {
  setAutoScrollEnabled?: (enabled: boolean) => void;
}

interface LocaleAwareView {
  refreshLocale?: () => void;
}

interface DiagnosticResult {
  label: string;
  ok: boolean;
  detail: string;
}

interface PathDiagnostic {
  ok: boolean;
  detail: string;
}

export class CopsidianSettingsTab extends PluginSettingTab {
  private runtimeAgents: ModeOption[] = [];
  private runtimeModels: ModelOption[] = [];
  private runtimeSkills: AvailableCommand[] = [];
  private runtimeOptionsLoaded = false;
  private runtimeOptionsLoading = false;
  private diagnosticsRunning = false;
  private diagnosticsResults: DiagnosticResult[] = [];

  constructor(private plugin: CopsidianPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const labels = locale().settings;
    const availableAgents = this.getAvailableAgents();
    const availableModels = this.getAvailableModels();
    const availableSkills = this.getAvailableSkills();
    this.loadRuntimeOptions();

    // ── Connection ──
    new Setting(containerEl).setName(labels.connection).setHeading();

    new Setting(containerEl)
      .setName(labels.opencodePath.name)
      .setDesc(labels.opencodePath.desc)
      .addText((t) => t.setValue(s.opencodePath)
        .onChange(async (v) => {
          const trimmed = v.trim();
          if (this.validateOpencodePath(trimmed)) {
            s.opencodePath = trimmed;
            await this.save();
          }
        }));

    new Setting(containerEl)
      .setName(labels.reconnect.name)
      .setDesc(labels.reconnect.desc)
      .addButton((b) => b.setButtonText(labels.reconnect.button).setCta()
        .onClick(async () => {
          const connected = await this.plugin.initClient();
          this.runtimeOptionsLoaded = false;
          await this.loadRuntimeOptions();
          new Notice(connected ? locale().settings.reconnect.success : locale().settings.reconnect.failed);
        }));

    new Setting(containerEl)
      .setName(labels.autostart.name)
      .setDesc(labels.autostart.desc)
      .addToggle((t) => t.setValue(s.autoConnect ?? true)
        .onChange(async (v) => { s.autoConnect = v; await this.save(); }));

    this.addDiagnosticsBlock(containerEl);

    // ── Agent ──
    new Setting(containerEl).setName(labels.agent).setHeading();

    new Setting(containerEl)
      .setName(labels.defaultAgent)
      .addDropdown((d) => d.addOptions(this.buildAgentOptions(availableAgents))
        .setValue(s.defaultAgent)
        .onChange(async (v) => { s.defaultAgent = v; await this.save(); }));

    new Setting(containerEl)
      .setName(labels.defaultModel)
      .addDropdown((d) => d.addOptions(this.buildModelOptions(availableModels))
        .setValue(s.defaultModel)
        .onChange(async (v) => { s.defaultModel = v; await this.save(); }));

    new Setting(containerEl)
      .setName(labels.permissionMode.name)
      .setDesc(labels.permissionMode.desc)
      .addDropdown((d) => d.addOptions({
        yolo: labels.permissionMode.yolo,
        plan: labels.permissionMode.plan,
        safe: labels.permissionMode.safe,
      })
        .setValue(s.permissionMode)
        .onChange(async (v) => {
          s.permissionMode = v as PermissionLevel;
          await this.save();
          if (this.plugin.client) this.plugin.client.permissionMode = v;
        }));

    new Setting(containerEl)
      .setName(labels.customAgents.active)
      .setDesc(labels.customAgents.activeDesc)
      .addDropdown((d) => {
        const options: Record<string, string> = { '': labels.customAgents.none };
        for (const agent of s.customAgents.filter((item) => item.enabled)) {
          options[agent.id] = agent.name || agent.id;
        }
        d.addOptions(options);
        d.setValue(s.activeCustomAgentId ?? '');
        d.onChange(async (v) => { s.activeCustomAgentId = v; await this.save(); });
      });

    // ── System Prompt ──
    new Setting(containerEl).setName(labels.systemPrompt.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.systemPrompt.name)
      .setDesc(labels.systemPrompt.desc)
      .addTextArea((c) => {
        c.setPlaceholder(labels.systemPrompt.placeholder);
        c.inputEl.rows = 6;
        c.inputEl.classList.add('copsidian-prompt-input');
        c.onChange(async (v) => {
          s.systemPrompt = v;
          await this.save();
        });
      });

    // ── Notes & Context ──
    new Setting(containerEl).setName(labels.notes.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.notes.defaultSyncFolder)
      .setDesc(labels.notes.defaultSyncFolderDesc)
      .addText((t) => t.setValue(s.defaultNoteFolder)
        .onChange(async (v) => { s.defaultNoteFolder = v; await this.save(); }));

    new Setting(containerEl)
      .setName(labels.notes.maxNoteSize)
      .setDesc(labels.notes.maxNoteSizeDesc)
      .addText((t) => t.setValue(String(s.maxNoteSize))
        .setPlaceholder('8000')
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) { s.maxNoteSize = n; await this.save(); new Notice(locale().settings.notes.saved); }
        }));

    // ── Custom Agents & Skills ──
    new Setting(containerEl).setName(labels.customAgents.heading).setHeading();

    for (const agent of s.customAgents) {
      this.addCustomAgentBlock(containerEl, agent);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.customAgents.add)
        .onClick(async () => {
          const agent: CustomAgentDefinition = {
            id: `agent-${Date.now()}`,
            enabled: true,
            name: labels.customAgents.defaultName,
            description: '',
            instructions: '',
            skillIds: [],
          };
          s.customAgents.push(agent);
          await this.save();
          this.display();
        }));

    new Setting(containerEl).setName(labels.customSkills.heading).setHeading();

    new Setting(containerEl).setName(labels.customSkills.loadedHeading).setHeading();

    if (this.runtimeOptionsLoading && !this.runtimeOptionsLoaded) {
      new Setting(containerEl).setName(labels.customSkills.loading);
    } else if (availableSkills.length === 0) {
      new Setting(containerEl).setName(labels.customSkills.loadedEmpty);
    }

    for (const skill of availableSkills) {
      new Setting(containerEl)
        .setName(skill.name)
        .setDesc(skill.description);
    }

    if (s.customSkills.length === 0) {
      new Setting(containerEl).setName(labels.customSkills.empty);
    }

    for (const skill of s.customSkills) {
      this.addCustomSkillBlock(containerEl, skill);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.customSkills.add)
        .onClick(async () => {
          const skill: CustomSkillDefinition = {
            id: `skill-${Date.now()}`,
            enabled: true,
            name: labels.customSkills.defaultName,
            description: '',
            instructions: '',
          };
          s.customSkills.push(skill);
          await this.save();
          this.display();
        }));

    // ── Common Models ──
    new Setting(containerEl)
      .setName(labels.commonModels.heading)
      .setDesc(labels.commonModels.desc)
      .setHeading();

    if (this.runtimeOptionsLoading && !this.runtimeOptionsLoaded) {
      new Setting(containerEl).setName(labels.commonModels.loading);
    } else if (availableModels.length === 0) {
      new Setting(containerEl).setName(labels.commonModels.empty);
    }

    for (const model of availableModels) {
      this.addCommonModelToggle(containerEl, model);
    }

    // ── MCP Servers ──
    new Setting(containerEl).setName(labels.mcp.heading).setHeading();

    for (const server of s.mcpServers) {
      this.addMcpServerBlock(containerEl, server);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.mcp.add)
        .onClick(async () => {
          const server: McpServerConfig = {
            id: Date.now().toString(),
            enabled: true,
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
          };
          s.mcpServers.push(server);
          await this.save();
          this.display();
        }));

    // ── Sync Rules ──
    new Setting(containerEl).setName(labels.sync.heading).setHeading();

    for (const rule of s.syncRules) {
      this.addSyncRuleBlock(containerEl, rule);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.sync.add)
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
    new Setting(containerEl).setName(labels.appearance.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.appearance.language)
      .setDesc(labels.appearance.languageDesc)
      .addDropdown((d) => d.addOptions({ en: 'English', zh: '中文' })
        .setValue(s.language)
        .onChange(async (v) => {
          s.language = v;
          setLocale(v);
          await this.save();
          this.refreshOpenViewsLocale();
          this.display();
        }));

    new Setting(containerEl)
      .setName(labels.appearance.autoScroll)
      .setDesc(labels.appearance.autoScrollDesc)
      .addToggle((t) => t.setValue(s.autoScrollEnabled ?? true)
        .onChange(async (v) => {
          s.autoScrollEnabled = v;
          await this.save();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            const view = leaf.view as AutoScrollView;
            if (typeof view?.setAutoScrollEnabled === 'function') {
              view.setAutoScrollEnabled(v);
            }
          }
        }));

    // ── Session Limits ──
    new Setting(containerEl).setName(labels.sessionLimits.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.sessionLimits.maxMessages)
      .setDesc(labels.sessionLimits.maxMessagesDesc)
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
      .setName(labels.sessionLimits.retentionDays)
      .setDesc(labels.sessionLimits.retentionDaysDesc)
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
    const labels = locale().settings.sync;
    const block = containerEl.createDiv({ cls: 'copsidian-sync-rule' });
    block.createEl('strong', { text: labels.label.replace('{tool}', rule.toolName) });

    new Setting(block)
      .setName(labels.tool)
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
      .setName(labels.folder)
      .addText((t) => t.setValue(rule.folder)
        .onChange(async (v) => { rule.folder = v; await this.save(); }));

    new Setting(block)
      .setName(labels.filenameTemplate)
      .setDesc(labels.filenameTemplateDesc)
      .addText((t) => t.setValue(rule.filenameTemplate)
        .onChange(async (v) => { rule.filenameTemplate = v; await this.save(); }));

    const delBtn = block.createEl('button', { text: labels.delete, cls: 'mod-warning' });
    delBtn.onclick = async () => {
      this.plugin.settings.syncRules = this.plugin.settings.syncRules.filter((r: SyncRule) => r.id !== rule.id);
      await this.save();
      this.display();
    };
  }

  private addDiagnosticsBlock(containerEl: HTMLElement): void {
    const labels = locale().settings.diagnostics;
    new Setting(containerEl).setName(labels.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.description)
      .addButton((button) => {
        button.setButtonText(this.diagnosticsRunning ? labels.running : labels.run);
        button.buttonEl.disabled = this.diagnosticsRunning;
        button.onClick(async () => {
          await this.runDiagnostics();
        });
      });

    for (const result of this.diagnosticsResults) {
      new Setting(containerEl)
        .setName(`${result.ok ? labels.pass : labels.fail} ${result.label}`)
        .setDesc(result.detail);
    }
  }

  private async runDiagnostics(): Promise<void> {
    this.diagnosticsRunning = true;
    this.display();

    try {
      this.diagnosticsResults = await this.collectDiagnostics();
    } catch {
      const labels = locale().settings.diagnostics;
      this.diagnosticsResults = [{ label: labels.heading, ok: false, detail: labels.unexpectedError }];
    } finally {
      this.diagnosticsRunning = false;
      this.display();
    }
  }

  private async collectDiagnostics(): Promise<DiagnosticResult[]> {
    const labels = locale().settings.diagnostics;
    const results: DiagnosticResult[] = [];

    const pathStatus = this.getOpencodePathStatus(this.plugin.settings.opencodePath);
    results.push({ label: labels.path, ok: pathStatus.ok, detail: pathStatus.detail });

    const existingClient = this.plugin.getClient();
    const connected = existingClient?.isConnected() ?? await this.plugin.initClient();
    const client = this.plugin.getClient();
    results.push({
      label: labels.connection,
      ok: connected,
      detail: connected ? labels.connectionOk : labels.connectionFailed,
    });

    const runtimeCounts = connected && client
      ? await this.getRuntimeMetadataCounts(client)
      : { modes: 0, models: 0, commands: 0 };
    results.push({
      label: labels.runtime,
      ok: runtimeCounts.modes + runtimeCounts.models + runtimeCounts.commands > 0,
      detail: labels.runtimeDetail
        .replace('{modes}', String(runtimeCounts.modes))
        .replace('{models}', String(runtimeCounts.models))
        .replace('{commands}', String(runtimeCounts.commands)),
    });

    const configuredMcp = this.plugin.settings.mcpServers.length;
    const enabledMcp = this.plugin.settings.mcpServers.filter((server) => server.enabled).length;
    results.push({
      label: labels.mcp,
      ok: true,
      detail: labels.mcpDetail
        .replace('{enabled}', String(enabledMcp))
        .replace('{configured}', String(configuredMcp)),
    });

    const syncFolder = this.plugin.settings.defaultNoteFolder.trim();
    results.push({
      label: labels.syncFolder,
      ok: syncFolder.length > 0,
      detail: syncFolder.length > 0 ? syncFolder : labels.syncFolderMissing,
    });

    results.push({ label: labels.clientVersion, ok: true, detail: CLIENT_VERSION });
    return results;
  }

  private async getRuntimeMetadataCounts(client: OpencodeClient): Promise<{ modes: number; models: number; commands: number }> {
    const snapshot = client.getSessionSnapshot();
    const snapshotCounts = {
      modes: snapshot.availableModes.length,
      models: snapshot.availableModels.length,
      commands: snapshot.availableCommands.length,
    };
    if (snapshotCounts.modes + snapshotCounts.models + snapshotCounts.commands > 0) return snapshotCounts;

    const [agents, models, commands] = await Promise.all([
      client.getAvailableAgents().catch(() => [] as ModeOption[]),
      client.getAvailableModels().catch(() => [] as ModelOption[]),
      client.getAvailableCommands().catch(() => [] as AvailableCommand[]),
    ]);
    return { modes: agents.length, models: models.length, commands: commands.length };
  }

  private addCustomAgentBlock(containerEl: HTMLElement, agent: CustomAgentDefinition): void {
    const labels = locale().settings.customAgents;
    const block = containerEl.createDiv({ cls: 'copsidian-custom-agent' });
    block.createEl('strong', { text: labels.label.replace('{name}', agent.name || agent.id) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(agent.enabled)
        .onChange(async (value) => { agent.enabled = value; await this.save(); this.display(); }));

    new Setting(block)
      .setName(labels.id)
      .setDesc(labels.idDesc)
      .addText((text) => text.setValue(agent.id)
        .onChange(async (value) => {
          const nextId = value.trim();
          if (!this.renameCustomAgent(agent.id, nextId)) {
            text.setValue(agent.id);
            return;
          }
          await this.save();
        }));

    new Setting(block)
      .setName(labels.name)
      .addText((text) => text.setValue(agent.name)
        .onChange(async (value) => { agent.name = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.description)
      .addText((text) => text.setValue(agent.description)
        .onChange(async (value) => { agent.description = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.instructions)
      .setDesc(labels.instructionsDesc)
      .addTextArea((text) => {
        text.setValue(agent.instructions);
        text.inputEl.rows = 5;
        text.onChange(async (value) => { agent.instructions = value; await this.save(); });
      });

    new Setting(block)
      .setName(labels.skills)
      .setDesc(labels.skillsDesc)
      .addText((text) => text.setValue(agent.skillIds.join(', '))
        .onChange(async (value) => {
          agent.skillIds = value.split(',').map((item) => item.trim()).filter(Boolean);
          await this.save();
        }));

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = async () => {
      this.plugin.settings.customAgents = this.plugin.settings.customAgents.filter((item) => item.id !== agent.id);
      if (this.plugin.settings.activeCustomAgentId === agent.id) this.plugin.settings.activeCustomAgentId = '';
      await this.save();
      this.display();
    };
  }

  private addCustomSkillBlock(containerEl: HTMLElement, skill: CustomSkillDefinition): void {
    const labels = locale().settings.customSkills;
    const block = containerEl.createDiv({ cls: 'copsidian-custom-skill' });
    block.createEl('strong', { text: labels.label.replace('{name}', skill.name || skill.id) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(skill.enabled)
        .onChange(async (value) => { skill.enabled = value; await this.save(); }));

    new Setting(block)
      .setName(labels.id)
      .setDesc(labels.idDesc)
      .addText((text) => text.setValue(skill.id)
        .onChange(async (value) => {
          const nextId = value.trim();
          if (!this.renameCustomSkill(skill.id, nextId)) {
            text.setValue(skill.id);
            return;
          }
          await this.save();
        }));

    new Setting(block)
      .setName(labels.name)
      .addText((text) => text.setValue(skill.name)
        .onChange(async (value) => { skill.name = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.description)
      .addText((text) => text.setValue(skill.description)
        .onChange(async (value) => { skill.description = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.instructions)
      .setDesc(labels.instructionsDesc)
      .addTextArea((text) => {
        text.setValue(skill.instructions);
        text.inputEl.rows = 5;
        text.onChange(async (value) => { skill.instructions = value; await this.save(); });
      });

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = async () => {
      this.plugin.settings.customSkills = this.plugin.settings.customSkills.filter((item) => item.id !== skill.id);
      for (const agent of this.plugin.settings.customAgents) {
        agent.skillIds = agent.skillIds.filter((id) => id !== skill.id);
      }
      await this.save();
      this.display();
    };
  }

  private addCommonModelToggle(containerEl: HTMLElement, model: ModelOption): void {
    new Setting(containerEl)
      .setName(model.name || model.modelId)
      .setDesc(model.modelId)
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.commonModels.includes(model.modelId))
        .onChange(async (enabled) => {
          const common = this.plugin.settings.commonModels.filter((id) => id !== model.modelId);
          if (enabled) common.push(model.modelId);
          this.plugin.settings.commonModels = common;
          await this.save();
          this.refreshOpenViewsModels();
        }));
  }

  private addMcpServerBlock(containerEl: HTMLElement, server: McpServerConfig): void {
    const labels = locale().settings.mcp;
    const block = containerEl.createDiv({ cls: 'copsidian-mcp-server' });
    block.createEl('strong', { text: labels.label.replace('{name}', server.name || labels.unnamed) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(server.enabled)
        .onChange(async (value) => { server.enabled = value; await this.save(); }));

    new Setting(block)
      .setName(labels.name)
      .setDesc(labels.nameDesc)
      .addText((text) => text.setValue(server.name)
        .onChange(async (value) => { server.name = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.command)
      .setDesc(labels.commandDesc)
      .addText((text) => text.setValue(server.command)
        .onChange(async (value) => { server.command = value.trim(); await this.save(); }));

    new Setting(block)
      .setName(labels.args)
      .setDesc(labels.argsDesc)
      .addTextArea((text) => {
        text.setValue(server.args.join('\n'));
        text.inputEl.rows = 4;
        text.inputEl.classList.add('copsidian-mcp-args');
        text.onChange(async (value) => {
          server.args = value.split('\n').map((arg) => arg.trim()).filter(Boolean);
          await this.save();
        });
      });

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = async () => {
      this.plugin.settings.mcpServers = this.plugin.settings.mcpServers.filter((item) => item.id !== server.id);
      await this.save();
      this.display();
    };
  }

  private renameCustomAgent(currentId: string, nextId: string): boolean {
    if (!nextId) return false;
    if (nextId !== currentId && this.plugin.settings.customAgents.some((item) => item.id === nextId)) {
      new Notice(locale().settings.customAgents.duplicateId.replace('{id}', nextId));
      return false;
    }
    const agent = this.plugin.settings.customAgents.find((item) => item.id === currentId);
    if (!agent) return false;
    agent.id = nextId;
    if (this.plugin.settings.activeCustomAgentId === currentId) this.plugin.settings.activeCustomAgentId = nextId;
    return true;
  }

  private renameCustomSkill(currentId: string, nextId: string): boolean {
    if (!nextId) return false;
    if (nextId !== currentId && this.plugin.settings.customSkills.some((item) => item.id === nextId)) {
      new Notice(locale().settings.customSkills.duplicateId.replace('{id}', nextId));
      return false;
    }
    const skill = this.plugin.settings.customSkills.find((item) => item.id === currentId);
    if (!skill) return false;
    skill.id = nextId;
    for (const agent of this.plugin.settings.customAgents) {
      agent.skillIds = agent.skillIds.map((id) => id === currentId ? nextId : id);
    }
    return true;
  }

  private getAvailableAgents(): ModeOption[] {
    if (this.runtimeOptionsLoaded) return this.runtimeAgents;
    return this.plugin.getClient()?.getSessionSnapshot().availableModes ?? [];
  }

  private getAvailableModels(): ModelOption[] {
    if (this.runtimeOptionsLoaded) return this.runtimeModels;
    return this.plugin.getClient()?.getSessionSnapshot().availableModels ?? [];
  }

  private getAvailableSkills(): AvailableCommand[] {
    if (this.runtimeOptionsLoaded) return this.runtimeSkills;
    return this.plugin.getClient()?.getSessionSnapshot().availableCommands ?? [];
  }

  private async loadRuntimeOptions(): Promise<void> {
    if (this.runtimeOptionsLoading || this.runtimeOptionsLoaded) return;
    this.runtimeOptionsLoading = true;
    try {
      const connected = await this.plugin.initClient();
      if (!connected) return;

      let client = this.plugin.getClient();
      if (!client) return;

      let snapshot = client.getSessionSnapshot();
      if (snapshot.availableModes.length === 0 && snapshot.availableModels.length === 0 && snapshot.availableCommands.length === 0) {
        const sessionId = await client.createSession(undefined, this.plugin.settings.mcpServers).catch(() => '');
        if (sessionId) await client.closeSession(sessionId).catch(() => {});
        client = this.plugin.getClient();
        if (!client) return;
        snapshot = client.getSessionSnapshot();
      }

      const [agents, models, skills] = await Promise.all([
        client.getAvailableAgents(),
        client.getAvailableModels(),
        client.getAvailableCommands(),
      ]);
      this.runtimeAgents = agents.length > 0 ? agents : snapshot.availableModes;
      this.runtimeModels = models.length > 0 ? models : snapshot.availableModels;
      this.runtimeSkills = skills.length > 0 ? skills : snapshot.availableCommands;
      this.runtimeOptionsLoaded = true;
      this.display();
    } finally {
      this.runtimeOptionsLoading = false;
    }
  }

  private buildAgentOptions(agents: ModeOption[]): Record<string, string> {
    const options: Record<string, string> = {};
    for (const agent of agents) options[agent.id] = agent.name;
    if (Object.keys(options).length === 0) {
      options.build = 'build';
      options.plan = 'plan';
      options.docs = 'docs';
    }
    if (this.plugin.settings.defaultAgent && !options[this.plugin.settings.defaultAgent]) {
      options[this.plugin.settings.defaultAgent] = this.plugin.settings.defaultAgent;
    }
    return options;
  }

  private buildModelOptions(models: ModelOption[]): Record<string, string> {
    const options: Record<string, string> = { '': '—' };
    for (const model of models) options[model.modelId] = model.name;
    if (this.plugin.settings.defaultModel && !options[this.plugin.settings.defaultModel]) {
      options[this.plugin.settings.defaultModel] = this.plugin.settings.defaultModel;
    }
    return options;
  }

  private refreshOpenViewsModels(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as { loadToolbarOptions?: () => void };
      view.loadToolbarOptions?.();
    }
  }

  private async save(): Promise<void> {
    await this.plugin.savePluginData();
  }

  private refreshOpenViewsLocale(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as LocaleAwareView;
      view.refreshLocale?.();
    }
  }

  private validateOpencodePath(path: string): boolean {
    const status = this.getOpencodePathStatus(path);
    if (!status.ok) new Notice(status.detail);
    return status.ok;
  }

  private getOpencodePathStatus(path: string): PathDiagnostic {
    const labels = locale().settings.diagnostics;
    if (!path) return { ok: false, detail: labels.pathEmpty };
    if (isAbsolute(path) || path.includes('/') || path.includes('\\')) {
      if (existsSync(path)) return { ok: true, detail: labels.pathFound.replace('{path}', path) };
      return { ok: false, detail: locale().settings.opencodePath.notFound.replace('{path}', path) };
    }

    const executableNames = process.platform === 'win32' ? [path, `${path}.cmd`, `${path}.exe`] : [path];
    const found = (process.env.PATH ?? '')
      .split(delimiter)
      .some((dir) => executableNames.some((name) => existsSync(`${dir}/${name}`)));

    if (!found) return { ok: false, detail: locale().settings.opencodePath.notFound.replace('{path}', path) };
    return { ok: true, detail: labels.pathFound.replace('{path}', path) };
  }
}
