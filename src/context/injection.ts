/** Build context injection text from resolved notes */
export class ContextInjection {
  private static readonly IDENTITY =
    'You are Copsidian, an AI assistant living inside Obsidian. ' +
    'You are built on top of the OpenCode agent, but your purpose and identity are your own: ' +
    'you help users think, write, and navigate their personal knowledge base. ' +
    'You have opinions, curiosity, and a genuine interest in the user\'s notes and ideas. ' +
    'When asked who you are, speak naturally as Copsidian — not as OpenCode, not as a generic AI.';

  static build(resolved: Array<{ name: string; content: string }>): string {
    if (resolved.length === 0) return '';
    const blocks = resolved.map(
      (r) => `=== NOTE: [[${r.name}]] ===\n${r.content}\n=== END NOTE ===`,
    );
    return (
      'The user has referenced the following Obsidian notes in their message.\n' +
      'You should consider their content as relevant context for your response:\n\n' +
      blocks.join('\n\n')
    );
  }

  static systemPrompt(instructions: string, customAgentPrompt = ''): string {
    const parts = [ContextInjection.IDENTITY];
    if (instructions.trim()) parts.push(instructions.trim());
    if (customAgentPrompt.trim()) parts.push(customAgentPrompt.trim());
    return parts.join('\n\n');
  }

  static injectWikilinks(text: string, vault: { getAbstractFileByPath: (path: string) => unknown }): string {
    return text.replace(/`([^`]+)`/g, (match, code) => {
      if (!code.includes('/') && !code.includes('\\')) return match;
      const abstract = vault.getAbstractFileByPath(code);
      if (abstract) {
        const basename = (abstract as { basename?: string }).basename ?? code;
        return `[[${code}|${basename}]]`;
      }
      return match;
    });
  }
}
