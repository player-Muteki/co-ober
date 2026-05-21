import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from './engine';
import type { SyncRule } from '../types';
import type { Vault, TFile, TAbstractFile } from 'obsidian';

function createMockVault(): Vault {
  const files = new Map<string, TAbstractFile>();
  return {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    create: vi.fn().mockResolvedValue(undefined),
    modify: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue(undefined),
  } as unknown as Vault;
}

describe('SyncEngine', () => {
  it('should create a new note when no existing file', async () => {
    const vault = createMockVault();
    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: '{{tool}}-{{date}}-{{shortId}}',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'hello' });

    expect(vault.create).toHaveBeenCalledOnce();
    const [path, content] = (vault.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toMatch(/^sync\/write-/);
    expect(content).toContain('hello');
  });

  it('should modify existing note', async () => {
    const vault = createMockVault();
    const existingFile = { vault, extension: 'md', path: 'sync/write-test.md' } as unknown as TFile;
    (vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(existingFile);

    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'write-test',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'updated' });

    expect(vault.modify).toHaveBeenCalledOnce();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('should skip disabled rules', async () => {
    const vault = createMockVault();
    const rule: SyncRule = {
      id: 'test',
      enabled: false,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'test',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it('should skip non-matching tool names', async () => {
    const vault = createMockVault();
    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'edit',
      folder: 'sync',
      filenameTemplate: 'test',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(vault.create).not.toHaveBeenCalled();
  });

  it('should create nested folders', async () => {
    const vault = createMockVault();
    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'a/b/c',
      filenameTemplate: 'test',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(vault.createFolder).toHaveBeenCalledTimes(3);
    expect(vault.createFolder).toHaveBeenNthCalledWith(1, 'a');
    expect(vault.createFolder).toHaveBeenNthCalledWith(2, 'a/b');
    expect(vault.createFolder).toHaveBeenNthCalledWith(3, 'a/b/c');
  });

  it('should handle errors gracefully', async () => {
    const vault = createMockVault();
    (vault.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'test',
    };
    const engine = new SyncEngine(vault, [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
