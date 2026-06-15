/**
 * Template expansion for file-based slash commands.
 *
 * Replaces placeholders in command templates with user-supplied arguments
 * before dispatching to the ACP agent.
 *
 * Supported placeholders:
 * - `$ARGUMENTS` — full argument string
 * - `$1` … `$9` — positional arguments (split on whitespace)
 */
export class TemplateExpander {
  /**
   * Expand a template with the given argument string.
   *
   * ```ts
   * expand("Review: $ARGUMENTS", "file1.ts file2.ts")
   * // → "Review: file1.ts file2.ts"
   *
   * expand("Diff $1 with $2", "main.js feature.js")
   * // → "Diff main.js with feature.js"
   * ```
   */
  expand(template: string, args: string): string {
    if (!template) return args;

    const parts = args.split(/\s+/);

    let result = template;
    // $ARGUMENTS — full arg string
    result = result.replace(/\$ARGUMENTS/g, args);
    // $1 … $9 — positional
    result = result.replace(/\$(\d)/g, (_, idx) => {
      const n = parseInt(idx as string, 10);
      return n >= 1 && n <= parts.length ? parts[n - 1] : '';
    });

    return result;
  }

  /**
   * Build the final prompt text for a file command.
   *
   * When the command has a template, expand it and return.
   * Otherwise, return `/<name> <args>` to let the ACP agent
   * handle it natively.
   */
  buildPrompt(def: { trigger: string; template?: string }, args: string): string {
    if (def.template) {
      return this.expand(def.template, args);
    }
    // Fall through to raw slash command
    return `/${def.trigger}${args ? ' ' + args : ''}`;
  }
}

/** Singleton */
export const templateExpander = new TemplateExpander();
