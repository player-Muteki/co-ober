export interface SyncRule {
  id: string;
  enabled: boolean;
  toolName: string;       // 'edit' | 'write' | 'bash' | '*'
  pathPattern?: string;   // glob pattern (optional)
  folder: string;         // vault folder to write to
  filenameTemplate: string;
  template?: string;      // markdown template (optional, uses default)
}

export interface SyncContext {
  toolCallId: string;
  toolName: string;
  toolStatus: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: string;
}

/** Check if a sync rule matches a tool call */
export function ruleMatches(rule: SyncRule, ctx: SyncContext): boolean {
  if (!rule.enabled) return false;
  if (rule.toolName !== '*' && rule.toolName !== ctx.toolName) return false;
  if (rule.pathPattern && ctx.rawInput) {
    const filePath = (ctx.rawInput as any).filePath as string | undefined;
    if (!filePath || !globMatches(rule.pathPattern, filePath)) return false;
  }
  return true;
}

/** Simple glob matcher for * and ** patterns */
function globMatches(pattern: string, path: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
  return regex.test(path);
}

/** Generate a short random ID */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Get current date string */
export function dateStr(): string {
  return new Date().toISOString().slice(0, 10);
}
