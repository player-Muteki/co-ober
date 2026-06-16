import { describe, expect, it } from 'vitest';
import { BASE_IDENTITY, buildSystemPrompt } from './injection';

describe('BASE_IDENTITY', () => {
  it('defines the agent identity string', () => {
    expect(BASE_IDENTITY).toContain('You are Co-Ober');
    expect(BASE_IDENTITY).toContain('Obsidian vault');
    expect(BASE_IDENTITY).toContain('Vault Awareness');
  });
});

describe('buildSystemPrompt', () => {
  it('returns BASE_IDENTITY when no custom instructions', () => {
    expect(buildSystemPrompt('')).toBe(BASE_IDENTITY);
  });

  it('appends custom instructions after BASE_IDENTITY', () => {
    const result = buildSystemPrompt('Custom instructions.');
    expect(result).toContain(BASE_IDENTITY);
    expect(result).toContain('Custom instructions.');
    expect(result).toContain('\n\n');
  });
});
