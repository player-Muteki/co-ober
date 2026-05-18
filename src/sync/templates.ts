import type { SyncRule } from '../types';

export interface SyncContext {
  toolCallId: string;
  toolName: string;
  toolStatus: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: string;
}

export function ruleMatches(rule: SyncRule, ctx: SyncContext): boolean {
  if (!rule.enabled) return false;
  if (rule.toolName !== '*' && rule.toolName !== ctx.toolName) return false;
  if (rule.pathPattern && ctx.rawInput) {
    const fp = (ctx.rawInput as any).filePath as string | undefined;
    if (fp && !new RegExp('^' + rule.pathPattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$').test(fp)) return false;
  }
  return true;
}

export function buildSyncNote(ctx: SyncContext, folder: string, filenameTemplate: string, template?: string): { path: string; content: string } {
  const now = new Date().toISOString();
  const shortId = Math.random().toString(36).slice(2, 8);
  const path = (filenameTemplate
    .replace(/\{\{tool\}\}/g, ctx.toolName)
    .replace(/\{\{date\}\}/g, now.slice(0, 10))
    .replace(/\{\{shortId\}\}/g, shortId));
  const fm = ['---', `tool: ${ctx.toolName}`, `timestamp: ${now}`, `status: ${ctx.toolStatus}`, '---'].join('\n');
  const body = template ?? `## ${ctx.toolName}\n\n${ctx.content ?? ctx.rawOutput?.output ?? '(no output)'}`;
  return { path: `${folder}/${path}`, content: fm + '\n\n' + body };
}
