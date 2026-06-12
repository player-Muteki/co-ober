import { describe, expect, it } from 'vitest';
import { BASE_IDENTITY } from './injection';

describe('BASE_IDENTITY', () => {
  it('defines the agent identity string', () => {
    expect(BASE_IDENTITY).toContain('You are Copsilot');
    expect(BASE_IDENTITY).toContain('Obsidian vault');
    expect(BASE_IDENTITY).toContain('OpenCode');
  });
});
