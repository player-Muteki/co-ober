import { Setting, Notice } from 'obsidian';
import type { CustomAgentDefinition, CustomSkillDefinition, SyncRule, McpServerConfig, ModelOption, CoOberSettings } from '../types';
import type { Locale } from '../i18n/index';
import { t as locale } from '../i18n/index';


export function addCustomAgentBlock(containerEl: HTMLElement, agent: CustomAgentDefinition, settings: CoOberSettings, save: () => Promise<void>, render: () => void, renameCustomAgent: (currentId: string, nextId: string) => boolean): void {
    const labels = locale().settings.customAgents;
    const block = containerEl.createDiv({ cls: 'co-ober-custom-agent' });
    block.createEl('strong', { text: labels.label.replace('{name}', agent.name || agent.id) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(agent.enabled)
        .onChange(async (value) => { agent.enabled = value; await save(); render(); }));

    new Setting(block)
      .setName(labels.id)
      .setDesc(labels.idDesc)
      .addText((text) => text.setValue(agent.id)
        .onChange(async (value) => {
          const nextId = value.trim();
          if (!renameCustomAgent(agent.id, nextId)) {
            text.setValue(agent.id);
            return;
          }
          await save();
        }));

    new Setting(block)
      .setName(labels.name)
      .addText((text) => text.setValue(agent.name)
        .onChange(async (value) => { agent.name = value.trim(); await save(); }));

    new Setting(block)
      .setName(labels.description)
      .addText((text) => text.setValue(agent.description)
        .onChange(async (value) => { agent.description = value.trim(); await save(); }));

    new Setting(block)
      .setName(labels.instructions)
      .setDesc(labels.instructionsDesc)
      .addTextArea((text) => {
        text.setValue(agent.instructions);
        text.inputEl.rows = 5;
        text.onChange(async (value) => { agent.instructions = value; await save(); });
      });

    new Setting(block)
      .setName(labels.skills)
      .setDesc(labels.skillsDesc)
      .addText((text) => text.setValue(agent.skillIds.join(', '))
        .onChange(async (value) => {
          agent.skillIds = value.split(',').map((item) => item.trim()).filter(Boolean);
          await save();
        }));

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = () => {
      settings.customAgents = settings.customAgents.filter((item) => item.id !== agent.id);
      if (settings.activeCustomAgentId === agent.id) settings.activeCustomAgentId = '';
      void save();
      render();
    };
  }

export function addCustomSkillBlock(containerEl: HTMLElement, skill: CustomSkillDefinition, settings: CoOberSettings, save: () => Promise<void>, render: () => void, renameCustomSkill: (currentId: string, nextId: string) => boolean): void {
    const labels = locale().settings.customSkills;
    const block = containerEl.createDiv({ cls: 'co-ober-custom-skill' });
    block.createEl('strong', { text: labels.label.replace('{name}', skill.name || skill.id) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(skill.enabled)
        .onChange(async (value) => { skill.enabled = value; await save(); }));

    new Setting(block)
      .setName(labels.id)
      .setDesc(labels.idDesc)
      .addText((text) => text.setValue(skill.id)
        .onChange(async (value) => {
          const nextId = value.trim();
          if (!renameCustomSkill(skill.id, nextId)) {
            text.setValue(skill.id);
            return;
          }
          await save();
        }));

    new Setting(block)
      .setName(labels.name)
      .addText((text) => text.setValue(skill.name)
        .onChange(async (value) => { skill.name = value.trim(); await save(); }));

    new Setting(block)
      .setName(labels.description)
      .addText((text) => text.setValue(skill.description)
        .onChange(async (value) => { skill.description = value.trim(); await save(); }));

    new Setting(block)
      .setName(labels.instructions)
      .setDesc(labels.instructionsDesc)
      .addTextArea((text) => {
        text.setValue(skill.instructions);
        text.inputEl.rows = 5;
        text.onChange(async (value) => { skill.instructions = value; await save(); });
      });

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = () => {
      settings.customSkills = settings.customSkills.filter((item) => item.id !== skill.id);
      for (const agent of settings.customAgents) {
        agent.skillIds = agent.skillIds.filter((id) => id !== skill.id);
      }
      void save();
      render();
    };
  }

export function addCommonModelToggle(containerEl: HTMLElement, model: ModelOption, settings: CoOberSettings, save: () => Promise<void>, refreshOpenViewsModels: () => void): void {
    new Setting(containerEl)
      .setName(model.name || model.modelId)
      .setDesc(model.modelId)
      .addToggle((toggle) => toggle.setValue(settings.commonModels.includes(model.modelId))
        .onChange(async (enabled) => {
          const common = settings.commonModels.filter((id) => id !== model.modelId);
          if (enabled) common.push(model.modelId);
          settings.commonModels = common;
          await save();
          refreshOpenViewsModels();
        }));
  }

export function addMcpServerBlock(containerEl: HTMLElement, server: McpServerConfig, settings: CoOberSettings, save: () => Promise<void>, render: () => void, mcpCapabilities: any): void {
    const labels = locale().settings.mcp;
    const block = containerEl.createDiv({ cls: 'co-ober-mcp-server' });
    block.createEl('strong', { text: labels.label.replace('{name}', server.name || labels.unnamed) });

    new Setting(block)
      .setName(labels.enabled)
      .addToggle((toggle) => toggle.setValue(server.enabled)
        .onChange(async (value) => { server.enabled = value; await save(); }));

    new Setting(block)
      .setName(labels.name)
      .setDesc(labels.nameDesc)
      .addText((text) => text.setValue(server.name)
        .onChange(async (value) => { server.name = value.trim(); await save(); }));

    const currentType = server.type ?? 'stdio';

    // mcpCapabilities passed as parameter
    const httpEnabled = mcpCapabilities?.http !== false;
    const sseEnabled = mcpCapabilities?.sse !== false;
    const typeOptions = {
      stdio: 'stdio',
      http: httpEnabled ? 'http' : `http (${locale().settings.mcpHttpDisabled})`,
      sse: sseEnabled ? 'sse' : `sse (${locale().settings.mcpSseDisabled})`,
    };

    new Setting(block)
      .setName('Type')
      .addDropdown((d) => {
        d.addOptions(typeOptions);
        d.selectEl.querySelector<HTMLOptionElement>('option[value="http"]')!.disabled = !httpEnabled;
        d.selectEl.querySelector<HTMLOptionElement>('option[value="sse"]')!.disabled = !sseEnabled;
        d.setValue(currentType);
        d
        .onChange(async (v) => {
          const newType = v as 'stdio' | 'http' | 'sse';
          const idx = settings.mcpServers.indexOf(server);
          if (idx === -1) return;
          if (newType === 'stdio') {
            settings.mcpServers[idx] = { type: 'stdio', id: server.id, enabled: server.enabled, name: server.name, command: 'npx', args: [], env: [] };
          } else {
            settings.mcpServers[idx] = { type: newType, id: server.id, enabled: server.enabled, name: server.name, url: 'http://localhost:3000', headers: [] };
          }
          await save();
          render();
        });
      });

    if (currentType === 'stdio') {
      const stdioServer = server as Extract<McpServerConfig, { type: 'stdio' }>;
      new Setting(block)
        .setName(labels.command)
        .setDesc(labels.commandDesc)
        .addText((text) => text.setValue(stdioServer.command ?? '')
          .onChange(async (value) => { stdioServer.command = value.trim(); await save(); }));

      new Setting(block)
        .setName(labels.args)
        .setDesc(labels.argsDesc)
        .addTextArea((text) => {
          text.setValue((stdioServer.args ?? []).join('\n'));
          text.inputEl.rows = 4;
          text.inputEl.classList.add('co-ober-mcp-args');
          text.onChange(async (value) => {
            stdioServer.args = value.split('\n').map((arg) => arg.trim()).filter(Boolean);
            await save();
          });
        });

      const envDetails = block.createEl('details', { cls: 'co-ober-mcp-env-details' });
      envDetails.createEl('summary', { text: labels.env });
      envDetails.createEl('p', {
        cls: 'co-ober-mcp-env-warning',
        text: labels.envWarning,
      });

      const renderEnvVars = () => {
        envDetails.querySelectorAll('.co-ober-mcp-env-var, .co-ober-mcp-env-add').forEach((el) => el.remove());
        const envVars = stdioServer.env ?? [];
        for (let i = 0; i < envVars.length; i++) {
          const envVar = envVars[i];
          const row = envDetails.createDiv({ cls: 'co-ober-mcp-env-var' });

          const nameInput = row.createEl('input', { type: 'text', placeholder: labels.envName, cls: 'co-ober-mcp-env-input-name' });
          nameInput.value = envVar.name;
          nameInput.onchange = async () => {
            envVar.name = nameInput.value.trim();
            await save();
          };

          const valueInput = row.createEl('input', { type: 'text', placeholder: labels.envValue, cls: 'co-ober-mcp-env-input-value' });
          valueInput.value = envVar.value;
          valueInput.onchange = async () => {
            envVar.value = valueInput.value.trim();
            await save();
          };

          const delEnvBtn = row.createEl('button', { text: '✕' });
          delEnvBtn.onclick = () => {
            stdioServer.env = stdioServer.env?.filter((_, index) => index !== i);
            void save();
            renderEnvVars();
          };
        }

        const addRow = envDetails.createDiv({ cls: 'co-ober-mcp-env-add' });
        new Setting(addRow)
          .setName('')
          .addButton((b) => b.setButtonText(labels.envAdd)
            .onClick(async () => {
              if (!stdioServer.env) stdioServer.env = [];
              stdioServer.env.push({ name: '', value: '' });
              await save();
              renderEnvVars();
            }));
      };
      renderEnvVars();
    } else {
      const httpServer = server as Extract<McpServerConfig, { type: 'http' }>;
      new Setting(block)
        .setName('URL')
        .setDesc('Server URL')
        .addText((text) => text.setValue(httpServer.url ?? '')
          .onChange(async (value) => { httpServer.url = value.trim(); await save(); }));

      const headersDetails = block.createEl('details', { cls: 'co-ober-mcp-headers-details' });
      headersDetails.createEl('summary', { text: 'Headers' });

      const renderHeaders = () => {
        headersDetails.querySelectorAll('.co-ober-mcp-header-var, .co-ober-mcp-header-add').forEach((el) => el.remove());
        const headersVars = httpServer.headers ?? [];
        for (let i = 0; i < headersVars.length; i++) {
          const headerVar = headersVars[i];
          const row = headersDetails.createDiv({ cls: 'co-ober-mcp-header-var' });

          const nameInput = row.createEl('input', { type: 'text', placeholder: 'Name', cls: 'co-ober-mcp-header-input-name' });
          nameInput.value = headerVar.name;
          nameInput.onchange = async () => {
            headerVar.name = nameInput.value.trim();
            await save();
          };

          const valueInput = row.createEl('input', { type: 'text', placeholder: 'Value', cls: 'co-ober-mcp-header-input-value' });
          valueInput.value = headerVar.value;
          valueInput.onchange = async () => {
            headerVar.value = valueInput.value.trim();
            await save();
          };

          const delHeaderBtn = row.createEl('button', { text: '✕' });
          delHeaderBtn.onclick = () => {
            httpServer.headers = httpServer.headers?.filter((_, index) => index !== i);
            void save();
            renderHeaders();
          };
        }

        const addRow = headersDetails.createDiv({ cls: 'co-ober-mcp-header-add' });
        new Setting(addRow)
          .setName('')
          .addButton((b) => b.setButtonText('+ Add Header')
            .onClick(async () => {
              if (!httpServer.headers) httpServer.headers = [];
              httpServer.headers.push({ name: '', value: '' });
              await save();
              renderHeaders();
            }));
      };
      renderHeaders();
    }

    const delBtn = block.createEl('button', { text: locale().settings.sync.delete, cls: 'mod-warning' });
    delBtn.onclick = () => {
      settings.mcpServers = settings.mcpServers.filter((item) => item.id !== server.id);
      void save();
      render();
    };
  }

export function addSyncRuleBlock(containerEl: HTMLElement, rule: SyncRule, settings: CoOberSettings, save: () => Promise<void>, render: () => void): void {
    const labels = locale().settings.sync;
    const block = containerEl.createDiv({ cls: 'co-ober-sync-rule' });
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
        .onChange(async (v) => { rule.toolName = v; await save(); }));

    new Setting(block)
      .setName(labels.folder)
      .addText((t) => t.setValue(rule.folder)
        .onChange(async (v) => { rule.folder = v; await save(); }));

    new Setting(block)
      .setName(labels.filenameTemplate)
      .setDesc(labels.filenameTemplateDesc)
      .addText((t) => t.setValue(rule.filenameTemplate)
        .onChange(async (v) => { rule.filenameTemplate = v; await save(); }));

    const delBtn = block.createEl('button', { text: labels.delete, cls: 'mod-warning' });
    delBtn.onclick = () => {
      settings.syncRules = settings.syncRules.filter((r: SyncRule) => r.id !== rule.id);
      void save();
      render();
    };
  }

export function renameCustomAgent(currentId: string, nextId: string, settings: CoOberSettings, save: () => Promise<void>, labels: Locale['settings']): boolean {
    if (!nextId) return false;
    if (nextId !== currentId && settings.customAgents.some((item) => item.id === nextId)) {
      new Notice(labels.customAgents.duplicateId.replace('{id}', nextId));
      return false;
    }
    const agent = settings.customAgents.find((item) => item.id === currentId);
    if (!agent) return false;
    agent.id = nextId;
    if (settings.activeCustomAgentId === currentId) settings.activeCustomAgentId = nextId;
    return true;
  }

export function renameCustomSkill(currentId: string, nextId: string, settings: CoOberSettings, save: () => Promise<void>, labels: Locale['settings']): boolean {
    if (!nextId) return false;
    if (nextId !== currentId && settings.customSkills.some((item) => item.id === nextId)) {
      new Notice(labels.customSkills.duplicateId.replace('{id}', nextId));
      return false;
    }
    const skill = settings.customSkills.find((item) => item.id === currentId);
    if (!skill) return false;
    skill.id = nextId;
    for (const agent of settings.customAgents) {
      agent.skillIds = agent.skillIds.map((id) => id === currentId ? nextId : id);
    }
    return true;
  }