import { describe, expect, it } from 'vitest';
import { ContextInjection } from './injection';

describe('ContextInjection', () => {
  it('adds custom agent prompt after user system instructions', () => {
    const prompt = ContextInjection.systemPrompt('User instructions.', 'Custom agent instructions.');

    expect(prompt).toContain('You are Copsidian');
    expect(prompt).toContain('User instructions.\n\nCustom agent instructions.');
  });

  it('preserves default prompt when custom agent prompt is empty', () => {
    const prompt = ContextInjection.systemPrompt('', '');

    expect(prompt).toContain('You are Copsidian');
    expect(prompt).not.toContain('Custom agent:');
  });
});
