import { describe, it, expect } from 'vitest';
import { parseSlashCommand } from './executor';

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
