// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { addCustomAgentBlock, addCustomSkillBlock, addMcpServerBlock, addSyncRuleBlock, nextRuleId } from './settingBlocks';
import { t } from '../i18n';
import type { CoOberSettings, CustomAgentDefinition, CustomSkillDefinition, McpServerConfig, SyncRule } from '../types';

installObsidianDomHelpers();

function render(caps: Parameters<typeof addMcpServerBlock>[5]): { http: HTMLOptionElement; sse: HTMLOptionElement } {
  const server = {
    type: 'stdio',
    id: 's1',
    enabled: true,
    name: 'demo',
    command: 'npx',
    args: [],
    env: [],
  } as McpServerConfig;
  const settings = { mcpServers: [server] } as unknown as CoOberSettings;
  const container = document.createElement('div');
  addMcpServerBlock(container, server, settings, vi.fn(async () => {}), vi.fn(), caps);
  const http = container.querySelector<HTMLOptionElement>('option[value="http"]');
  const sse = container.querySelector<HTMLOptionElement>('option[value="sse"]');
  if (!http || !sse) throw new Error('transport options did not render');
  return { http, sse };
}

describe('MCP transport gating reads an affirmed capability, not its absence (0.2.7 stage 2)', () => {
  it('keeps http/sse selectable only when the agent affirmed them', () => {
    const { http, sse } = render({ http: true, sse: true });
    expect(http.disabled).toBe(false);
    expect(sse.disabled).toBe(false);
  });

  it('disables a transport the agent did not affirm', () => {
    // An omitted flag used to fall through to "enabled", so the reader offered
    // a server type the agent would then reject on connect.
    const { http, sse } = render({});
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });

  it('disables a transport the agent explicitly answered false', () => {
    const { http, sse } = render({ http: false, sse: false });
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });

  it('disables both when the agent reported no transport capability at all', () => {
    const { http, sse } = render(undefined);
    expect(http.disabled).toBe(true);
    expect(sse.disabled).toBe(true);
  });
});

describe('nextRuleId avoids an id already in use (0.2.7 stage 3)', () => {
  it('returns the bare timestamp when nothing collides', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      expect(nextRuleId([])).toBe('1700000000000');
    } finally {
      vi.useRealTimers();
    }
  });

  it('suffixes past a collision instead of handing out a duplicate id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      // Two adds in the same millisecond used to collide and overwrite.
      const taken = [{ id: '1700000000000' }, { id: '1700000000000-1' }];
      expect(nextRuleId(taken)).toBe('1700000000000-2');
    } finally {
      vi.useRealTimers();
    }
  });
});

// The block header names the agent/skill, but the id and name edits write the
// new value straight into the definition and the save without ever repainting
// the <strong> — so a reader who renamed a row kept looking at the old title
// under the fields they had just changed. These tests drive the real text
// inputs and assert the header follows them.
function textFields(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input')).filter((el) => el.type !== 'checkbox');
}

function header(container: HTMLElement): HTMLElement {
  const el = container.querySelector('strong');
  if (!el) throw new Error('block header did not render');
  return el as HTMLElement;
}

async function edit(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('custom agent header tracks the name and id edits (0.2.35 stage 3)', () => {
  function makeAgent(): CustomAgentDefinition {
    return { id: 'agent-1', enabled: false, name: '', description: '', instructions: '', skillIds: [] };
  }

  it('renames the header when the name field changes', async () => {
    const agent = makeAgent();
    const container = document.createElement('div');
    addCustomAgentBlock(container, agent, { customAgents: [agent] } as unknown as CoOberSettings, vi.fn(async () => {}), vi.fn(), () => true);
    expect(header(container).textContent).toBe(t().settings.customAgents.label.replace('{name}', 'agent-1'));
    await edit(textFields(container)[1], 'Reviewer');
    expect(header(container).textContent).toBe(t().settings.customAgents.label.replace('{name}', 'Reviewer'));
  });

  it('renames the header after a successful id edit', async () => {
    const agent = makeAgent();
    const container = document.createElement('div');
    addCustomAgentBlock(container, agent, { customAgents: [agent] } as unknown as CoOberSettings, vi.fn(async () => {}), vi.fn(), (cur, next) => {
      agent.id = next;
      return cur === 'agent-1';
    });
    await edit(textFields(container)[0], 'agent-2');
    expect(header(container).textContent).toBe(t().settings.customAgents.label.replace('{name}', 'agent-2'));
  });

  it('keeps the header on a rejected id edit', async () => {
    const agent = makeAgent();
    const container = document.createElement('div');
    addCustomAgentBlock(container, agent, { customAgents: [agent] } as unknown as CoOberSettings, vi.fn(async () => {}), vi.fn(), () => false);
    await edit(textFields(container)[0], 'taken');
    expect(header(container).textContent).toBe(t().settings.customAgents.label.replace('{name}', 'agent-1'));
  });
});

describe('custom skill header tracks the name and id edits (0.2.35 stage 3)', () => {
  function makeSkill(): CustomSkillDefinition {
    return { id: 'skill-1', enabled: false, name: '', description: '', instructions: '' };
  }

  it('renames the header when the name field changes', async () => {
    const skill = makeSkill();
    const container = document.createElement('div');
    addCustomSkillBlock(container, skill, { customSkills: [skill] } as unknown as CoOberSettings, vi.fn(async () => {}), vi.fn(), () => true);
    expect(header(container).textContent).toBe(t().settings.customSkills.label.replace('{name}', 'skill-1'));
    await edit(textFields(container)[1], 'Outline');
    expect(header(container).textContent).toBe(t().settings.customSkills.label.replace('{name}', 'Outline'));
  });

  it('renames the header after a successful id edit', async () => {
    const skill = makeSkill();
    const container = document.createElement('div');
    addCustomSkillBlock(container, skill, { customSkills: [skill] } as unknown as CoOberSettings, vi.fn(async () => {}), vi.fn(), (cur, next) => {
      skill.id = next;
      return cur === 'skill-1';
    });
    await edit(textFields(container)[0], 'skill-2');
    expect(header(container).textContent).toBe(t().settings.customSkills.label.replace('{name}', 'skill-2'));
  });
});

// Renaming a skill rewrites every agent's `skillIds`, but the sibling agent rows
// only repaint on their own edits — so the box that displayed the old id kept
// showing a reference the settings no longer held. These tests co-render an
// agent and a skill in one container and drive the skill's id field.
describe('renaming a skill repaints the agents that reference it (0.2.40 stage 1)', () => {
  function makeSkill(id: string): CustomSkillDefinition {
    return { id, enabled: false, name: '', description: '', instructions: '' };
  }
  function makeAgent(skillIds: string[]): CustomAgentDefinition {
    return { id: 'agent-1', enabled: false, name: '', description: '', instructions: '', skillIds };
  }

  function mount(skill: CustomSkillDefinition, agent: CustomAgentDefinition, rename: (cur: string, next: string) => boolean): { container: HTMLElement; render: () => void } {
    const settings = { customSkills: [skill], customAgents: [agent] } as unknown as CoOberSettings;
    const container = document.createElement('div');
    const save = vi.fn(async () => {});
    const render = (): void => {
      while (container.firstChild) container.removeChild(container.firstChild);
      addCustomAgentBlock(container, agent, settings, save, render, rename);
      addCustomSkillBlock(container, skill, settings, save, render, rename);
    };
    render();
    return { container, render };
  }

  it('follows the rename into a sibling agent Skill IDs box', async () => {
    const skill = makeSkill('skill-1');
    const agent = makeAgent(['skill-1']);
    const rename = (cur: string, next: string): boolean => {
      if (cur !== 'skill-1' || next !== 'skill-2') return false;
      skill.id = next;
      agent.skillIds = agent.skillIds.map((id) => (id === cur ? next : id));
      return true;
    };
    const { container } = mount(skill, agent, rename);
    // Agent block inputs: id(0) name(1) description(2) skillIds(3); skill id(4).
    expect(textFields(container)[3].value).toBe('skill-1');

    await edit(textFields(container)[4], 'skill-2');

    const after = textFields(container);
    expect(after[3].value).toBe('skill-2');
    expect(after[4].value).toBe('skill-2');
  });

  it('leaves the sibling box untouched when the rename is rejected', async () => {
    const skill = makeSkill('skill-1');
    const agent = makeAgent(['skill-1']);
    const { container } = mount(skill, agent, () => false);
    await edit(textFields(container)[4], 'taken');
    expect(textFields(container)[3].value).toBe('skill-1');
  });
});

describe('MCP server header tracks the name edit (0.2.39 stage 2)', () => {
  function mcpServer(name: string): McpServerConfig {
    return { type: 'stdio', id: 's1', enabled: true, name, command: 'npx', args: [], env: [] } as McpServerConfig;
  }

  it('renames the header when the name field changes', async () => {
    const server = mcpServer('demo');
    const settings = { mcpServers: [server] } as unknown as CoOberSettings;
    const container = document.createElement('div');
    addMcpServerBlock(container, server, settings, vi.fn(async () => {}), vi.fn(), { http: false, sse: false });
    expect(header(container).textContent).toBe(t().settings.mcp.label.replace('{name}', 'demo'));
    // The row only repaints on a type change or delete; a name keystroke saved the
    // new value into the config but left the bold header naming the old server.
    await edit(textFields(container)[0], 'search');
    expect(header(container).textContent).toBe(t().settings.mcp.label.replace('{name}', 'search'));
  });

  it('names an unnamed server in the header the moment it is given one', async () => {
    const server = mcpServer('');
    const settings = { mcpServers: [server] } as unknown as CoOberSettings;
    const container = document.createElement('div');
    addMcpServerBlock(container, server, settings, vi.fn(async () => {}), vi.fn(), { http: false, sse: false });
    expect(header(container).textContent).toBe(t().settings.mcp.label.replace('{name}', t().settings.mcp.unnamed));
    await edit(textFields(container)[0], 'weather');
    expect(header(container).textContent).toBe(t().settings.mcp.label.replace('{name}', 'weather'));
  });
});

describe('sync rule header tracks the tool change (0.2.39 stage 2)', () => {
  it('renames the header when the rule tool changes', async () => {
    const rule = { id: 'r1', toolName: 'read', folder: '', filenameTemplate: '' } as unknown as SyncRule;
    const settings = { syncRules: [rule] } as unknown as CoOberSettings;
    const container = document.createElement('div');
    addSyncRuleBlock(container, rule, settings, vi.fn(async () => {}), vi.fn());
    expect(header(container).textContent).toBe(t().settings.sync.label.replace('{tool}', 'read'));
    const select = container.querySelector('select');
    if (!select) throw new Error('tool dropdown did not render');
    select.value = 'write';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(header(container).textContent).toBe(t().settings.sync.label.replace('{tool}', 'write'));
  });
});
