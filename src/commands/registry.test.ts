import { describe, it, expect, vi } from 'vitest';
import { CommandRegistry, type CommandSource, type SlashCommandDef } from './registry';

function def(trigger: string, over: Partial<SlashCommandDef> = {}): SlashCommandDef {
  return {
    id: trigger,
    trigger,
    title: trigger,
    description: '',
    category: 'agent',
    source: 'file',
    run: vi.fn(),
    ...over,
  };
}

describe('CommandRegistry.unregisterSource', () => {
  it('stops the source watcher and drops its definitions', () => {
    const registry = new CommandRegistry();
    const unwatch = vi.fn();
    const source: CommandSource = {
      type: 'file',
      load: () => [def('alpha'), def('beta')],
      watch: vi.fn(() => unwatch),
    };

    registry.registerSource(source);
    expect(registry.find('alpha')).toBeDefined();
    expect(registry.find('beta')).toBeDefined();
    expect(source.watch).toHaveBeenCalledTimes(1);

    registry.unregisterSource(source);

    expect(unwatch).toHaveBeenCalledTimes(1);
    expect(registry.find('alpha')).toBeUndefined();
    expect(registry.find('beta')).toBeUndefined();
    expect(registry.getAll().some((d) => d.source === 'file')).toBe(false);
  });

  it('notifies the subscriber on unregister', () => {
    const registry = new CommandRegistry();
    const onChange = vi.fn();
    registry.subscribe(onChange);

    const source: CommandSource = { type: 'file', load: () => [def('gamma')] };
    registry.registerSource(source);
    onChange.mockClear();

    registry.unregisterSource(source);
    expect(onChange).toHaveBeenCalled();
  });

  it('is idempotent for an unregistered or unknown source', () => {
    const registry = new CommandRegistry();
    const source: CommandSource = { type: 'file', load: () => [def('delta')] };
    registry.registerSource(source);

    registry.unregisterSource(source);
    // Second call must not throw and must not touch other sources.
    expect(() => registry.unregisterSource(source)).not.toThrow();

    const other: CommandSource = { type: 'mcp', load: () => [def('epsilon', { source: 'mcp' })] };
    registry.registerSource(other);
    registry.unregisterSource(source);
    expect(registry.find('epsilon')).toBeDefined();
  });

  it('removes only the target source, leaving builtins and other sources intact', () => {
    const registry = new CommandRegistry();
    registry.registerBuiltin(def('keep', { source: 'builtin' }));

    const fileSource: CommandSource = { type: 'file', load: () => [def('gone')] };
    const skillSource: CommandSource = { type: 'skill', load: () => [def('stay', { source: 'skill' })] };
    registry.registerSource(fileSource);
    registry.registerSource(skillSource);

    registry.unregisterSource(fileSource);

    expect(registry.find('keep')).toBeDefined();
    expect(registry.find('stay')).toBeDefined();
    expect(registry.find('gone')).toBeUndefined();
  });
});

describe('CommandRegistry.updateAcpCommands', () => {
  it('carries the agent’s argument hint onto the menu entry', () => {
    const registry = new CommandRegistry();
    registry.updateAcpCommands([
      { name: 'deploy', description: 'ship it', argumentHint: '<environment>' },
      { name: 'review', description: 'nothing expected' },
    ]);

    expect(registry.find('deploy')?.argumentHint).toBe('<environment>');
    expect(registry.find('review')?.argumentHint).toBeUndefined();
  });

  it('replaces the previous agent list rather than accumulating it', () => {
    const registry = new CommandRegistry();
    registry.updateAcpCommands([{ name: 'stale', description: '', argumentHint: '<x>' }]);
    registry.updateAcpCommands([{ name: 'fresh', description: '' }]);

    expect(registry.find('stale')).toBeUndefined();
    expect(registry.find('fresh')).toBeDefined();
  });
});
