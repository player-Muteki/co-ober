import { describe, it, expect } from 'vitest';
import { ruleMatches, buildSyncNote, sanitizeVaultPath } from './templates';
import type { SyncRule } from '../types';
import { SYNC_NOTE_MAX_BYTES, TRUNCATION_MARKER } from '../constants';

describe('ruleMatches', () => {
  const baseRule: SyncRule = {
    id: 'test',
    enabled: true,
    toolName: 'edit',
    folder: 'sync',
    filenameTemplate: '{{tool}}-{{date}}-{{shortId}}',
  };

  it('should match by tool name', () => {
    expect(ruleMatches(baseRule, { toolCallId: '1', toolName: 'edit', toolStatus: 'completed' })).toBe(true);
  });

  it('should not match different tool name', () => {
    expect(ruleMatches(baseRule, { toolCallId: '1', toolName: 'write', toolStatus: 'completed' })).toBe(false);
  });

  it('should match wildcard tool name', () => {
    const wildcard: SyncRule = { ...baseRule, toolName: '*' };
    expect(ruleMatches(wildcard, { toolCallId: '1', toolName: 'read', toolStatus: 'completed' })).toBe(true);
  });

  it('should not match disabled rule', () => {
    expect(ruleMatches({ ...baseRule, enabled: false }, { toolCallId: '1', toolName: 'edit', toolStatus: 'completed' })).toBe(false);
  });

  it('should match path pattern with wildcard', () => {
    const withPattern: SyncRule = { ...baseRule, pathPattern: 'src/**' };
    const ctx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'src/main.ts' } };
    expect(ruleMatches(withPattern, ctx)).toBe(true);
  });

  it('should reject path not matching pattern', () => {
    const withPattern: SyncRule = { ...baseRule, pathPattern: 'src/**' };
    const ctx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'dist/output.js' } };
    expect(ruleMatches(withPattern, ctx)).toBe(false);
  });

  it('should escape regex special chars in path pattern', () => {
    const withPattern: SyncRule = { ...baseRule, pathPattern: 'test.file.md' }; // dot should not match arbitrary char
    const matchCtx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'test.file.md' } };
    const noMatchCtx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'testXfile.md' } };
    expect(ruleMatches(withPattern, matchCtx)).toBe(true);
    expect(ruleMatches(withPattern, noMatchCtx)).toBe(false);
  });
});

describe('buildSyncNote', () => {
  it('should generate a path with template placeholders', () => {
    const ctx = { toolCallId: 'abc', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'test.md' } };
    const result = buildSyncNote(ctx, 'opencode-sync', '{{tool}}-{{date}}-{{shortId}}');
    expect(result.path).toMatch(/^opencode-sync\/edit-\d{4}-\d{2}-\d{2}-[a-z0-9]+$/);
    expect(result.content).toContain('tool: edit');
    expect(result.content).toContain('status: completed');
  });

  it('should use custom template body', () => {
    const ctx = { toolCallId: 'abc', toolName: 'write', toolStatus: 'completed', content: 'hello world' };
    const result = buildSyncNote(ctx, 'sync', 'test', '## Custom {{tool}}\n\n{{content}}');
    expect(result.path).toBe('sync/test');
    // custom template is used verbatim, no {{content}} replacement
    expect(result.content).toContain('## Custom');
  });

  it('should handle missing content gracefully', () => {
    const ctx = { toolCallId: 'abc', toolName: 'read', toolStatus: 'completed' };
    const result = buildSyncNote(ctx, 'folder', 'note');
    expect(result.content).toContain('(no output)');
  });

  it('should serialize non-string tool output', () => {
    const ctx = { toolCallId: 'abc', toolName: 'read', toolStatus: 'completed', rawOutput: { output: { ok: true } } };
    const result = buildSyncNote(ctx, 'folder', 'note');
    expect(result.content).toContain('"ok": true');
  });

  it('should reject path traversal in folder', () => {
    const ctx = { toolCallId: 'abc', toolName: 'edit', toolStatus: 'completed' };
    expect(() => buildSyncNote(ctx, '../etc', 'note')).toThrow('Invalid sync path');
  });

  it('should reject path traversal in filename', () => {
    const ctx = { toolCallId: 'abc', toolName: 'edit', toolStatus: 'completed' };
    expect(() => buildSyncNote(ctx, 'sync', '../../secret')).toThrow('Invalid sync path');
  });
});

describe('ruleMatches with path field', () => {
  const baseRule: SyncRule = {
    id: 'test',
    enabled: true,
    toolName: 'edit',
    folder: 'sync',
    filenameTemplate: '{{tool}}-{{date}}-{{shortId}}',
    pathPattern: 'src/**',
  };

  it('should match using rawInput.path when filePath is absent', () => {
    const ctx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { path: 'src/main.ts' } };
    expect(ruleMatches(baseRule, ctx)).toBe(true);
  });

  it('should reject when pathPattern set but no path fields present', () => {
    const ctx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { other: 'value' } };
    expect(ruleMatches(baseRule, ctx)).toBe(false);
  });

  it('should prefer filePath over path', () => {
    const ctx = { toolCallId: '1', toolName: 'edit', toolStatus: 'completed', rawInput: { filePath: 'dist/out.js', path: 'src/main.ts' } };
    expect(ruleMatches(baseRule, ctx)).toBe(false);
  });
});

describe('sanitizeVaultPath', () => {
  it('should accept valid paths', () => {
    expect(sanitizeVaultPath('sync', 'note')).toEqual({ folder: 'sync', filename: 'note' });
  });

  it('should accept nested folders', () => {
    expect(sanitizeVaultPath('a/b/c', 'file')).toEqual({ folder: 'a/b/c', filename: 'file' });
  });

  it('should normalize backslashes', () => {
    expect(sanitizeVaultPath('a\\b', 'c\\d')).toEqual({ folder: 'a/b', filename: 'c/d' });
  });

  it('should reject empty folder', () => {
    expect(sanitizeVaultPath('', 'note')).toBeNull();
  });

  it('should reject empty filename', () => {
    expect(sanitizeVaultPath('sync', '')).toBeNull();
  });

  it('should reject .. in folder', () => {
    expect(sanitizeVaultPath('../etc', 'note')).toBeNull();
  });

  it('should reject .. in filename', () => {
    expect(sanitizeVaultPath('sync', '../../secret')).toBeNull();
  });

  it('should reject absolute paths', () => {
    expect(sanitizeVaultPath('/etc', 'note')).toBeNull();
  });

  it('should reject drive letters', () => {
    expect(sanitizeVaultPath('C:/Windows', 'note')).toBeNull();
  });

  it('should reject illegal filename characters', () => {
    expect(sanitizeVaultPath('sync', 'note<>test')).toBeNull();
  });

  it('should reject trailing dots', () => {
    expect(sanitizeVaultPath('sync', 'note.')).toBeNull();
  });
});

describe('buildSyncNote body cap (0.2.5 stage 3)', () => {
  const rule = { toolName: 'bash', folder: 'sync', filenameTemplate: 'capped' };

  it('leaves a body under the limit untouched', () => {
    const note = buildSyncNote(
      { toolCallId: '1', toolName: 'bash', toolStatus: 'completed', content: 'short output' },
      rule.folder,
      rule.filenameTemplate,
    );
    expect(note.content).toContain('short output');
    expect(note.content).not.toContain(TRUNCATION_MARKER);
  });

  it('clips an oversized tool output and says so in the note', () => {
    const note = buildSyncNote(
      { toolCallId: '1', toolName: 'bash', toolStatus: 'completed', content: 'x'.repeat(SYNC_NOTE_MAX_BYTES * 2) },
      rule.folder,
      rule.filenameTemplate,
    );
    expect(note.content).toContain(TRUNCATION_MARKER);
    expect(Buffer.byteLength(note.content, 'utf-8')).toBeLessThan(SYNC_NOTE_MAX_BYTES * 2);
  });

  it('clips a custom template too, since it is written to the vault the same way', () => {
    const note = buildSyncNote(
      { toolCallId: '1', toolName: 'bash', toolStatus: 'completed' },
      rule.folder,
      rule.filenameTemplate,
      'y'.repeat(SYNC_NOTE_MAX_BYTES + 1000),
    );
    expect(note.content).toContain(TRUNCATION_MARKER);
  });

  it('cuts on a character boundary rather than leaving a broken rune', () => {
    const note = buildSyncNote(
      { toolCallId: '1', toolName: 'bash', toolStatus: 'completed', content: '汉'.repeat(SYNC_NOTE_MAX_BYTES) },
      rule.folder,
      rule.filenameTemplate,
    );
    expect(note.content).not.toContain('\uFFFD');
    expect(note.content).toContain(TRUNCATION_MARKER);
  });
});
