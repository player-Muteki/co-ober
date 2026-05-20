import { describe, it, expect } from 'vitest';
import { ruleMatches, buildSyncNote } from './templates';
import type { SyncRule } from '../types';

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
});
