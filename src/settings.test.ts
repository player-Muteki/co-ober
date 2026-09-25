// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { CoOberSettingsTab } from './settings';
import { DEFAULT_SETTINGS, VIEW_TYPE } from './types';
import { setLocale, t as locale } from './i18n/index';
import { Notice } from './test/obsidianMock';
import { installObsidianDomHelpers } from './test/domHelpers';
import type CoOberPlugin from './main';
import type { CoOberSettings } from './types';

installObsidianDomHelpers();

describe('CoOberSettingsTab locale refresh', () => {
  it('redraws settings labels and refreshes open chat views when language changes', async () => {
    setLocale('en');
    const refreshedView = { refreshLocale: vi.fn() };
    const plugin = createPlugin(refreshedView);
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    expect(tab.containerEl.textContent).toContain('Connection');
    expect(tab.containerEl.textContent).toContain('Language');

    const languageSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'zh')) as HTMLSelectElement | undefined;
    expect(languageSelect).toBeDefined();
    languageSelect!.value = 'zh';
    languageSelect!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(plugin.settings.language).toBe('zh');
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(refreshedView.refreshLocale).toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('连接');
    expect(tab.containerEl.textContent).toContain('语言');
    expect(tab.containerEl.textContent).not.toContain('Connection');
  });

  it('adds custom agents and skills from settings', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const addAgent = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === '+ Add Custom Agent') as HTMLButtonElement | undefined;
    const addSkill = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === '+ Add Custom Skill') as HTMLButtonElement | undefined;

    expect(addAgent).toBeDefined();
    expect(addSkill).toBeDefined();
    addAgent!.click();
    addSkill!.click();
    await flushPromises();

    expect(plugin.settings.customAgents).toHaveLength(1);
    expect(plugin.settings.customSkills).toHaveLength(1);
    expect(plugin.settings.customAgents[0].name).toBe('New Agent');
    expect(plugin.settings.customSkills[0].name).toBe('New Skill');
    expect(plugin.savePluginData).toHaveBeenCalledTimes(2);
  });

  it('renames custom agent and skill IDs while preserving references', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.customSkills.push({ id: 'writer', enabled: true, name: 'Writer', description: '', instructions: 'Write.' });
    plugin.settings.customAgents.push({
      id: 'planner',
      enabled: true,
      name: 'Planner',
      description: '',
      instructions: 'Plan.',
      skillIds: ['writer'],
    });
    plugin.settings.activeCustomAgentId = 'planner';
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const inputs = [...tab.containerEl.querySelectorAll('input')];
    const agentIdInput = inputs.find((input) => input.value === 'planner');
    const skillIdInput = inputs.filter((input) => input.value === 'writer').at(-1);
    expect(agentIdInput).toBeDefined();
    expect(skillIdInput).toBeDefined();

    agentIdInput!.value = 'researcher';
    agentIdInput!.dispatchEvent(new Event('change'));
    skillIdInput!.value = 'editor';
    skillIdInput!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(plugin.settings.customAgents[0].id).toBe('researcher');
    expect(plugin.settings.activeCustomAgentId).toBe('researcher');
    expect(plugin.settings.customSkills[0].id).toBe('editor');
    expect(plugin.settings.customAgents[0].skillIds).toEqual(['editor']);
  });

  it('rejects duplicate custom agent and skill IDs', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.customSkills.push(
      { id: 'writer', enabled: true, name: 'Writer', description: '', instructions: 'Write.' },
      { id: 'editor', enabled: true, name: 'Editor', description: '', instructions: 'Edit.' },
    );
    plugin.settings.customAgents.push(
      { id: 'planner', enabled: true, name: 'Planner', description: '', instructions: 'Plan.', skillIds: ['writer'] },
      { id: 'researcher', enabled: true, name: 'Researcher', description: '', instructions: 'Research.', skillIds: [] },
    );
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const inputs = [...tab.containerEl.querySelectorAll('input')];
    const plannerInput = inputs.find((input) => input.value === 'planner');
    const writerInput = inputs.filter((input) => input.value === 'writer').at(-1);
    expect(plannerInput).toBeDefined();
    expect(writerInput).toBeDefined();

    plannerInput!.value = 'researcher';
    plannerInput!.dispatchEvent(new Event('change'));
    writerInput!.value = 'editor';
    writerInput!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(plugin.settings.customAgents.map((agent) => agent.id)).toEqual(['planner', 'researcher']);
    expect(plugin.settings.customSkills.map((skill) => skill.id)).toEqual(['writer', 'editor']);
  });

  it('loads agents and models into settings and saves common model choices', async () => {
    setLocale('en');
    const refreshedView = { refreshLocale: vi.fn(), loadToolbarOptions: vi.fn() };
    const plugin = createPlugin(refreshedView, {
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'docs', name: 'Docs' },
      ],
      availableModels: [
        { modelId: 'openai/gpt', name: 'GPT' },
        { modelId: 'anthropic/claude', name: 'Claude' },
      ],
      availableCommands: [
        { name: 'skill-writer', description: 'Write with context' },
      ],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const selects = [...tab.containerEl.querySelectorAll('select')];
    const agentSelect = selects.find((select) => [...select.options].some((option) => option.value === 'docs'));
    const modelSelect = selects.find((select) => [...select.options].some((option) => option.value === 'openai/gpt'));
    expect(agentSelect).toBeDefined();
    expect(modelSelect).toBeDefined();
    expect(tab.containerEl.textContent).toContain('Common Models');
    expect(tab.containerEl.textContent).toContain('Custom Skills');
    expect(tab.containerEl.textContent).toContain('Loaded Skills');
    expect(tab.containerEl.textContent).toContain('skill-writer');

    const modelToggle = [...tab.containerEl.querySelectorAll('input[type="checkbox"]')]
      .find((input) => input.closest('.setting-item')?.textContent?.includes('GPT')) as HTMLInputElement | undefined;
    expect(modelToggle).toBeDefined();
    modelToggle!.checked = true;
    modelToggle!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(plugin.settings.commonModels).toEqual(['openai/gpt']);
    expect(refreshedView.loadToolbarOptions).toHaveBeenCalled();
  });

  it('renders successful diagnostics for connection and runtime metadata', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
      availableModels: [{ modelId: 'openai/gpt', name: 'GPT' }],
      availableCommands: [{ name: 'compact', description: 'Compact' }],
    });
    plugin.settings.mcpServers.push({ type: 'stdio', id: 'fs', enabled: true, name: 'filesystem', command: 'npx', args: ['-y'], env: [] });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    expect(diagnosticsButton).toBeDefined();
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('Pass: ACP connection');
    expect(tab.containerEl.textContent).toContain('Connected to OpenCode');
    expect(tab.containerEl.textContent).toContain('Pass: Runtime metadata');
    expect(tab.containerEl.textContent).toContain('1 agents, 1 models, 1 commands');
    expect(tab.containerEl.textContent).toContain('1 enabled, 1 configured');
    expect(tab.containerEl.textContent).toContain('ACP client version');
  });

  it('does not reconnect when an existing client is connected', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    vi.mocked(plugin.initClient).mockClear();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(plugin.getClient()?.isConnected).toHaveBeenCalled();
    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('Pass: ACP connection');
  });

  it('falls back to runtime metadata getters when snapshot is empty', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {
      availableModes: [{ id: 'docs', name: 'Docs' }],
      availableModels: [{ modelId: 'openai/gpt', name: 'GPT' }],
      availableCommands: [{ name: 'skill-writer', description: 'Write with context' }],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(plugin.getClient()?.getAvailableAgents).toHaveBeenCalled();
    expect(plugin.getClient()?.getAvailableModels).toHaveBeenCalled();
    expect(plugin.getClient()?.getAvailableCommands).toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('Pass: Runtime metadata');
    expect(tab.containerEl.textContent).toContain('1 agents, 1 models, 1 commands');
  });

  it('re-enables diagnostics button when diagnostics throws', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    await flushPromises();
    await flushPromises();
    vi.mocked(plugin.getClient()!.getSessionSnapshot).mockImplementation(() => {
      throw new Error('snapshot failed');
    });
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    const rerenderedButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    expect(rerenderedButton).toBeDefined();
    expect(rerenderedButton!.disabled).toBe(false);
  });

  it('reports failed diagnostics without mutating settings', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {}, false);
    plugin.settings.opencodePath = '';
    plugin.settings.defaultNoteFolder = '';
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(plugin.initClient).toHaveBeenCalled();
    expect(tab.containerEl.textContent).toContain('Fail: OpenCode CLI path');
    expect(tab.containerEl.textContent).toContain('OpenCode CLI path is empty');
    expect(tab.containerEl.textContent).toContain('Fail: ACP connection');
    expect(tab.containerEl.textContent).toContain('Failed to connect to OpenCode');
    expect(tab.containerEl.textContent).toContain('Fail: Runtime metadata');
    expect(tab.containerEl.textContent).toContain('Fail: Default sync folder');
    expect(plugin.settings.defaultNoteFolder).toBe('');
  });

  it('localizes diagnostics controls when switching language', async () => {
    setLocale('en');
    const refreshedView = { refreshLocale: vi.fn() };
    const plugin = createPlugin(refreshedView);
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    expect(tab.containerEl.textContent).toContain('Diagnostics');
    expect(tab.containerEl.textContent).toContain('Run Diagnostics');

    const languageSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'zh')) as HTMLSelectElement | undefined;
    languageSelect!.value = 'zh';
    languageSelect!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('诊断');
    expect(tab.containerEl.textContent).toContain('运行诊断');
    expect(tab.containerEl.textContent).not.toContain('Run Diagnostics');
  });

  it('does not connect or create metadata sessions when settings opens with an empty snapshot', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {
      availableModes: [{ id: 'docs', name: 'Docs' }],
      availableModels: [{ modelId: 'openai/gpt', name: 'GPT' }],
      availableCommands: [{ name: 'skill-writer', description: 'Write with context' }],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    expect(tab.containerEl.textContent).not.toContain('skill-writer');
    expect(tab.containerEl.textContent).toContain('No runtime skills loaded');
    await flushPromises();
    await flushPromises();

    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(plugin.getClient()?.createSession).not.toHaveBeenCalled();
    expect(plugin.getClient()?.closeSession).not.toHaveBeenCalled();
    expect(tab.containerEl.textContent).not.toContain('skill-writer');
  });

  it('disables http MCP type option when capability is false', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {}, true, { mcpCapabilities: { http: false } });
    plugin.settings.mcpServers.push({ type: 'stdio', id: 'fs', enabled: true, name: 'filesystem', command: 'npx', args: [], env: [] });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();

    const typeSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'http')) as HTMLSelectElement | undefined;
    expect(typeSelect).toBeDefined();
    const httpOption = [...typeSelect!.options].find((option) => option.value === 'http');
    expect(httpOption?.disabled).toBe(true);
    expect(httpOption?.textContent).toBe('http (not supported by current agent)');
  });
});

function createPlugin(
  refreshedView: { refreshLocale: () => void; loadToolbarOptions?: () => void },
  snapshot: {
    availableModes?: Array<{ id: string; name: string }>;
    availableModels?: Array<{ modelId: string; name: string }>;
    availableCommands?: Array<{ name: string; description: string }>;
  } = {},
  runtimeOptions = snapshot,
  initClientResult = true,
  capabilities: Record<string, unknown> | null = null,
): CoOberPlugin {
  const settings: CoOberSettings = {
    ...DEFAULT_SETTINGS,
    syncRules: DEFAULT_SETTINGS.syncRules.map((rule) => ({ ...rule })),
    mcpServers: [],
    customAgents: [],
    customSkills: [],
    activeCustomAgentId: '',
    commonModels: [],
    language: 'en',
  };
  const client = {
    isConnected: vi.fn().mockReturnValue(initClientResult),
    createSession: vi.fn().mockResolvedValue('settings-session'),
    closeSession: vi.fn().mockResolvedValue(undefined),
    getAvailableAgents: vi.fn().mockResolvedValue(runtimeOptions.availableModes ?? []),
    getAvailableModels: vi.fn().mockResolvedValue(runtimeOptions.availableModels ?? []),
    getAvailableCommands: vi.fn().mockResolvedValue(runtimeOptions.availableCommands ?? []),
    getSessionSnapshot: vi.fn(() => ({
      configOptions: [],
      availableCommands: snapshot.availableCommands ?? [],
      availableModels: snapshot.availableModels ?? [],
      availableModes: snapshot.availableModes ?? [],
      currentModelId: null,
      currentModeId: null,
    })),
    getAgentCapabilities: vi.fn(() => capabilities),
    setFsCapabilityMode: vi.fn(),
    setTerminalCapabilityMode: vi.fn(),
    idleTimeoutMs: 300000,
  };
  return {
    app: {
      workspace: {
        getLeavesOfType: vi.fn((viewType: string) => (
          viewType === VIEW_TYPE ? [{ view: refreshedView }] : []
        )),
      },
    },
    settings,
    savePluginData: vi.fn().mockResolvedValue(undefined),
    initClient: vi.fn().mockResolvedValue(initClientResult),
    getClient: vi.fn(() => client),
    client: null,
  } as unknown as CoOberPlugin;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CoOberSettingsTab default effort options', () => {
  it('offers the full reasoning-effort ladder', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();

    const effortSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'xhigh')) as HTMLSelectElement | undefined;
    expect(effortSelect).toBeDefined();
    expect([...effortSelect!.options].map((option) => option.value)).toEqual([
      'default',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });
});

describe('CoOberSettingsTab live capability push', () => {
  function findTextSettingInput(tab: CoOberSettingsTab, name: string): HTMLInputElement {
    const input = [...tab.containerEl.querySelectorAll('input')]
      .find((el) => el.type !== 'checkbox' && el.closest('.setting-item')?.textContent?.includes(name));
    expect(input).toBeDefined();
    return input as HTMLInputElement;
  }

  async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('change'));
    await flushPromises();
  }

  it('pushes maxNoteSize to the connected client so the cached handler limit updates', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const client = plugin.getClient()!;

    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '4096');

    expect(plugin.settings.maxNoteSize).toBe(4096);
    expect(client.setFsCapabilityMode).toHaveBeenCalledWith('enabled', 4096);
  });

  it('pushes terminal timeout and max output live', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const client = plugin.getClient()!;

    await changeInput(findTextSettingInput(tab, 'Command Timeout (ms)'), '5000');
    expect(client.setTerminalCapabilityMode).toHaveBeenCalledWith('enabled', 5000, 100000);

    await changeInput(findTextSettingInput(tab, 'Max Output Size (bytes)'), '2048');
    expect(client.setTerminalCapabilityMode).toHaveBeenCalledWith('enabled', 5000, 2048);
  });

  it('passes an idle timeout of 0 through as disabled', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const client = plugin.getClient()!;

    await changeInput(findTextSettingInput(tab, 'Idle Timeout (ms)'), '45000');
    expect(client.idleTimeoutMs).toBe(45000);

    await changeInput(findTextSettingInput(tab, 'Idle Timeout (ms)'), '0');
    expect(plugin.settings.idleTimeoutMs).toBe(0);
    expect(client.idleTimeoutMs).toBe(0);
  });

  it('rejects an out-of-range number with a visible hint and keeps the stored value', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const before = plugin.settings.maxNoteSize;
    Notice.messages.length = 0;

    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '999999999');

    expect(plugin.settings.maxNoteSize).toBe(before);
    expect(Notice.messages).toContain(
      locale().settings.invalidNumber.replace('{min}', '100').replace('{max}', '1000000'),
    );
  });

  it('rejects a non-numeric number field with the same hint', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const before = plugin.settings.sessionRetentionDays;
    Notice.messages.length = 0;

    await changeInput(findTextSettingInput(tab, 'Session Retention Days'), 'abc');

    expect(plugin.settings.sessionRetentionDays).toBe(before);
    expect(Notice.messages).toContain(
      locale().settings.invalidNumber.replace('{min}', '1').replace('{max}', '3650'),
    );
  });
});
