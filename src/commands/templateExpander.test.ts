import { describe, expect, it } from 'vitest';
import { TemplateExpander } from './templateExpander';

describe('TemplateExpander', () => {
  const expander = new TemplateExpander();

  it('substitutes the whole argument string and each position', () => {
    expect(expander.expand('Review: $ARGUMENTS', 'file1.ts file2.ts')).toBe('Review: file1.ts file2.ts');
    expect(expander.expand('Diff $1 with $2', 'main.js feature.js')).toBe('Diff main.js with feature.js');
  });

  it('leaves a placeholder that has no argument behind as nothing', () => {
    expect(expander.expand('Note: $3', 'one two')).toBe('Note: ');
  });

  it('never expands a placeholder that arrived inside substituted text', () => {
    // Two passes rewrote the reader's own "$3" — typed as part of their
    // argument, through $ARGUMENTS — with whatever position 3 held, so the
    // command sent something other than what they asked for.
    expect(expander.expand('Summarize $ARGUMENTS', 'chapter $3')).toBe('Summarize chapter $3');
    expect(expander.expand('$1 then $2', '$2 second')).toBe('$2 then second');
  });

  it('builds the raw slash command when the definition has no template', () => {
    expect(expander.buildPrompt({ trigger: 'review' }, 'src/app.ts')).toBe('/review src/app.ts');
    expect(expander.buildPrompt({ trigger: 'review' }, '')).toBe('/review');
    expect(expander.buildPrompt({ trigger: 'review', template: 'Check $1' }, 'app.ts')).toBe('Check app.ts');
  });

  it('passes the arguments through when the template is empty', () => {
    expect(expander.expand('', 'just the args')).toBe('just the args');
  });
});
