import { PluginSettingTab, Setting, Notice } from 'obsidian';
import CoOberPlugin from './main';
import { VIEW_TYPE } from './types';
import type { AgentCapabilities, AvailableCommand, CustomAgentDefinition, CustomSkillDefinition, McpServerConfig, ModeOption, ModelOption, PermissionLevel, SyncRule, FsCapabilityMode, TerminalCapabilityMode } from './types';
import type { OpencodeClient } from './client';
import { setLocale, t as locale } from './i18n/index';
import { CLIENT_VERSION } from './client/acp';
import { applyPermissionTier } from './client/permissionTier';
import { validateCustomAgent } from './agents/custom';
import { resolveCommandPath } from './utils/commandResolution';
import { MIN_OPEN_TABS, MAX_OPEN_TABS, DEFAULT_OPEN_TABS } from './constants';

import { addCustomAgentBlock, addCustomSkillBlock, addCommonModelToggle, addMcpServerBlock, addSyncRuleBlock, nextRuleId, renameCustomAgent, renameCustomSkill } from './settings/settingBlocks';

interface AutoScrollView {
  setAutoScrollEnabled?: (enabled: boolean) => void;
}

/**
 * Parse an integer settings field. Out-of-range input gets a visible hint
 * instead of the previous silent no-save, which left the box showing a value
 * that was never stored.
 */
function parseBoundedInt(raw: string, min: number, max: number): number | null {
  // The hint promises a whole number, so a value that is not exactly one has to
  // be refused rather than quietly repaired. parseInt floored "8000.5" to 8000
  // and truncated "12abc" to 12 — both stored while the box still showed text the
  // field had just claimed to reject, so the number on screen was a claim the
  // settings no longer stood behind.
  const n = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    new Notice(locale().settings.invalidNumber.replace('{min}', String(min)).replace('{max}', String(max)));
    return null;
  }
  return n;
}

interface LocaleAwareView {
  refreshLocale?: () => void;
  refreshTabBar?: () => void;
}

interface PermissionAwareView {
  refreshPermissionMode?: () => void;
}

interface ReconnectableView {
  reconnectAgent: () => Promise<boolean>;
}

interface ToolbarAwareView {
  reloadToolbarOptions?: () => void;
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

export class CoOberSettingsTab extends PluginSettingTab {
  private runtimeAgents: ModeOption[] = [];
  private runtimeModels: ModelOption[] = [];
  private runtimeSkills: AvailableCommand[] = [];
  private runtimeOptionsLoaded = false;
  private runtimeOptionsLoading = false;
  // The three flags answer different questions: loading is "still fetching",
  // loaded is "the fetch returned", unavailable is "the fetch could not
  // answer". A `false` loaded only means "nothing here" if the fetch also
  // did not fail — otherwise the guard below would call a failure an empty.
  private runtimeOptionsUnavailable = false;
  private diagnosticsRunning = false;
  private diagnosticsResults: DiagnosticResult[] = [];

  constructor(private plugin: CoOberPlugin) {
    super(plugin.app, plugin);
  }

  // display is deprecated since Obsidian 1.13.0, but minAppVersion is 1.8.0
  // so getSettingDefinitions() cannot be used until the target is bumped.
  override display(): void { this.render(); }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnectionSection(containerEl);
    this.renderAgentSection(containerEl);
    this.renderSystemPromptSection(containerEl);
    this.renderNotesSection(containerEl);
    this.renderCustomAgentsSection(containerEl);
    this.renderCommonModelsSection(containerEl);
    this.renderMcpSection(containerEl);
    this.renderSyncRulesSection(containerEl);
    this.renderAppearanceSection(containerEl);
    this.renderSessionLimitsSection(containerEl);
    this.renderTerminalSection(containerEl);
  }

  private renderConnectionSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
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
          } else {
            // The path was refused and nothing was stored, so the box must not
            // keep showing the rejected text as though it were the launch path.
            // Spring it back to the value the settings actually hold.
            t.setValue(s.opencodePath);
          }
        }));

    new Setting(containerEl)
      .setName(labels.reconnect.name)
      .setDesc(labels.reconnect.desc)
      .addButton((b) => b.setButtonText(labels.reconnect.button).setCta()
        .onClick(async () => {
          const view = this.firstReconnectableView();
          const connected = view ? await view.reconnectAgent() : await this.plugin.initClient();
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
  }

  private renderAgentSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    const availableAgents = this.getAvailableAgents();
    const availableModels = this.getAvailableModels();
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
      .setName(labels.defaultEffort.name)
      .setDesc(labels.defaultEffort.desc)
      .addDropdown((d) => d.addOptions({
        default: locale().toolbar.effort.default,
        minimal: locale().toolbar.effort.minimal,
        low: locale().toolbar.effort.low,
        medium: locale().toolbar.effort.medium,
        high: locale().toolbar.effort.high,
        xhigh: locale().toolbar.effort.xhigh,
        max: locale().toolbar.effort.max,
      })
        .setValue(s.defaultEffort)
        .onChange(async (v) => { s.defaultEffort = v; await this.save(); }));

    new Setting(containerEl)
      .setName(labels.permissionMode.name)
      .setDesc(labels.permissionMode.desc)
      .addDropdown((d) => d.addOptions({
        yolo: labels.permissionMode.yolo,
        plan: labels.permissionMode.plan,
        safe: labels.permissionMode.safe,
        readonly: labels.permissionMode.readonly,
      })
        .setValue(s.permissionMode)
        .onChange(async (v) => {
          s.permissionMode = v as PermissionLevel;
          await this.save();
          const client = this.plugin.getClient();
          if (client) {
            client.permissionMode = v as PermissionLevel;
            applyPermissionTier(client, s.permissionMode, s);
          }
          // The chat bar carries its own permission selector and reads the
          // setting only when a tab is activated, so without this push it keeps
          // naming the tier that was in force before this dropdown moved.
          this.refreshOpenViewsPermission();
        }));

    new Setting(containerEl)
      .setName(labels.customAgents.active)
      .setDesc(labels.customAgents.activeDesc)
      .addDropdown((d) => {
        const options: Record<string, string> = { '': labels.customAgents.none };
        // Only an agent whose prompt will actually be attached may be named here.
        // The send path drops one that fails validation — a blank name or
        // instruction, a duplicate or unknown skill reference — without a word,
        // so listing an enabled-but-invalid agent promised a tier no prompt would
        // ever carry.
        for (const agent of s.customAgents.filter(
          (item) => item.enabled && validateCustomAgent(item, s.customSkills).length === 0,
        )) {
          options[agent.id] = agent.name || agent.id;
        }
        d.addOptions(options);
        // A stored id no longer offered gets the honest reading — nothing is in
        // force — rather than a select showing neither the name nor None.
        d.setValue(s.activeCustomAgentId && s.activeCustomAgentId in options ? s.activeCustomAgentId : '');
        d.onChange(async (v) => { s.activeCustomAgentId = v; await this.save(); });
      });

    // ── System Prompt ──
  }

  private renderSystemPromptSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    new Setting(containerEl).setName(labels.systemPrompt.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.systemPrompt.name)
      .setDesc(labels.systemPrompt.desc)
      .addTextArea((c) => {
        c.setValue(s.systemPrompt);
        c.setPlaceholder(labels.systemPrompt.placeholder);
        c.inputEl.rows = 6;
        c.inputEl.classList.add('co-ober-prompt-input');
        c.onChange(async (v) => {
          s.systemPrompt = v;
          await this.save();
        });
      });

    // ── Notes & Context ──
  }

  private renderNotesSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
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
          const n = parseBoundedInt(v, 100, 1_000_000);
          if (n === null) {
            t.setValue(String(s.maxNoteSize));
            return;
          }
          s.maxNoteSize = n;
          await this.save();
          new Notice(locale().settings.notes.saved);
          // Live push: the connected handler caches maxBytes at set time.
          const client = this.plugin.getClient();
          if (client) applyPermissionTier(client, s.permissionMode, s);
        }));

    // ── Custom Agents & Skills ──
  }

  private renderCustomAgentsSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    const availableSkills = this.getAvailableSkills();
    new Setting(containerEl).setName(labels.customAgents.heading).setHeading();

    for (const agent of s.customAgents) {
      this.addCustomAgentBlock(containerEl, agent);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.customAgents.add)
        .onClick(async () => {
          const agent: CustomAgentDefinition = {
            id: nextRuleId(s.customAgents, 'agent-'),
            enabled: true,
            name: labels.customAgents.defaultName,
            description: '',
            instructions: '',
            skillIds: [],
          };
          s.customAgents.push(agent);
          await this.save();
          this.render();
        }));

    new Setting(containerEl).setName(labels.customSkills.heading).setHeading();

    new Setting(containerEl).setName(labels.customSkills.loadedHeading).setHeading();

    if (this.runtimeOptionsLoading && !this.runtimeOptionsLoaded) {
      new Setting(containerEl).setName(labels.customSkills.loading);
    } else if (!this.runtimeOptionsLoaded && (this.runtimeOptionsUnavailable || availableSkills.length === 0)) {
      // Two ways to not have a runtime list: the fetch was refused, or the
      // panel was never asked to fetch (a plain open has no Reconnect click
      // and `getAvailableSkills` falls back to an empty session snapshot).
      // Both say "the settings cannot certify what the runtime has". Only a
      // completed empty fetch — the `loaded && length === 0` branch below —
      // earns the "these are all the skills: none" wording; a survey that was
      // never taken may not sign off on emptiness.
      new Setting(containerEl).setName(labels.customSkills.loadedUnavailable);
    } else if (this.runtimeOptionsLoaded && availableSkills.length === 0) {
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
            id: nextRuleId(s.customSkills, 'skill-'),
            enabled: true,
            name: labels.customSkills.defaultName,
            description: '',
            instructions: '',
          };
          s.customSkills.push(skill);
          await this.save();
          this.render();
        }));

    // ── Common Models ──
  }

  private renderCommonModelsSection(containerEl: HTMLElement): void {
    const labels = locale().settings;
    const availableModels = this.getAvailableModels();
    new Setting(containerEl)
      .setName(labels.commonModels.heading)
      .setDesc(labels.commonModels.desc)
      .setHeading();

    if (this.runtimeOptionsLoading && !this.runtimeOptionsLoaded) {
      new Setting(containerEl).setName(labels.commonModels.loading);
    } else if (!this.runtimeOptionsLoaded && (this.runtimeOptionsUnavailable || availableModels.length === 0)) {
      // The models row shares the survey with skills. A rejected fetch and a
      // never-asked-to-fetch open both leave the panel unable to say "no
      // models exist" — that assertion belongs only to a completed empty
      // read, not to a section the reader just opened.
      new Setting(containerEl).setName(labels.commonModels.unavailable);
    } else if (this.runtimeOptionsLoaded && availableModels.length === 0) {
      new Setting(containerEl).setName(labels.commonModels.empty);
    }

    for (const model of availableModels) {
      this.addCommonModelToggle(containerEl, model);
    }

    // ── MCP Servers ──
  }

  private renderMcpSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    new Setting(containerEl).setName(labels.mcp.heading).setHeading();

    for (const server of s.mcpServers) {
      this.addMcpServerBlock(containerEl, server);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.mcp.add)
        .onClick(async () => {
          const server: McpServerConfig = {
            type: 'stdio',
            id: nextRuleId(s.mcpServers),
            enabled: true,
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem'],
            env: [],
          };
          s.mcpServers.push(server);
          await this.save();
          this.render();
        }));

    // ── Sync Rules ──
  }

  private renderSyncRulesSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    new Setting(containerEl).setName(labels.sync.heading).setHeading();

    for (const rule of s.syncRules) {
      this.addSyncRuleBlock(containerEl, rule);
    }

    new Setting(containerEl)
      .setName('')
      .addButton((b) => b.setButtonText(labels.sync.add)
        .onClick(async () => {
          const rule: SyncRule = {
            id: nextRuleId(s.syncRules),
            enabled: true,
            toolName: 'edit',
            folder: s.defaultNoteFolder,
            filenameTemplate: '{{tool}}-{{date}}-{{shortId}}',
          };
          s.syncRules.push(rule);
          await this.save();
          this.render();
        }));

    // ── Appearance ──
  }

  private renderAppearanceSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
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
          // The diagnostics rows are the finished label/detail strings that
          // collectDiagnostics baked from the locale it ran in. Re-rendering
          // restamps the PASS/FAIL prefix (read fresh below) but can only echo
          // those cached strings verbatim, so a reader who switched to 中文 kept
          // seeing English rows — "Path: found at …" — inside an otherwise
          // translated panel. They are restorable only by probing again, which is
          // the user's click, not ours; withdraw them to the honest "not run yet"
          // state the panel shows before the first run rather than freeze them.
          this.diagnosticsResults = [];
          this.refreshOpenViewsLocale();
          this.render();
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
  }

  private renderSessionLimitsSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    new Setting(containerEl).setName(labels.sessionLimits.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.sessionLimits.maxMessages)
      .setDesc(labels.sessionLimits.maxMessagesDesc)
      .addText((t) => t.setValue(String(s.maxSessionMessages ?? 200))
        .setPlaceholder('200')
        .onChange(async (v) => {
          const n = parseBoundedInt(v, 1, 10_000);
          if (n === null) {
            t.setValue(String(s.maxSessionMessages ?? 200));
            return;
          }
          s.maxSessionMessages = n;
          await this.save();
        }));

    new Setting(containerEl)
      .setName(labels.sessionLimits.retentionDays)
      .setDesc(labels.sessionLimits.retentionDaysDesc)
      .addText((t) => t.setValue(String(s.sessionRetentionDays ?? 30))
        .setPlaceholder('30')
        .onChange(async (v) => {
          const n = parseBoundedInt(v, 1, 3650);
          if (n === null) {
            t.setValue(String(s.sessionRetentionDays ?? 30));
            return;
          }
          s.sessionRetentionDays = n;
          await this.save();
        }));

    new Setting(containerEl)
      .setName(labels.sessionLimits.maxOpenTabs)
      .setDesc(labels.sessionLimits.maxOpenTabsDesc)
      .addText((t) => t.setValue(String(s.maxOpenTabs ?? DEFAULT_OPEN_TABS))
        .setPlaceholder(String(DEFAULT_OPEN_TABS))
        .onChange(async (v) => {
          const n = parseBoundedInt(v, MIN_OPEN_TABS, MAX_OPEN_TABS);
          if (n === null) {
            t.setValue(String(s.maxOpenTabs ?? DEFAULT_OPEN_TABS));
            return;
          }
          s.maxOpenTabs = n;
          await this.save();
          // The strip's disabled "+" and its tooltip follow the new limit now,
          // not at the next tab change.
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            (leaf.view as LocaleAwareView).refreshTabBar?.();
          }
        }));

    // ── File System Capability ──
  }

  private renderTerminalSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const labels = locale().settings;
    new Setting(containerEl).setName(labels.fsCapability.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.fsCapability.mode)
      .setDesc(labels.fsCapability.modeDesc)
      .addDropdown((d) => d.addOptions({
        enabled: labels.fsCapability.enabled,
        readonly: labels.fsCapability.readonly,
        disabled: labels.fsCapability.disabled,
      })
        .setValue(s.fsCapability ?? 'enabled')
        .onChange(async (v) => {
          s.fsCapability = v as FsCapabilityMode;
          await this.save();
          // Update connected client
          const client = this.plugin.getClient();
          if (client) {
            // Through the tier, not around it: under *readonly* or *plan* this
            // setting is remembered but the live client keeps writes closed, so
            // picking *enabled* here cannot open the write surface the tier
            // exists to shut.
            applyPermissionTier(client, s.permissionMode, s);
          }
        }));

    // ── Terminal Capability ──
    new Setting(containerEl).setName(labels.terminalCapability.heading).setHeading();

    new Setting(containerEl)
      .setName(labels.terminalCapability.mode)
      .setDesc(labels.terminalCapability.modeDesc)
      .addDropdown((d) => d.addOptions({
        enabled: labels.terminalCapability.enabled,
        disabled: labels.terminalCapability.disabled,
      })
        .setValue(s.terminalCapability ?? 'enabled')
        .onChange(async (v) => {
          s.terminalCapability = v as TerminalCapabilityMode;
          await this.save();
          const client = this.plugin.getClient();
          if (client) {
            // The same gate as the file surface above: a tier that forbids
            // running commands does not start honouring them because this
            // dropdown was moved.
            applyPermissionTier(client, s.permissionMode, s);
          }
        }));

    new Setting(containerEl)
      .setName(labels.terminalCapability.timeout)
      .setDesc(labels.terminalCapability.timeoutDesc)
      .addText((t) => t.setValue(String(s.terminalTimeoutMs ?? 30000))
        .setPlaceholder('30000')
        .onChange(async (v) => {
          const n = parseBoundedInt(v, 100, 600_000);
          if (n === null) {
            t.setValue(String(s.terminalTimeoutMs ?? 30000));
            return;
          }
          s.terminalTimeoutMs = n;
          await this.save();
          const client = this.plugin.getClient();
          if (client) applyPermissionTier(client, s.permissionMode, s);
        }));

    new Setting(containerEl)
      .setName(labels.terminalCapability.maxOutput)
      .setDesc(labels.terminalCapability.maxOutputDesc)
      .addText((t) => t.setValue(String(s.terminalMaxOutputBytes ?? 100000))
        .setPlaceholder('100000')
        .onChange(async (v) => {
          const n = parseBoundedInt(v, 1_000, 10_000_000);
          if (n === null) {
            t.setValue(String(s.terminalMaxOutputBytes ?? 100000));
            return;
          }
          s.terminalMaxOutputBytes = n;
          await this.save();
          const client = this.plugin.getClient();
          if (client) applyPermissionTier(client, s.permissionMode, s);
        }));

    // Idle timeout
    const idleLabels = locale().settings.idleTimeout;
    new Setting(containerEl)
      .setName(idleLabels.name)
      .setDesc(idleLabels.desc)
      .addText((t) => t.setValue(String(s.idleTimeoutMs ?? 300000))
        .setPlaceholder('300000')
        .onChange(async (v) => {
          const n = parseBoundedInt(v, 0, 3_600_000);
          if (n === null) {
            t.setValue(String(s.idleTimeoutMs ?? 300000));
            return;
          }
          s.idleTimeoutMs = n;
          await this.save();
          const client = this.plugin.getClient();
          if (client) {
            // 0 means "no idle timeout" — pass it through honestly.
            client.idleTimeoutMs = n;
          }
        }));
  }


  private addSyncRuleBlock(containerEl: HTMLElement, rule: SyncRule): void {
    addSyncRuleBlock(containerEl, rule, this.plugin.settings, () => this.save(), () => this.render());
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
    this.render();

    try {
      this.diagnosticsResults = await this.collectDiagnostics();
    } catch {
      const labels = locale().settings.diagnostics;
      this.diagnosticsResults = [{ label: labels.heading, ok: false, detail: labels.unexpectedError }];
    } finally {
      this.diagnosticsRunning = false;
      this.render();
    }
  }

  private async collectDiagnostics(): Promise<DiagnosticResult[]> {
    const labels = locale().settings.diagnostics;
    const results: DiagnosticResult[] = [];

    const pathStatus = this.getOpencodePathStatus(this.plugin.settings.opencodePath);
    results.push({ label: labels.path, ok: pathStatus.ok, detail: pathStatus.detail });

    const existingClient = this.plugin.getClient();
    const connected = existingClient?.isConnected() ? true : await this.plugin.initClient();
    const client = this.plugin.getClient();
    results.push({
      label: labels.connection,
      ok: connected,
      detail: connected ? labels.connectionOk : labels.connectionFailed,
    });

    const runtimeQueried = connected && !!client;
    // The counts are minted as zeros only for the branch that never asks. When
    // no agent is connected nothing supplies the runtime lists, so interpolating
    // {modes}/{models}/{commands} out of that placeholder printed "0 agents, 0
    // models, 0 commands" — a settled measurement of a question the panel never
    // posed, sitting right under the row that already says the connection
    // failed. Say the question was not asked instead; the genuinely-empty case
    // (an agent connected and reporting no lists) still reads out real zeros.
    //
    // A connected agent's own query may still fail at the transport, and before
    // this release that failure was folded into the same zeros as a settled
    // empty answer: `.catch(() => [])` turned a rejection into an empty array,
    // so a stream that died mid-read certified "0 agents, 0 models, 0 commands"
    // — the exact reading a working connected agent would print only when it
    // really had nothing to say. The failure now has its own bucket, and the
    // row names it as one question that could not be answered instead of three
    // zeros that were.
    const runtimeOutcome = runtimeQueried && client
      ? await this.getRuntimeMetadataCounts(client)
      : null;
    const runtimeCounts = runtimeOutcome?.ok ? runtimeOutcome.counts : { modes: 0, models: 0, commands: 0 };
    const runtimeLine = runtimeOutcome === null
      ? labels.runtimeNotQueried
      : runtimeOutcome.ok
        ? labels.runtimeDetail
          .replace('{modes}', String(runtimeCounts.modes))
          .replace('{models}', String(runtimeCounts.models))
          .replace('{commands}', String(runtimeCounts.commands))
        : labels.runtimeUnavailable;
    results.push({
      label: labels.runtime,
      ok: runtimeOutcome !== null && runtimeOutcome.ok
        && runtimeCounts.modes + runtimeCounts.models + runtimeCounts.commands > 0,
      detail: runtimeLine,
    });

    const configuredMcp = this.plugin.settings.mcpServers.length;
    const enabledServers = this.plugin.settings.mcpServers.filter((server) => server.enabled);
    const enabledMcp = enabledServers.length;
    // A Pass has to mean the enabled servers can actually be launched, not merely
    // that their counts were read. An enabled stdio entry with no command, or an
    // http/sse entry with no url, names nothing to start, so claiming Pass over
    // it asserted a health the panel never checked.
    const mcpRunnable = enabledServers.every((server) =>
      server.type === 'stdio' ? server.command.trim().length > 0 : server.url.trim().length > 0);
    results.push({
      label: labels.mcp,
      ok: mcpRunnable,
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

  private async getRuntimeMetadataCounts(
    client: OpencodeClient,
  ): Promise<{ ok: true, counts: { modes: number, models: number, commands: number } } | { ok: false }> {
    const snapshot = client.getSessionSnapshot();
    const snapshotCounts = {
      modes: snapshot.availableModes.length,
      models: snapshot.availableModels.length,
      commands: snapshot.availableCommands.length,
    };
    if (snapshotCounts.modes + snapshotCounts.models + snapshotCounts.commands > 0) {
      return { ok: true, counts: snapshotCounts };
    }

    // A rejection is a rejection, not an empty. The old `.catch(() => [])`
    // swallowed both into the same zero-length array, so a stream that died
    // and an agent that truly has nothing were indistinguishable on the
    // diagnostics row. Track the failure at the seam and let the caller
    // paint a distinct reading.
    let failed = false;
    const settled = await Promise.all([
      client.getAvailableAgents().catch(() => { failed = true; return [] as ModeOption[]; }),
      client.getAvailableModels().catch(() => { failed = true; return [] as ModelOption[]; }),
      client.getAvailableCommands().catch(() => { failed = true; return [] as AvailableCommand[]; }),
    ]);
    if (failed) return { ok: false };
    const [agents, models, commands] = settled;
    return { ok: true, counts: { modes: agents.length, models: models.length, commands: commands.length } };
  }

  private addCustomAgentBlock(containerEl: HTMLElement, agent: CustomAgentDefinition): void {
    addCustomAgentBlock(containerEl, agent, this.plugin.settings, () => this.save(), () => this.render(), (c, n) => this.renameCustomAgent(c, n));
  }

  private addCustomSkillBlock(containerEl: HTMLElement, skill: CustomSkillDefinition): void {
    addCustomSkillBlock(containerEl, skill, this.plugin.settings, () => this.save(), () => this.render(), (c, n) => this.renameCustomSkill(c, n));
  }

  private addCommonModelToggle(containerEl: HTMLElement, model: ModelOption): void {
    addCommonModelToggle(containerEl, model, this.plugin.settings, () => this.save(), () => this.refreshOpenViewsModels());
  }

  private addMcpServerBlock(containerEl: HTMLElement, server: McpServerConfig): void {
    addMcpServerBlock(containerEl, server, this.plugin.settings, () => this.save(), () => this.render(), this.getAgentCapabilities()?.mcpCapabilities);
  }

  private renameCustomAgent(currentId: string, nextId: string): boolean {
    return renameCustomAgent(currentId, nextId, this.plugin.settings, () => this.save(), locale().settings);
  }

  private renameCustomSkill(currentId: string, nextId: string): boolean {
    return renameCustomSkill(currentId, nextId, this.plugin.settings, () => this.save(), locale().settings);
  }

  private getAvailableAgents(): ModeOption[] {
    if (this.runtimeOptionsLoaded) return this.runtimeAgents;
    try {
      return this.plugin.getClient()?.getSessionSnapshot().availableModes ?? [];
    } catch {
      return [];
    }
  }

  private getAvailableModels(): ModelOption[] {
    if (this.runtimeOptionsLoaded) return this.runtimeModels;
    try {
      return this.plugin.getClient()?.getSessionSnapshot().availableModels ?? [];
    } catch {
      return [];
    }
  }

  private getAvailableSkills(): AvailableCommand[] {
    if (this.runtimeOptionsLoaded) return this.runtimeSkills;
    try {
      return this.plugin.getClient()?.getSessionSnapshot().availableCommands ?? [];
    } catch {
      return [];
    }
  }

  private getAgentCapabilities(): AgentCapabilities | null {
    try {
      const client = this.plugin.getClient();
      if (!client?.isConnected()) return null;
      return client.getAgentCapabilities();
    } catch {
      return null;
    }
  }

  private async loadRuntimeOptions(): Promise<void> {
    if (this.runtimeOptionsLoading || this.runtimeOptionsLoaded) return;
    this.runtimeOptionsLoading = true;
    this.runtimeOptionsUnavailable = false;
    // The final render is deferred until after the finally clears the loading
    // flag; a render that fires while `loading` is still true would paint the
    // loading line over the failure signal the catch just set, and the reader
    // would keep looking at a spinner for a fetch that already died.
    let scheduleRender = false;
    try {
      const client = this.plugin.getClient();
      if (!client?.isConnected()) {
        // A client that was never reachable cannot answer whether skills or
        // models exist. Reporting "no runtime skills" here would be the same
        // claim about content the reader's dropdown never asked for; a fetch
        // that could not run is an unavailable, not an empty.
        this.runtimeOptionsUnavailable = true;
        scheduleRender = true;
        return;
      }

      const snapshot = client.getSessionSnapshot();

      // An agent that hangs up mid-`getAvailable*` used to leave the loading
      // flag down and `loaded` false with no other signal, so the next render
      // fell past "loading" and into "empty" — the same lie the native list
      // and native search were fixed for last release, in the settings read
      // whose caller can in fact tell failure from empty. The failure now
      // lands in a distinct flag and stays out of the `[]` path.
      const [agents, models, skills] = await Promise.all([
        client.getAvailableAgents(),
        client.getAvailableModels(),
        client.getAvailableCommands(),
      ]);
      this.runtimeAgents = agents.length > 0 ? agents : snapshot.availableModes;
      this.runtimeModels = models.length > 0 ? models : snapshot.availableModels;
      this.runtimeSkills = skills.length > 0 ? skills : snapshot.availableCommands;
      this.runtimeOptionsLoaded = true;
      scheduleRender = true;
    } catch (error) {
      this.runtimeOptionsUnavailable = true;
      console.error('[co-ober] runtime options fetch failed:', error);
      scheduleRender = true;
    } finally {
      this.runtimeOptionsLoading = false;
      if (scheduleRender) this.render();
    }
  }

  private buildAgentOptions(agents: ModeOption[]): Record<string, string> {
    const options: Record<string, string> = {};
    for (const agent of agents) options[agent.id] = agent.name;
    if (Object.keys(options).length === 0) {
      options.build = 'build';
      options.plan = 'plan';
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
      // The pane's own entry point: the option lists live on its controller,
      // which the view object does not expose.
      const view = leaf.view as ToolbarAwareView;
      view.reloadToolbarOptions?.();
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

  private refreshOpenViewsPermission(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view as PermissionAwareView;
      view.refreshPermissionMode?.();
    }
  }

  /**
   * Any open panel can serve a reconnect — they all drive the one shared client —
   * so the first leaf that answers is the one asked. With no panel open there is
   * no bound handler to re-point, and initClient() is the whole job.
   */
  private firstReconnectableView(): ReconnectableView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as Partial<ReconnectableView>;
      if (typeof view?.reconnectAgent === 'function') return view as ReconnectableView;
    }
    return null;
  }

  private validateOpencodePath(path: string): boolean {
    const status = this.getOpencodePathStatus(path);
    if (!status.ok) new Notice(status.detail);
    return status.ok;
  }

  private getOpencodePathStatus(path: string): PathDiagnostic {
    const labels = locale().settings.diagnostics;
    if (!path) return { ok: false, detail: labels.pathEmpty };
    // Same resolver the spawn path uses, so diagnostics can never disagree
    // with what actually launches (desktop PATH misses ~/.opencode/bin). The
    // row is titled "Resolved", so it names the target the resolver landed on —
    // not the query: a reader chasing a PATH gap needs the absolute path the
    // spawn will use, and echoing the bare command back would hide it.
    const resolved = resolveCommandPath(path);
    if (resolved) return { ok: true, detail: labels.pathFound.replace('{path}', resolved) };
    return { ok: false, detail: locale().settings.opencodePath.notFound.replace('{path}', path) };
  }
}
