import { describe, expect, it } from 'vitest';
import type { CustomAgentDefinition, CustomSkillDefinition } from '../types';
import { buildCustomAgentPrompt, getActiveCustomAgent, getValidActiveCustomAgent, validateCustomAgent, validateCustomSkill } from './custom';

describe('custom agent and skill helpers', () => {
  const skills: CustomSkillDefinition[] = [
    { id: 'writer', name: 'Writer', description: 'Writing help', instructions: 'Write clearly.', enabled: true },
    { id: 'disabled', name: 'Disabled', description: '', instructions: 'Ignore me.', enabled: false },
  ];

  it('validates required custom agent fields and duplicate skill references', () => {
    const agent: CustomAgentDefinition = {
      id: 'planner',
      name: 'Planner',
      description: 'Planning agent',
      instructions: 'Plan before answering.',
      enabled: true,
      skillIds: ['writer', 'writer', 'missing'],
    };

    expect(validateCustomAgent(agent, skills)).toEqual([
      'Duplicate skill reference: writer',
      'Unknown skill reference: missing',
    ]);
    expect(validateCustomAgent({ ...agent, id: '', name: '', instructions: '' }, skills)).toContain('Agent id is required');
  });

  it('validates required custom skill fields', () => {
    expect(validateCustomSkill({ id: '', name: '', description: '', instructions: '', enabled: true })).toEqual([
      'Skill id is required',
      'Skill name is required',
      'Skill instructions are required',
    ]);
  });

  it('resolves only enabled active agents', () => {
    const agents: CustomAgentDefinition[] = [
      { id: 'planner', name: 'Planner', description: '', instructions: 'Plan.', enabled: true, skillIds: [] },
      { id: 'off', name: 'Off', description: '', instructions: 'Off.', enabled: false, skillIds: [] },
    ];

    expect(getActiveCustomAgent('planner', agents)?.name).toBe('Planner');
    expect(getActiveCustomAgent('off', agents)).toBeNull();
    expect(getActiveCustomAgent('missing', agents)).toBeNull();
    expect(getActiveCustomAgent('', agents)).toBeNull();
  });

  it('falls back when active agent or referenced skills are invalid', () => {
    const agents: CustomAgentDefinition[] = [
      { id: 'blank', name: 'Blank', description: '', instructions: '', enabled: true, skillIds: [] },
      { id: 'missing-skill', name: 'Missing Skill', description: '', instructions: 'Use skill.', enabled: true, skillIds: ['missing'] },
      { id: 'bad-skill', name: 'Bad Skill', description: '', instructions: 'Use skill.', enabled: true, skillIds: ['empty'] },
      { id: 'valid', name: 'Valid', description: '', instructions: 'Answer well.', enabled: true, skillIds: ['writer'] },
    ];
    const localSkills: CustomSkillDefinition[] = [
      ...skills,
      { id: 'empty', name: 'Empty', description: '', instructions: '', enabled: true },
    ];

    expect(getValidActiveCustomAgent('blank', agents, localSkills)).toBeNull();
    expect(getValidActiveCustomAgent('missing-skill', agents, localSkills)).toBeNull();
    expect(getValidActiveCustomAgent('bad-skill', agents, localSkills)).toBeNull();
    expect(getValidActiveCustomAgent('valid', agents, localSkills)?.id).toBe('valid');
  });

  it('builds prompt text with enabled referenced skills only', () => {
    const agent: CustomAgentDefinition = {
      id: 'planner',
      name: 'Planner',
      description: 'Structured planning',
      instructions: 'Plan before answering.',
      enabled: true,
      skillIds: ['writer', 'disabled', 'missing'],
    };

    expect(buildCustomAgentPrompt(agent, skills)).toBe(
      'Custom agent: Planner\nDescription: Structured planning\nInstructions:\nPlan before answering.\nEnabled skills:\n\nSkill: Writer\nDescription: Writing help\nInstructions:\nWrite clearly.',
    );
  });
});
