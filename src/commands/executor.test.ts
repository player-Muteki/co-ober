import { describe, it, expect } from 'vitest';
import { parseSlashCommand, isBuiltInCommand } from './executor';

describe('parseSlashCommand', () => {
  it('should parse a simple slash command', () => {
    const result = parseSlashCommand('/compact');
    expect(result).toEqual({ name: 'compact', args: '', raw: '/compact' });
  });

  it('should parse a slash command with arguments', () => {
    const result = parseSlashCommand('/compact 10');
    expect(result).toEqual({ name: 'compact', args: '10', raw: '/compact 10' });
  });

  it('should parse a slash command with multiple arguments', () => {
    const result = parseSlashCommand('/search foo bar');
    expect(result).toEqual({ name: 'search', args: 'foo bar', raw: '/search foo bar' });
  });

  it('should return null for plain text without slash', () => {
    const result = parseSlashCommand('Hello world');
    expect(result).toBeNull();
  });

  it('should return null for empty string', () => {
    const result = parseSlashCommand('');
    expect(result).toBeNull();
  });

  it('should handle slash-only input', () => {
    const result = parseSlashCommand('/');
    expect(result).toBeNull();
  });
});

describe('isBuiltInCommand', () => {
  it('should recognize compact as built-in', () => {
    expect(isBuiltInCommand('compact')).toBe(true);
  });

  it('should reject unknown commands', () => {
    expect(isBuiltInCommand('search')).toBe(false);
    expect(isBuiltInCommand('random123')).toBe(false);
  });

  it('should be case sensitive', () => {
    expect(isBuiltInCommand('Compact')).toBe(false);
  });
});
