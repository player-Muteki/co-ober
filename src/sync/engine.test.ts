import { describe, it, expect, vi } from 'vitest';
import { SyncEngine } from './engine';
import type { SyncRule } from '../types';
import type { Vault, TAbstractFile } from 'obsidian';
import { TFile } from 'obsidian';
import { Notice } from '../test/obsidianMock';

function createMockVault(cachedRead?: (file: TFile) => Promise<string>): Vault {
  const files = new Map<string, TAbstractFile>();
  return {
    getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
    create: vi.fn().mockResolvedValue(undefined),
    modify: vi.fn().mockResolvedValue(undefined),
    createFolder: vi.fn().mockResolvedValue(undefined),
    cachedRead: vi.fn(cachedRead ?? (async () => '')),
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
    const engine = new SyncEngine(vault, () => [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'hello' });

    expect(vault.create).toHaveBeenCalledOnce();
    const [path, content] = (vault.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toMatch(/^sync\/write-/);
    expect(content).toContain('hello');
  });

  it('should modify existing note', async () => {
    const vault = createMockVault();
    const existingFile = Object.assign(new TFile(), { vault, extension: 'md', path: 'sync/write-test.md' });
    (vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(existingFile);

    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'write-test',
    };
    const engine = new SyncEngine(vault, () => [rule]);

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
    const engine = new SyncEngine(vault, () => [rule]);

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
    const engine = new SyncEngine(vault, () => [rule]);

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
    const engine = new SyncEngine(vault, () => [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(vault.createFolder).toHaveBeenCalledTimes(3);
    expect(vault.createFolder).toHaveBeenNthCalledWith(1, 'a');
    expect(vault.createFolder).toHaveBeenNthCalledWith(2, 'a/b');
    expect(vault.createFolder).toHaveBeenNthCalledWith(3, 'a/b/c');
  });

  it('follows the live rule list, so a deleted rule stops writing notes', async () => {
    const vault = createMockVault();
    const kept: SyncRule = {
      id: 'a',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'a',
    };
    const added: SyncRule = {
      id: 'b',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'b',
    };
    // The settings tab replaces settings.syncRules wholesale on every edit, so
    // an array captured at construction time is stale from the first deletion.
    let rules: SyncRule[] = [kept];
    const engine = new SyncEngine(vault, () => rules);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'x' });
    rules = [added];
    await engine.process({ toolCallId: '2', toolName: 'write', toolStatus: 'completed', content: 'y' });

    const paths = (vault.create as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(paths).toEqual(['sync/a', 'sync/b']);
  });

  it('announces that a note was replaced, since a pinned template overwrites in place', async () => {
    Notice.messages.length = 0;
    const vault = createMockVault(async () => 'what the reader had written');
    const existingFile = Object.assign(new TFile(), { vault, extension: 'md', path: 'sync/write-test.md' });
    (vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(existingFile);

    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'write-test',
    };
    const engine = new SyncEngine(vault, () => [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'updated' });

    expect(vault.modify).toHaveBeenCalledOnce();
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('sync/write-test');
  });

  it('stays quiet when the note already holds exactly what is being written', async () => {
    Notice.messages.length = 0;
    // The front matter carries a timestamp, so two turns only produce the same
    // note when the clock is held still; without this the second turn would be
    // announced as an overwrite of content nobody changed.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      let stored = '';
      const vault = createMockVault(async () => stored);
      const existingFile = Object.assign(new TFile(), { vault, extension: 'md', path: 'sync/write-test.md' });
      (vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(existingFile);
      (vault.modify as ReturnType<typeof vi.fn>).mockImplementation(async (_file: unknown, content: string) => {
        stored = content;
      });

      const rule: SyncRule = {
        id: 'test',
        enabled: true,
        toolName: 'write',
        folder: 'sync',
        filenameTemplate: 'write-test',
        template: 'fresh output',
      };
      const engine = new SyncEngine(vault, () => [rule]);
      const ctx = { toolCallId: '1', toolName: 'write', toolStatus: 'completed', content: 'x' };

      await engine.process(ctx);
      expect(Notice.messages).toHaveLength(1);
      Notice.messages.length = 0;

      await engine.process(ctx);
      expect(vault.modify).toHaveBeenCalledTimes(2);
      expect(Notice.messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim an overwrite it could not read', async () => {
    Notice.messages.length = 0;
    const vault = createMockVault(async () => {
      throw new Error('not readable');
    });
    const existingFile = Object.assign(new TFile(), { vault, extension: 'md', path: 'sync/write-test.md' });
    (vault.getAbstractFileByPath as ReturnType<typeof vi.fn>).mockReturnValue(existingFile);

    const rule: SyncRule = {
      id: 'test',
      enabled: true,
      toolName: 'write',
      folder: 'sync',
      filenameTemplate: 'write-test',
    };
    const engine = new SyncEngine(vault, () => [rule]);

    const failures = await engine.process({
      toolCallId: '1',
      toolName: 'write',
      toolStatus: 'completed',
      content: 'updated',
    });

    expect(failures).toEqual([]);
    expect(vault.modify).toHaveBeenCalledOnce();
    expect(Notice.messages).toEqual([]);
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
    const engine = new SyncEngine(vault, () => [rule]);

    await engine.process({ toolCallId: '1', toolName: 'write', toolStatus: 'completed' });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
