/** Build context injection text from resolved notes */
export class ContextInjection {
  /** Format resolved notes into a structured injection block */
  static build(resolved: Array<{ name: string; content: string }>): string {
    if (resolved.length === 0) return '';
    const blocks = resolved.map(
      (r) =>
        `=== NOTE: [[${r.name}]] ===\n${r.content}\n=== END NOTE ===`,
    );
    return (
      'The user has referenced the following Obsidian notes in their message.\n' +
      'You should consider their content as relevant context for your response:\n\n' +
      blocks.join('\n\n')
    );
  }

  /** Build a system-level injection that the agent always sees */
  static systemPrompt(instructions: string): string {
    if (!instructions.trim()) return '';
    return `You are an AI agent embedded in Obsidian. ${instructions}`;
  }

  /** Build markdown links from file paths found in text */
  static injectWikilinks(text: string, vault: { getAbstractFileByPath: (path: string) => unknown }): string {
    // Replace absolute-style file paths with wikilinks where possible
    return text.replace(/`([^`]+)`/g, (match, code) => {
      // Check if code looks like a file path
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
