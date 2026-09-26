import type { SyncRule } from '../types';
import { SYNC_NOTE_MAX_BYTES, TRUNCATION_MARKER } from '../constants';

export interface SyncContext {
  toolCallId: string;
  toolName: string;
  toolStatus: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  content?: string;
}

export function sanitizeVaultPath(folder: string, filename: string): { folder: string; filename: string } | null {
  // Reject empty
  if (!folder.trim() || !filename.trim()) return null;

  // Normalize separators
  const normFolder = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const normFile = filename.replace(/\\/g, '/');

  // Reject absolute paths or drive letters
  if (/^[a-zA-Z]:/.test(normFolder) || /^[a-zA-Z]:/.test(normFile)) return null;
  if (normFolder.startsWith('/') || normFile.startsWith('/')) return null;

  // Check each segment for dangerous patterns
  const folderParts = normFolder.split('/').filter(Boolean);
  const fileParts = normFile.split('/').filter(Boolean);
  const allParts = [...folderParts, ...fileParts];

  for (const part of allParts) {
    if (part === '.' || part === '..') return null;
    // Reject characters illegal in most filesystems
    if (/[<>:"|?*]/.test(part)) return null;
    for (let i = 0; i < part.length; i++) {
      if (part.charCodeAt(i) < 32) return null;
    }
    // Reject trailing dots/spaces (Windows)
    if (/[. ]$/.test(part)) return null;
  }

  return { folder: normFolder, filename: normFile };
}

export function ruleMatches(rule: SyncRule, ctx: SyncContext): boolean {
  if (!rule.enabled) return false;
  if (rule.toolName !== '*' && rule.toolName !== ctx.toolName) return false;
  if (rule.pathPattern && ctx.rawInput) {
    const fp = typeof ctx.rawInput.filePath === 'string' ? ctx.rawInput.filePath
      : typeof ctx.rawInput.path === 'string' ? ctx.rawInput.path : undefined;
    if (!fp) return false;
    if (!globLikeMatch(rule.pathPattern, fp)) return false;
  }
  return true;
}

function globLikeMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
  return regex.test(value);
}

export function buildSyncNote(ctx: SyncContext, folder: string, filenameTemplate: string, template?: string): { path: string; content: string } {
  const now = new Date().toISOString();
  const shortId = Math.random().toString(36).slice(2, 8);
  const filename = filenameTemplate
    .replace(/\{\{tool\}\}/g, ctx.toolName)
    .replace(/\{\{date\}\}/g, now.slice(0, 10))
    .replace(/\{\{shortId\}\}/g, shortId);

  const sanitized = sanitizeVaultPath(folder, filename);
  if (!sanitized) {
    throw new Error(`Invalid sync path: folder="${folder}", filename="${filename}"`);
  }

  const fm = ['---', `tool: ${ctx.toolName}`, `timestamp: ${now}`, `status: ${ctx.toolStatus}`, '---'].join('\n');
  const body = capSyncBody(template ?? `## ${ctx.toolName}\n\n${getSyncBody(ctx)}`);
  return { path: `${sanitized.folder}/${sanitized.filename}`, content: fm + '\n\n' + body };
}

// A tool output is as long as the agent decided it was; writing it out whole put
// a multi-megabyte note in the vault on every synced call.
function capSyncBody(body: string): string {
  if (Buffer.byteLength(body, 'utf-8') <= SYNC_NOTE_MAX_BYTES) return body;
  const clipped = Buffer.from(body, 'utf-8').subarray(0, SYNC_NOTE_MAX_BYTES).toString('utf-8');
  return `${clipped.replace(/\uFFFD+$/, '')}\n${TRUNCATION_MARKER}`;
}

function getSyncBody(ctx: SyncContext): string {
  if (ctx.content) return ctx.content;

  const output = ctx.rawOutput?.output;
  if (typeof output === 'string') return output;
  if (output !== undefined) return JSON.stringify(output, null, 2);

  return '(no output)';
}
