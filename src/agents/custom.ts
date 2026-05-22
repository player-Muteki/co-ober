import type { CustomAgentDefinition, CustomSkillDefinition } from '../types';

export function validateCustomSkill(skill: CustomSkillDefinition): string[] {
  const errors: string[] = [];
  if (!skill.id.trim()) errors.push('Skill id is required');
  if (!skill.name.trim()) errors.push('Skill name is required');
  if (!skill.instructions.trim()) errors.push('Skill instructions are required');
  return errors;
}

export function validateCustomAgent(agent: CustomAgentDefinition, skills: CustomSkillDefinition[]): string[] {
  const errors: string[] = [];
  if (!agent.id.trim()) errors.push('Agent id is required');
  if (!agent.name.trim()) errors.push('Agent name is required');
  if (!agent.instructions.trim()) errors.push('Agent instructions are required');

  const knownSkillIds = new Set(skills.map((skill) => skill.id));
  const seenSkillIds = new Set<string>();
  for (const skillId of agent.skillIds) {
    if (seenSkillIds.has(skillId)) errors.push(`Duplicate skill reference: ${skillId}`);
    seenSkillIds.add(skillId);
    if (!knownSkillIds.has(skillId)) errors.push(`Unknown skill reference: ${skillId}`);
  }

  for (const skill of skills.filter((item) => agent.skillIds.includes(item.id))) {
    errors.push(...validateCustomSkill(skill).map((error) => `Invalid skill ${skill.id}: ${error}`));
  }

  return errors;
}

export function getActiveCustomAgent(
  activeId: string | undefined,
  agents: CustomAgentDefinition[],
): CustomAgentDefinition | null {
  if (!activeId) return null;
  return agents.find((agent) => agent.id === activeId && agent.enabled) ?? null;
}

export function getValidActiveCustomAgent(
  activeId: string | undefined,
  agents: CustomAgentDefinition[],
  skills: CustomSkillDefinition[],
): CustomAgentDefinition | null {
  const agent = getActiveCustomAgent(activeId, agents);
  if (!agent) return null;
  return validateCustomAgent(agent, skills).length === 0 ? agent : null;
}

export function buildCustomAgentPrompt(
  agent: CustomAgentDefinition | null,
  skills: CustomSkillDefinition[],
): string {
  if (!agent) return '';

  const parts = [
    `Custom agent: ${agent.name}`,
    agent.description.trim() ? `Description: ${agent.description.trim()}` : '',
    `Instructions:\n${agent.instructions.trim()}`,
  ].filter(Boolean);

  const enabledSkills = agent.skillIds
    .map((id) => skills.find((skill) => skill.id === id && skill.enabled))
    .filter((skill): skill is CustomSkillDefinition => Boolean(skill));

  if (enabledSkills.length > 0) {
    parts.push(
      'Enabled skills:\n\n' + enabledSkills.map((skill) => [
        `Skill: ${skill.name}`,
        skill.description.trim() ? `Description: ${skill.description.trim()}` : '',
        `Instructions:\n${skill.instructions.trim()}`,
      ].filter(Boolean).join('\n')).join('\n\n'),
    );
  }

  return parts.join('\n');
}
