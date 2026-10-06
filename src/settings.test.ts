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

// A narrow override of the path resolver so one test can force a bare command to
// resolve to a DIFFERENT absolute target (what the spawn actually execs) and check
// the diagnostics row names that target rather than echoing the query. Every other
// export and every other input passes through to the real resolver untouched.
let fakeResolve: ((cmd: string) => string | null) | null = null;
vi.mock('./utils/commandResolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/commandResolution')>();
  return {
    ...actual,
    resolveCommandPath: (...args: Parameters<typeof actual.resolveCommandPath>) =>
      (fakeResolve ? fakeResolve(args[0]) : actual.resolveCommandPath(...args)),
  };
});

// The version row runs a real subprocess; a settings test must not depend on an
// OpenCode install on PATH. The probe is faked to a reading each test chooses,
// defaulting to the honest "did not answer" so any test that forgets to set one
// sees the failure branch rather than a fabricated success.
let fakeVersion: { raw: string; version: string | undefined; generation: 1 | 2 | undefined; failed: boolean } | null = null;
vi.mock('./opencode/OpencodeVersion', () => ({
  detectOpencodeVersion: vi.fn(async () =>
    fakeVersion ?? { raw: '', version: undefined, generation: undefined, failed: true }),
}));

// The native catalog row starts a brief loopback `opencode serve`; a settings test
// must not spawn a real CLI. The probe is faked to a reading each test chooses,
// defaulting to the honest "could not be read" so a test that forgets to set one
// sees the failure branch rather than a catalog the fake never observed.
let fakeCatalog: { status: 'observed' | 'unavailable'; models: unknown[]; commands: unknown[]; agents: unknown[] } | null = null;
vi.mock('./opencode/OpencodeCatalog', () => ({
  detectOpencodeNativeCatalog: vi.fn(async () =>
    fakeCatalog ?? { status: 'unavailable', models: [], commands: [], agents: [] }),
}));

// The native turn probe runs one throwaway `opencode serve` turn; a settings test
// must never spawn a real CLI or burn a model call. It is faked to the reading each
// test chooses, defaulting to `unavailable` so an unset test sees the failure branch.
let fakeTurn: { status: 'executed' | 'admitted' | 'unavailable'; modelId: string | undefined; finish: string | undefined; outputTokens: number | undefined } | null = null;
vi.mock('./opencode/OpencodeTurnProbe', () => ({
  detectOpencodeNativeTurnExecution: vi.fn(async () =>
    fakeTurn ?? { status: 'unavailable', modelId: undefined, finish: undefined, outputTokens: undefined }),
}));

// The native stream probe runs one throwaway turn and rebuilds its answer from the
// live event stream; a settings test must never spawn a real CLI or burn a model call.
// Faked to the reading each test chooses, defaulting to `unavailable`.
let fakeStream: { status: 'streamed' | 'admitted' | 'unavailable'; textDeltas: number; reasoningDeltas: number; answer: string | undefined; confirmed: boolean } | null = null;
vi.mock('./opencode/OpencodeStreamProbe', () => ({
  detectOpencodeNativeTurnStream: vi.fn(async () =>
    fakeStream ?? { status: 'unavailable', textDeltas: 0, reasoningDeltas: 0, answer: undefined, confirmed: false }),
}));

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

  it('gives two agents added in the same millisecond different ids', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    // Re-found each time: the first add re-renders the whole tab.
    const clickAdd = (text: string) => {
      const button = [...tab.containerEl.querySelectorAll('button')]
        .find((b) => b.textContent === text) as HTMLButtonElement;
      button.click();
    };

    clickAdd('+ Add Custom Agent');
    await flushPromises();
    clickAdd('+ Add Custom Agent');
    await flushPromises();

    // Both records would carry `agent-1700000000000`, and every delete handler
    // here filters by id — so removing one agent removed the other with it.
    const ids = plugin.settings.customAgents.map((agent) => agent.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('agent-'))).toBe(true);

    clickAdd('+ Add Custom Skill');
    await flushPromises();
    clickAdd('+ Add Custom Skill');
    await flushPromises();
    const skillIds = plugin.settings.customSkills.map((skill) => skill.id);
    expect(skillIds).toHaveLength(2);
    expect(new Set(skillIds).size).toBe(2);
    expect(skillIds.every((id) => id.startsWith('skill-'))).toBe(true);
    now.mockRestore();
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

  it('says so when an ID rename is cleared out and springs the field back', async () => {
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
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    vi.mocked(plugin.savePluginData).mockClear();
    Notice.messages.length = 0;
    const inputs = [...tab.containerEl.querySelectorAll('input')];
    const agentIdInput = inputs.find((input) => input.value === 'planner');
    const skillIdInput = inputs.filter((input) => input.value === 'writer').at(-1);
    expect(agentIdInput).toBeDefined();
    expect(skillIdInput).toBeDefined();

    agentIdInput!.value = '   ';
    agentIdInput!.dispatchEvent(new Event('change'));
    skillIdInput!.value = '';
    skillIdInput!.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(Notice.messages).toEqual([
      'A custom agent ID cannot be empty — the previous ID was kept.',
      'A custom skill ID cannot be empty — the previous ID was kept.',
    ]);
    expect(plugin.settings.customAgents[0].id).toBe('planner');
    expect(plugin.settings.customSkills[0].id).toBe('writer');
    expect(agentIdInput!.value).toBe('planner');
    expect(skillIdInput!.value).toBe('writer');
    expect(plugin.savePluginData).not.toHaveBeenCalled();
  });

  it('loads agents and models into settings and saves common model choices', async () => {
    setLocale('en');
    const refreshedView = { refreshLocale: vi.fn(), reloadToolbarOptions: vi.fn() };
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
    expect(refreshedView.reloadToolbarOptions).toHaveBeenCalled();
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

  it('does not report MCP servers passing when an enabled one has nothing to launch', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    plugin.settings.mcpServers.push(
      { type: 'stdio', id: 'broken', enabled: true, name: 'broken', command: '', args: [], env: [] },
    );
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('Fail: MCP servers');
    expect(tab.containerEl.textContent).not.toContain('Pass: MCP servers');
    expect(tab.containerEl.textContent).toContain('1 enabled, 1 configured');
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

  it('names the resolved target, not the query, on the diagnostics path row', async () => {
    // The row is titled "Resolved" and runs the same resolver the spawn uses, yet
    // it interpolated the raw input into its detail: a bare command found in a
    // hidden install dir printed 'Resolved "opencode"' and withheld the absolute
    // path the process will actually exec — the very PATH gap the resolver exists
    // to close, so the line echoed the question while hiding the answer. The
    // detail now names the resolution it claims to report.
    setLocale('en');
    fakeResolve = (cmd) => (cmd === 'opencode' ? '/opt/opencode/bin/opencode' : null);
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      plugin.settings.opencodePath = 'opencode';
      const tab = new CoOberSettingsTab(plugin);

      tab.display();
      const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
        .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
      diagnosticsButton!.click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Pass: OpenCode CLI path');
      expect(tab.containerEl.textContent).toContain('Resolved "/opt/opencode/bin/opencode"');
      expect(tab.containerEl.textContent).not.toContain('Resolved "opencode"');
    } finally {
      fakeResolve = null;
    }
  });

  it('shows the version the probe observed, with its generation named', async () => {
    setLocale('en');
    fakeVersion = { raw: 'opencode v1.5.3', version: '1.5.3', generation: 1, failed: false };
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      const tab = new CoOberSettingsTab(plugin);
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Pass: OpenCode version');
      expect(tab.containerEl.textContent).toContain('v1 · 1.5.3');
    } finally {
      fakeVersion = null;
    }
  });

  it('fails the version row when the CLI did not answer, rather than guessing', async () => {
    setLocale('en');
    fakeVersion = { raw: '', version: undefined, generation: undefined, failed: true };
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      const tab = new CoOberSettingsTab(plugin);
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Fail: OpenCode version');
      expect(tab.containerEl.textContent).toContain('Could not read the version');
    } finally {
      fakeVersion = null;
    }
  });

  it('shows the native catalog counts the probe observed', async () => {
    setLocale('en');
    fakeCatalog = {
      status: 'observed',
      models: [{ modelId: 'p/a', name: 'p/Alpha', context: undefined }],
      commands: [{ name: 'init', description: undefined }],
      agents: [{ id: 'build', description: undefined }, { id: 'plan', description: undefined }],
    };
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      const tab = new CoOberSettingsTab(plugin);
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Pass: Native OpenCode catalog');
      expect(tab.containerEl.textContent).toContain('1 models, 1 commands, 2 agents');
    } finally {
      fakeCatalog = null;
    }
  });

  it('fails the catalog row when serve did not answer, not as an empty catalog', async () => {
    setLocale('en');
    fakeCatalog = { status: 'unavailable', models: [], commands: [], agents: [] };
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      const tab = new CoOberSettingsTab(plugin);
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Fail: Native OpenCode catalog');
      expect(tab.containerEl.textContent).toContain('`opencode serve` did not answer');
      // An unreachable install is never dressed up as a catalog that is genuinely
      // empty — the two failures carry different remedies and must not collapse.
      expect(tab.containerEl.textContent).not.toContain('listed no models');
    } finally {
      fakeCatalog = null;
    }
  });

  it('fails the catalog row when an answered catalog lists nothing', async () => {
    setLocale('en');
    // Pin the version probe to a clean reading so the whole-container negative
    // assertion below isolates the catalog row: the version row's default
    // failure also prints "did not answer", and this test is about the catalog
    // not collapsing its empty branch into the unavailable sentence.
    fakeVersion = { raw: 'opencode v1.5.3', version: '1.5.3', generation: 1, failed: false };
    fakeCatalog = { status: 'observed', models: [], commands: [], agents: [] };
    try {
      const plugin = createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      });
      const tab = new CoOberSettingsTab(plugin);
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Fail: Native OpenCode catalog');
      expect(tab.containerEl.textContent).toContain('listed no models');
      expect(tab.containerEl.textContent).not.toContain('did not answer');
    } finally {
      fakeCatalog = null;
      fakeVersion = null;
    }
  });

  it('leaves the native catalog section un-answered until the reader asks', async () => {
    setLocale('en');
    fakeCatalog = {
      status: 'observed',
      models: [{ modelId: 'p/a', name: 'p/Alpha', context: 128000 }],
      commands: [{ name: 'init', description: 'Initialize' }],
      agents: [{ id: 'build', description: 'Build agent' }],
    };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      // Opening the panel has not contacted the native install, so it must not
      // already list a catalog it never asked for — the names stay hidden.
      expect(tab.containerEl.textContent).toContain('Not loaded');
      expect(tab.containerEl.textContent).not.toContain('p/Alpha');
    } finally {
      fakeCatalog = null;
    }
  });

  it('lists the native catalog by name once loaded, with each model context', async () => {
    setLocale('en');
    fakeCatalog = {
      status: 'observed',
      models: [{ modelId: 'p/a', name: 'p/Alpha', context: 128000 }, { modelId: 'p/b', name: 'p/Beta', context: undefined }],
      commands: [{ name: 'init', description: 'Initialize the repo' }, { name: 'review', description: undefined }],
      agents: [{ id: 'build', description: undefined }],
    };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Load catalog') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('p/Alpha');
      expect(tab.containerEl.textContent).toContain('Context: 128000 tokens');
      expect(tab.containerEl.textContent).toContain('p/Beta');
      expect(tab.containerEl.textContent).toContain('No context window reported');
      expect(tab.containerEl.textContent).toContain('Initialize the repo');
      expect(tab.containerEl.textContent).toContain('No description reported');
      expect(tab.containerEl.textContent).toContain('build');
    } finally {
      fakeCatalog = null;
    }
  });

  it('names the catalog surface as unreachable, not empty, when serve did not answer', async () => {
    setLocale('en');
    fakeCatalog = { status: 'unavailable', models: [], commands: [], agents: [] };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Load catalog') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('`opencode serve` did not answer');
      expect(tab.containerEl.textContent).not.toContain('listed no models');
    } finally {
      fakeCatalog = null;
    }
  });

  it('names the catalog surface as empty, not unreachable, when it answered with nothing', async () => {
    setLocale('en');
    fakeCatalog = { status: 'observed', models: [], commands: [], agents: [] };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Load catalog') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('listed no models');
      expect(tab.containerEl.textContent).not.toContain('did not answer');
    } finally {
      fakeCatalog = null;
    }
  });

  it('leaves the native turn probe un-run until the button is pressed', async () => {
    setLocale('en');
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      // Opening the panel has not spent a model call, so it must not already
      // claim a turn ran — the executed sentence stays hidden until asked.
      expect(tab.containerEl.textContent).toContain('Not run');
      expect(tab.containerEl.textContent).not.toContain('executed a throwaway turn');
    } finally {
      fakeTurn = null;
    }
  });

  it('reports the native turn executed only with the model it read back', async () => {
    setLocale('en');
    fakeTurn = { status: 'executed', modelId: 'p/a', finish: 'stop', outputTokens: 7 };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe a turn') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('executed a throwaway turn');
      expect(tab.containerEl.textContent).toContain('Model p/a · finished stop · 7 output tokens');
    } finally {
      fakeTurn = null;
    }
  });

  it('separates an admitted-but-unanswered turn from an executed one', async () => {
    setLocale('en');
    fakeTurn = { status: 'admitted', modelId: undefined, finish: undefined, outputTokens: undefined };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe a turn') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      // A prompt the kernel took but never answered is the honest middle state:
      // the channel is live, execution is NOT confirmed. It must not read as a
      // success nor as the total-failure branch.
      expect(tab.containerEl.textContent).toContain('turn channel live, execution not confirmed');
      expect(tab.containerEl.textContent).not.toContain('executed a throwaway turn');
      expect(tab.containerEl.textContent).not.toContain('Could not run a native turn');
    } finally {
      fakeTurn = null;
    }
  });

  it('names an unreachable native turn as failed, not as admitted or executed', async () => {
    setLocale('en');
    fakeTurn = { status: 'unavailable', modelId: undefined, finish: undefined, outputTokens: undefined };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe a turn') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Could not run a native turn');
      expect(tab.containerEl.textContent).not.toContain('turn channel live');
      expect(tab.containerEl.textContent).not.toContain('executed a throwaway turn');
    } finally {
      fakeTurn = null;
    }
  });

  it('leaves the native stream probe un-run until the button is pressed', async () => {
    setLocale('en');
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      // Opening the panel has not spent a model call, so it must not already claim
      // the kernel streamed an answer it never watched.
      expect(tab.containerEl.textContent).toContain('Probe the stream');
      expect(tab.containerEl.textContent).not.toContain('streamed an answer live');
    } finally {
      fakeStream = null;
    }
  });

  it('reports the answer the stream probe assembled, and that the kernel agreed', async () => {
    setLocale('en');
    fakeStream = { status: 'streamed', textDeltas: 1, reasoningDeltas: 15, answer: 'OK', confirmed: true };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe the stream') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('streamed an answer live');
      expect(tab.containerEl.textContent).toContain('1 text deltas');
      expect(tab.containerEl.textContent).toContain('15 reasoning deltas');
      expect(tab.containerEl.textContent).toContain('kernel agreed: yes');
    } finally {
      fakeStream = null;
    }
  });

  it('does not claim the kernel agreed when the ended frame disagreed', async () => {
    setLocale('en');
    fakeStream = { status: 'streamed', textDeltas: 2, reasoningDeltas: 0, answer: 'OK', confirmed: false };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe the stream') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('streamed an answer live');
      // The answer still streamed, but the honesty rule keeps agreement a separate
      // claim: no matching ended frame means "no", never an assumed "yes".
      expect(tab.containerEl.textContent).toContain('kernel agreed: no');
      expect(tab.containerEl.textContent).not.toContain('kernel agreed: yes');
    } finally {
      fakeStream = null;
    }
  });

  it('separates an admitted-but-unstreamed turn from a streamed one', async () => {
    setLocale('en');
    fakeStream = { status: 'admitted', textDeltas: 0, reasoningDeltas: 0, answer: undefined, confirmed: false };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe the stream') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('event channel live, streaming not confirmed');
      expect(tab.containerEl.textContent).not.toContain('streamed an answer live');
      expect(tab.containerEl.textContent).not.toContain('Could not read the native event stream');
    } finally {
      fakeStream = null;
    }
  });

  it('names an unreadable native event stream as failed, not admitted or streamed', async () => {
    setLocale('en');
    fakeStream = { status: 'unavailable', textDeltas: 0, reasoningDeltas: 0, answer: undefined, confirmed: false };
    try {
      const tab = new CoOberSettingsTab(createPlugin({ refreshLocale: vi.fn() }, {
        availableModes: [{ id: 'build', name: 'Build' }],
      }));
      tab.display();
      (
        [...tab.containerEl.querySelectorAll('button')].find((b) => b.textContent === 'Probe the stream') as HTMLButtonElement
      ).click();
      await flushPromises();
      await flushPromises();

      expect(tab.containerEl.textContent).toContain('Could not read the native event stream');
      expect(tab.containerEl.textContent).not.toContain('event channel live');
      expect(tab.containerEl.textContent).not.toContain('streamed an answer live');
    } finally {
      fakeStream = null;
    }
  });

  it('fails the sync folder row for a shape the writer itself rejects (0.2.46 stage C)', async () => {
    // The row used to PASS on `length > 0`. A folder like `notes/..` or
    // `/abs` or `notes<>` produced a green light while every sync threw.
    // Now the row runs the same validator the sync path uses — buildSyncNote
    // in src/sync/templates.ts — so panel and engine can never disagree.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    plugin.settings.defaultNoteFolder = 'notes/..';
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('Fail: Default sync folder');
    expect(tab.containerEl.textContent).toContain('rejected by the writer');
    // The empty-string detail is for the not-typed case; a typed-but-invalid
    // folder must not wear it, or the reader is pointed at a textbox they
    // already filled.
    expect(tab.containerEl.textContent).not.toContain('Default sync folder is empty');
  });

  it('keeps the empty and invalid sync folder details distinct (0.2.46 stage C anti-remerge)', async () => {
    // The two failure classes carry different remedies: one says "type
    // something", the other says "what you typed cannot be a path". Merging
    // them re-taught the pre-fix collapse, so both sentences are asserted
    // here on their own row while the other is absent.
    setLocale('en');

    const empty = createPlugin({ refreshLocale: vi.fn() });
    empty.settings.defaultNoteFolder = '';
    const emptyTab = new CoOberSettingsTab(empty);
    emptyTab.display();
    (
      [...emptyTab.containerEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
    ).click();
    await flushPromises();
    await flushPromises();
    expect(emptyTab.containerEl.textContent).toContain('Default sync folder is empty');
    expect(emptyTab.containerEl.textContent).not.toContain('rejected by the writer');

    const invalid = createPlugin({ refreshLocale: vi.fn() });
    invalid.settings.defaultNoteFolder = '/abs/path';
    const invalidTab = new CoOberSettingsTab(invalid);
    invalidTab.display();
    (
      [...invalidTab.containerEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
    ).click();
    await flushPromises();
    await flushPromises();
    expect(invalidTab.containerEl.textContent).toContain('rejected by the writer');
    expect(invalidTab.containerEl.textContent).not.toContain('Default sync folder is empty');
  });

  it('still passes a legal non-empty sync folder shape (0.2.46 stage C must not trade one lie for another)', async () => {
    // A settled "the sync engine will accept this" green light is a real
    // observation. The fix must not turn every non-empty folder into a fail
    // just because some non-empty folders are invalid — the shape check runs
    // the engine's own validator, so a shape the validator accepts is the
    // shape the writer will actually use.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    plugin.settings.defaultNoteFolder = 'co-ober/sync';
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    (
      [...tab.containerEl.querySelectorAll('button')]
        .find((b) => b.textContent === 'Run Diagnostics') as HTMLButtonElement
    ).click();
    await flushPromises();
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('Pass: Default sync folder');
    expect(tab.containerEl.textContent).toContain('co-ober/sync');
  });

  it('does not report a runtime metadata reading it never asked for', async () => {
    // With no agent connected nothing hands over the runtime lists, yet the row
    // interpolated {modes}/{models}/{commands} from a minted {0,0,0} placeholder
    // and printed "0 agents, 0 models, 0 commands" — a settled measurement of a
    // question the panel never posed, sitting directly under the row that already
    // says the connection failed. It now names that the query did not run.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {}, false);
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    const text = tab.containerEl.textContent ?? '';
    expect(text).toContain('Runtime metadata');
    expect(text).toContain('Not queried');
    expect(text).not.toContain('0 agents, 0 models, 0 commands');
  });

  it('names a runtime metadata query that could not answer, not a zero count', async () => {
    // The 0.2.20 fix introduced `runtimeNotQueried` for the branch where no
    // client existed. The connected-then-rejected branch still folded each
    // `getAvailable*` rejection into `[]` via `.catch(() => [])` inside
    // `Promise.all`, so the diagnostics row interpolated {modes}/{models}/
    // {commands} out of those swallowed empties and printed "0 agents, 0
    // models, 0 commands" — the exact reading a working agent gives when it
    // truly has nothing. A stream that died mid-read is not a survey that
    // returned; it is a question that could not be answered, and the row
    // names it as one now.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const client = plugin.getClient()!;
    vi.mocked(client.getAvailableAgents).mockRejectedValue(new Error('stream died'));
    vi.mocked(client.getAvailableModels).mockRejectedValue(new Error('stream died'));
    vi.mocked(client.getAvailableCommands).mockRejectedValue(new Error('stream died'));
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const diagnosticsButton = [...tab.containerEl.querySelectorAll('button')]
      .find((button) => button.textContent === 'Run Diagnostics') as HTMLButtonElement | undefined;
    diagnosticsButton!.click();
    await flushPromises();
    await flushPromises();

    const text = tab.containerEl.textContent ?? '';
    expect(text).toContain('Runtime metadata');
    expect(text).toContain('Query failed — the runtime lists could not be read');
    expect(text).not.toContain('0 agents, 0 models, 0 commands');
    expect(text).not.toContain('Not queried');
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

  it('withdraws collected diagnostics on a language switch rather than freezing them mid-sentence', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {
      availableModes: [{ id: 'build', name: 'Build' }],
    });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    const runButton = () => [...tab.containerEl.querySelectorAll('button')]
      .find((button) => /Run Diagnostics|运行诊断/.test(button.textContent ?? '')) as HTMLButtonElement | undefined;
    runButton()!.click();
    await flushPromises();
    await flushPromises();

    // Collected in English: the row's label and detail are finished strings baked
    // from the locale collectDiagnostics ran in.
    expect(tab.containerEl.textContent).toContain('ACP connection');
    expect(tab.containerEl.textContent).toContain('Connected to OpenCode');

    const languageSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'zh')) as HTMLSelectElement | undefined;
    languageSelect!.value = 'zh';
    languageSelect!.dispatchEvent(new Event('change'));
    await flushPromises();

    // Re-rendering restamps the PASS/FAIL prefix in Chinese but can only echo the
    // cached English label/detail verbatim, so the old behavior left a Chinese
    // panel holding a "通过 ACP connection / Connected to OpenCode" row — one
    // reading frozen in a language the rest of the settings no longer spoke. The
    // rows are withdrawn to the honest not-yet-run state instead; the user
    // re-probes (in Chinese) by clicking again.
    expect(tab.containerEl.textContent).not.toContain('ACP connection');
    expect(tab.containerEl.textContent).not.toContain('Connected to OpenCode');
    expect(tab.containerEl.textContent).toContain('运行诊断');
    expect(runButton()).toBeDefined();
    setLocale('en');
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
    // A plain open has no completed survey and no fallback rows to show, so
    // the panel cannot honestly claim "these are all the runtime skills: none"
    // (0.2.42 stage C refused that wording for a rejected fetch; the same
    // refusal now covers a fetch never asked for). It says "unavailable", and
    // the reader can click Reconnect to survey.
    expect(tab.containerEl.textContent).toContain('Runtime skills unavailable');
    expect(tab.containerEl.textContent).not.toContain('No runtime skills loaded');
    await flushPromises();
    await flushPromises();

    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(plugin.getClient()?.createSession).not.toHaveBeenCalled();
    expect(plugin.getClient()?.closeSession).not.toHaveBeenCalled();
    expect(tab.containerEl.textContent).not.toContain('skill-writer');
  });

  it('does not certify an empty runtime list on an open that never asked for one', async () => {
    // Both sides of the never-surveyed reading: skills AND models, and both
    // the empty-label assertion (the lie) and the unavailable-label assertion
    // (the honest substitute). Test 511 covers the skills side; this one pins
    // the models side too, so a fix that widens one guard and forgets the
    // other is caught. The panel is not connected to any completed fetch at
    // this point, so "No models loaded" would be a badge the reader's click
    // never asked for.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();

    expect(tab.containerEl.textContent).toContain('Runtime models unavailable');
    expect(tab.containerEl.textContent).not.toContain('No models loaded');
    expect(tab.containerEl.textContent).toContain('Runtime skills unavailable');
    expect(tab.containerEl.textContent).not.toContain('No runtime skills loaded');
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
    expect(httpOption?.textContent).toBe(`http (${locale().settings.mcpHttpDisabled})`);
  });
});

describe('CoOberSettingsTab reconnect', () => {
  function reconnectButton(tab: CoOberSettingsTab): HTMLButtonElement {
    const button = [...tab.containerEl.querySelectorAll('button')]
      .find((el) => el.textContent === 'Reconnect') as HTMLButtonElement | undefined;
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  }

  it('puts the open panel back on the agent instead of swapping the client under it', async () => {
    setLocale('en');
    const reconnectAgent = vi.fn().mockResolvedValue(true);
    const plugin = createPlugin({ refreshLocale: vi.fn(), reconnectAgent });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    Notice.messages.length = 0;
    reconnectButton(tab).click();
    await flushPromises();
    await flushPromises();

    // initClient() by itself hands the plugin a new client while every open panel
    // is still bound to the old one, so the tab stayed dead afterwards — and its
    // parked queue, its lost sessions and its toolbar were never revisited. The
    // panel's own reconnect does all of that and says whether it got through.
    expect(reconnectAgent).toHaveBeenCalledTimes(1);
    expect(plugin.initClient).not.toHaveBeenCalled();
    expect(Notice.messages).toContain('Reconnected');
  });

  it('still connects when no panel is open to reconnect', async () => {
    setLocale('en');
    const reconnectAgent = vi.fn();
    const plugin = createPlugin({ refreshLocale: vi.fn(), reconnectAgent });
    plugin.app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    Notice.messages.length = 0;
    reconnectButton(tab).click();
    await flushPromises();
    await flushPromises();

    expect(reconnectAgent).not.toHaveBeenCalled();
    expect(plugin.initClient).toHaveBeenCalled();
    expect(Notice.messages).toContain('Reconnected');
  });

  it('says so when the panel could not reach the agent', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn(), reconnectAgent: vi.fn().mockResolvedValue(false) });
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    Notice.messages.length = 0;
    reconnectButton(tab).click();
    await flushPromises();
    await flushPromises();

    expect(Notice.messages).toContain('Failed to reconnect');
  });

  it('names a runtime fetch that could not be made, not an empty list', async () => {
    // A `getAvailableAgents/Models/Commands` that rejects used to leave the
    // loading flag false and `loaded` false with no other signal, so the next
    // render fell past "loading" and into "empty" — the same lie the native
    // list and native search were fixed for last release. A failed fetch is
    // now its own state, and reads as "unavailable", not "no models loaded".
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const client = plugin.getClient()!;
    vi.mocked(client.getAvailableAgents).mockRejectedValue(new Error('stream died'));
    vi.mocked(client.getAvailableModels).mockRejectedValue(new Error('stream died'));
    vi.mocked(client.getAvailableCommands).mockRejectedValue(new Error('stream died'));
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    reconnectButton(tab).click();
    await flushPromises();
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('Runtime skills unavailable');
    expect(tab.containerEl.textContent).toContain('Runtime models unavailable');
    expect(tab.containerEl.textContent).not.toContain('No runtime skills loaded');
    expect(tab.containerEl.textContent).not.toContain('No models loaded');
  });

  it('reads an empty fetch as empty, not as unavailable', async () => {
    // The two flags must stay distinct: a fetch that answered `[]` truly is an
    // empty reading; only a rejection or a never-connected client may raise
    // the unavailable line, or the fix would trade one lie for another.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() }, {}, {});
    const tab = new CoOberSettingsTab(plugin);

    tab.display();
    reconnectButton(tab).click();
    await flushPromises();
    await flushPromises();

    expect(tab.containerEl.textContent).toContain('No runtime skills loaded');
    expect(tab.containerEl.textContent).not.toContain('Runtime skills unavailable');
  });
});

function createPlugin(
  refreshedView: {
    refreshLocale: () => void;
    reloadToolbarOptions?: () => void;
    refreshPermissionMode?: () => void;
    reconnectAgent?: () => Promise<boolean>;
  },
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
  const plugin = {
    app: {
      workspace: {
        getLeavesOfType: vi.fn((viewType: string) => (
          viewType === VIEW_TYPE ? [{ view: refreshedView }] : []
        )),
      },
    },
    settings,
    savePluginData: vi.fn(async () => { (plugin as { lastSaveOk: boolean | null }).lastSaveOk = true; }),
    lastSaveOk: null as boolean | null,
    initClient: vi.fn().mockResolvedValue(initClientResult),
    getClient: vi.fn(() => client),
    client: null,
  } as unknown as CoOberPlugin;
  return plugin;
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

  function findDropdown(tab: CoOberSettingsTab, name: string): HTMLSelectElement {
    const select = [...tab.containerEl.querySelectorAll('select')]
      .find((el) => el.closest('.setting-item')?.textContent?.includes(name));
    expect(select).toBeDefined();
    return select as HTMLSelectElement;
  }

  async function changeDropdown(select: HTMLSelectElement, value: string): Promise<void> {
    select.value = value;
    select.dispatchEvent(new Event('change'));
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

  it('says "Setting saved" only when the write actually landed (0.2.47 stage A)', async () => {
    // `savePluginData` swallows the disk failure into a sticky alarm and
    // resolves identically either way — the Notice path used to fire on every
    // resolve and certify a write that had not happened. A reader with an
    // unreadable data.json was told "Setting saved", closed the panel, and
    // reloaded to find the old value in place.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    // Simulate a swallowed failure: savePluginData resolves but the ok fact
    // it publishes says the write did not land.
    vi.mocked(plugin.savePluginData).mockImplementation(async () => { plugin.lastSaveOk = false; });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    Notice.messages.length = 0;

    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '4096');

    expect(plugin.settings.maxNoteSize).toBe(4096);
    expect(Notice.messages).not.toContain('Setting saved');
  });

  it('still says "Setting saved" on a save that reached the disk (0.2.47 stage A)', async () => {
    // The fix must not trade one lie for another by refusing to confirm a real
    // success. The default mock sets lastSaveOk = true, mirroring what the
    // plugin actually does on a write that landed.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    Notice.messages.length = 0;

    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '4096');

    expect(Notice.messages).toContain('Setting saved');
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

  it('describes the command timeout as a wait it does not enforce with a kill', () => {
    // The deadline bounds how long Co-Ober waits for a command to report an
    // exit; terminalManager's waitForExit timer only rejects the WAIT and never
    // touches the process, so the old wording ("before a command is terminated")
    // promised the reader that a slow command would be stopped at 30s when in
    // fact it keeps running on the machine and only the observation gave up.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    const timeoutItem = [...tab.containerEl.querySelectorAll('.setting-item')]
      .find((el) => el.textContent?.includes('Command Timeout (ms)'));
    const desc = timeoutItem?.querySelector('.setting-item-description')?.textContent ?? '';
    expect(desc.toLowerCase()).toContain('wait');
    // Not the old claim that a command is terminated at the deadline.
    expect(desc.toLowerCase()).not.toContain('terminat');
    expect(desc.toLowerCase()).not.toContain('killed');
    // And it says plainly the command survives the deadline.
    expect(desc.toLowerCase()).toContain('keeps running');
  });

  it('keeps a tier-forbidden capability closed when its dropdown is moved', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.permissionMode = 'readonly';
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const client = plugin.getClient()!;
    vi.mocked(client.setFsCapabilityMode).mockClear();
    vi.mocked(client.setTerminalCapabilityMode).mockClear();

    // Under the readonly tier, the *stored* preference is still remembered, but
    // the live client is pushed through the tier — so choosing read & write here
    // must not hand the agent a write surface the permission mode exists to shut.
    await changeDropdown(findDropdown(tab, 'FS Capability Mode'), 'enabled');
    expect(plugin.settings.fsCapability).toBe('enabled');
    expect(client.setFsCapabilityMode).toHaveBeenCalledWith('readonly', plugin.settings.maxNoteSize);
    expect(client.setTerminalCapabilityMode).toHaveBeenCalledWith('disabled');

    await changeDropdown(findDropdown(tab, 'Terminal Capability Mode'), 'enabled');
    expect(plugin.settings.terminalCapability).toBe('enabled');
    expect(client.setTerminalCapabilityMode).toHaveBeenLastCalledWith('disabled');
  });

  it('reprojects the tier onto the open chat view when the permission mode moves', async () => {
    setLocale('en');
    const refreshPermissionMode = vi.fn();
    const plugin = createPlugin({ refreshLocale: vi.fn(), refreshPermissionMode });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const client = plugin.getClient()!;

    await changeDropdown(findDropdown(tab, 'Permission Mode'), 'readonly');

    expect(plugin.settings.permissionMode).toBe('readonly');
    expect(client.permissionMode).toBe('readonly');
    // The chat bar has its own permission selector and only re-reads the setting
    // when a tab comes forward, so it kept naming the tier that no longer holds.
    expect(refreshPermissionMode).toHaveBeenCalledTimes(1);
  });

  it('names what the Safe tier actually confirms rather than promising every action', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    // Safe defers to the capability settings, which default to enabled, so an
    // allowed client-side write or command runs with no banner and is only
    // recorded in the transcript. "confirm all" promised the one thing the tier
    // does not do — it confirms the permission prompts the agent sends, not the
    // capability grants it never sees before honouring them.
    const safeOption = [...findDropdown(tab, 'Permission Mode').options]
      .find((option) => option.value === 'safe');
    expect(safeOption?.textContent).toContain('permission prompt');
    expect(safeOption?.textContent).toContain('recorded');
    expect(safeOption?.textContent).not.toMatch(/confirm all/i);
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

  it('refuses a value that is not exactly a whole number rather than repairing it', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const before = plugin.settings.maxNoteSize;
    Notice.messages.length = 0;

    // parseInt turned both of these into a stored integer while the field kept
    // showing the rejected text: 4096.5 floored to 4096, 4096abc truncated to
    // 4096. The hint says whole number, so neither may be accepted.
    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '4096.5');
    expect(plugin.settings.maxNoteSize).toBe(before);
    await changeInput(findTextSettingInput(tab, 'Max Note Reference Size'), '4096abc');
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

  it('stores the tab cap and re-renders the open tab strips', async () => {
    setLocale('en');
    const view = { refreshLocale: vi.fn(), refreshTabBar: vi.fn() };
    const plugin = createPlugin(view);
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    await changeInput(findTextSettingInput(tab, 'Max Open Tabs'), '4');

    expect(plugin.settings.maxOpenTabs).toBe(4);
    expect(plugin.savePluginData).toHaveBeenCalled();
    expect(view.refreshTabBar).toHaveBeenCalled();
  });

  it('keeps a tab cap inside 2-12', async () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const before = plugin.settings.maxOpenTabs;
    Notice.messages.length = 0;

    await changeInput(findTextSettingInput(tab, 'Max Open Tabs'), '99');

    expect(plugin.settings.maxOpenTabs).toBe(before);
    expect(Notice.messages).toContain(
      locale().settings.invalidNumber.replace('{min}', '2').replace('{max}', '12'),
    );
  });

  it('springs a rejected number back in the box, not only in the stored value', async () => {
    // parseBoundedInt refuses the edit and the setting keeps its old number, but
    // the field used to keep showing the rejected text — so the box displayed a
    // limit the settings no longer stood behind. The rejected text has to leave
    // the field, not just the save.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const before = plugin.settings.maxNoteSize;
    const input = findTextSettingInput(tab, 'Max Note Reference Size');
    Notice.messages.length = 0;

    await changeInput(input, '999999999');

    expect(plugin.settings.maxNoteSize).toBe(before);
    expect(input.value).toBe(String(before));
  });

  it('springs a rejected OpenCode path back to the path still in effect', async () => {
    // validateOpencodePath warns and stores nothing, but the box kept the refused
    // text, naming an executable the plugin will not launch. Show the value the
    // settings actually hold once the edit is turned down.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.opencodePath = 'opencode';
    const tab = new CoOberSettingsTab(plugin);
    tab.display();
    const input = findTextSettingInput(tab, 'OpenCode CLI Path');
    expect(input.value).toBe('opencode');
    vi.mocked(plugin.savePluginData).mockClear();
    Notice.messages.length = 0;

    await changeInput(input, '/definitely/not/here/opencode-0000');

    expect(plugin.settings.opencodePath).toBe('opencode');
    expect(input.value).toBe('opencode');
    expect(plugin.savePluginData).not.toHaveBeenCalled();
  });
});

describe('CoOberSettingsTab agent list (0.2.5 stage 3 / 0.2.49 stage C)', () => {
  it('lists only what the survey returned, plus the stored default and the none sentinel', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    // "docs" was listed at 0.2.5 stage 3 although no code path ever sent
    // it, so a reader who picked it got a default session and no
    // explanation — the curated roster was the earlier refusal. 0.2.49
    // stage C refused the roster itself: on an un-surveyed panel, the
    // dropdown certified 'build' and 'plan' as agents the client "can
    // actually start" without ever asking the runtime. The only entries
    // now are the none sentinel, the persisted default from
    // DEFAULT_SETTINGS ('build'), and whatever the survey returns.
    const agentSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((select) => [...select.options].some((option) => option.value === 'build')) as HTMLSelectElement | undefined;
    expect(agentSelect).toBeDefined();
    expect([...agentSelect!.options].map((option) => option.value)).toEqual(['', 'build']);
  });
});

describe('CoOberSettingsTab active custom agent (0.2.13 stage 2)', () => {
  it('names only an agent whose prompt would actually be attached', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.customAgents = [
      { id: 'good-agent', name: 'Researcher', description: '', instructions: 'read first', skillIds: [], enabled: true },
      { id: 'blank-agent', name: 'Blank', description: '', instructions: '   ', skillIds: [], enabled: true },
      { id: 'stray-agent', name: 'Stray', description: '', instructions: 'ok', skillIds: ['nope'], enabled: true },
      { id: 'off-agent', name: 'Off', description: '', instructions: 'ok', skillIds: [], enabled: false },
    ];
    plugin.settings.activeCustomAgentId = 'blank-agent';
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    // The send path drops an agent that fails validation without a word, so
    // listing one here promised a tier no prompt would ever carry.
    const select = [...tab.containerEl.querySelectorAll('select')]
      .find((el) => [...el.options].some((option) => option.value === 'good-agent')) as HTMLSelectElement | undefined;
    expect(select).toBeDefined();
    expect([...select!.options].map((option) => option.value)).toEqual(['', 'good-agent']);
    // The stored pick is one the plugin will not attach, so the row reads None.
    expect(select!.value).toBe('');
  });
});

describe('CoOberSettingsTab permission dropdown refresh (0.2.45 stage C)', () => {
  it('pushes a tier written elsewhere into the rendered dropdown', () => {
    // The dropdown is `.setValue`d once inside `display()` and only re-enters
    // on a fresh render. A chat-view bar click writes `settings.permissionMode`
    // without re-displaying the tab, so without `refreshPermissionDropdown`
    // the panel keeps certifying the tier it opened on while requests flow
    // under the new one. The bar's `onPermissionChange` reaches through the
    // plugin-held tab reference to push the value; this test is that push's
    // settings-side boundary — the dropdown component actually moves.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.permissionMode = 'safe';
    const tab = new CoOberSettingsTab(plugin);
    tab.display();

    const permSelect = [...tab.containerEl.querySelectorAll('select')]
      .find((el) => [...el.options].some((option) => option.value === 'readonly')) as HTMLSelectElement | undefined;
    expect(permSelect).toBeDefined();
    expect(permSelect!.value).toBe('safe');

    // A bar click has already written settings; the dropdown does not know it.
    plugin.settings.permissionMode = 'readonly';
    tab.refreshPermissionDropdown();

    expect(permSelect!.value).toBe('readonly');
  });

  it('is a no-op before display(), so a plugin with unopened settings survives the push', () => {
    // The tab instance exists from onload onward, but the dropdown field is
    // bound only when `render()` runs. A chat view constructed before the
    // reader ever opened Settings must be able to fan its tier out without
    // building a panel the reader did not ask for — and without throwing.
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    const tab = new CoOberSettingsTab(plugin);
    // No tab.display() — the dropdown reference has never been assigned.
    expect(() => tab.refreshPermissionDropdown()).not.toThrow();
  });
});

describe('CoOberSettingsTab default-agent options name only a surveyed roster (0.2.49 stage C)', () => {
  // `buildAgentOptions` used to fill `['build','plan']` whenever the runtime
  // list came back empty. On a Settings panel opened before any connection
  // — no client, no survey, no evidence — the dropdown certified two
  // agents as selectable that nothing had ever reported. Same class
  // 0.2.42 stage C refused on `Loaded Skills`/`Common Models` ("a survey
  // that was never taken may not sign off on contents") and 0.2.45 stage
  // B refused on the toolbar's model chip. The stored-default fallthrough
  // stays so a persisted choice remains visible under an absent survey;
  // only the fabricated roster is gone.
  function buildOptions(
    tab: CoOberSettingsTab,
    agents: Array<{ id: string; name: string }>,
  ): Record<string, string> {
    return (tab as unknown as {
      buildAgentOptions: (a: Array<{ id: string; name: string }>) => Record<string, string>;
    }).buildAgentOptions(agents);
  }

  it('does not offer build/plan on an unsurveyed empty roster', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.defaultAgent = '';
    const tab = new CoOberSettingsTab(plugin);

    const options = buildOptions(tab, []);

    expect(options.build).toBeUndefined();
    expect(options.plan).toBeUndefined();
    // The only entry is the "none" sentinel — a reader with no surveyed
    // roster sees nothing selectable, not a fabricated pair.
    expect(Object.keys(options)).toEqual(['']);
  });

  it('keeps a stored default visible when the runtime never listed it', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.defaultAgent = 'legacy-agent';
    const tab = new CoOberSettingsTab(plugin);

    const options = buildOptions(tab, []);

    // The persisted value still reaches the dropdown so the reader can see
    // what the settings file holds; but it comes with its own id, not a
    // fabricated alternative, and the roster above it stays honest.
    expect(options['legacy-agent']).toBe('legacy-agent');
    expect(options.build).toBeUndefined();
    expect(options.plan).toBeUndefined();
  });

  it('lists exactly what the survey returned alongside the none sentinel', () => {
    setLocale('en');
    const plugin = createPlugin({ refreshLocale: vi.fn() });
    plugin.settings.defaultAgent = '';
    const tab = new CoOberSettingsTab(plugin);

    const options = buildOptions(tab, [{ id: 'docs', name: 'Docs' }, { id: 'code', name: 'Code' }]);

    expect(options).toEqual({ '': '—', docs: 'Docs', code: 'Code' });
  });
});
