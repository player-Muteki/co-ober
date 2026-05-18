import { Plugin } from 'obsidian';
import { AgentRuntime } from './client/agent';
import { AcpClient } from './client/acp';
import { CopsidianView } from './view/copsidianView';
import { CopsidianSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import type { CopsidianSettings } from './types';

export default class CopsidianPlugin extends Plugin {
  settings: CopsidianSettings = DEFAULT_SETTINGS;
  client: AgentRuntime | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new CopsidianView(leaf, this));
    this.addSettingTab(new CopsidianSettingsTab(this));
    this.addCommand({
      id: 'open-copsidian',
      name: 'Open Copsidian',
      callback: () => this.activateView(),
    });
    await this.initClient();
  }

  async loadSettings(): Promise<void> {
    this.settings = DEFAULT_SETTINGS;
    const data = await super.loadData();
    if (data) this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  override onunload(): void { this.client?.disconnect(); }

  override async loadData(): Promise<CopsidianSettings | null> {
    const saved = await super.loadData();
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  async activateView(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? await this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await (leaf as any).setViewType(VIEW_TYPE);
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async initClient(): Promise<void> {
    try {
      const acp = new AcpClient(this.settings.opencodePath);
      await acp.connect();
      this.client = new AgentRuntime(acp);
      this.client.permissionMode = this.settings.permissionMode;
    } catch (e) {
      console.error('[copsidian] Connect failed:', e);
    }
  }

  getClient(): AgentRuntime | null { return this.client; }
}
