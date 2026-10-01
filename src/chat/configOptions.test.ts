import { describe, expect, it } from 'vitest';
import { projectGenericConfigOptions, selectValueOf } from './configOptions';
import type { SessionConfigOption } from '../types';

const option = (over: Partial<SessionConfigOption>): SessionConfigOption => ({
  id: 'x',
  name: 'X',
  type: 'select',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
  ...over,
});

describe('projectGenericConfigOptions', () => {
  it('turns an option with a real choice into a control', () => {
    expect(projectGenericConfigOptions([option({ id: 'reasoning_budget', name: 'Reasoning', currentValue: 'b' })])).toEqual([
      {
        id: 'reasoning_budget',
        label: 'Reasoning',
        value: 'b',
        values: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      },
    ]);
  });

  it('leaves the three options with a dedicated toolbar control to that control', () => {
    const projected = projectGenericConfigOptions([
      option({ id: 'model' }),
      option({ id: 'mode' }),
      option({ id: 'effort' }),
      option({ id: 'persona' }),
    ]);
    expect(projected.map((o) => o.id)).toEqual(['persona']);
  });

  it('projects an absent or boolean current value as no choice, not a selected id', () => {
    // `String(opt.currentValue)` used to turn a toggle's `true` into the value id
    // "true", and left an omitted current value as "" — both then painted by the
    // chip as a selection the option list never offered. Routing through
    // selectValueOf (the same rule the model/effort controls use) projects both
    // to "" so the surface can honestly say nothing is chosen.
    const toggled = projectGenericConfigOptions([option({ type: 'boolean', currentValue: true })])[0];
    expect(toggled.value).toBe('');
    const omitted = projectGenericConfigOptions([option({ currentValue: '' })])[0];
    expect(omitted.value).toBe('');
  });

  it('offers no control where there is nothing to choose', () => {
    expect(projectGenericConfigOptions([option({ id: 'window', options: [{ value: 'a', name: 'A' }] })])).toEqual([]);
    expect(projectGenericConfigOptions([option({ id: 'window', options: [] })])).toEqual([]);
  });

  it('says nothing when the agent declared no extra options', () => {
    expect(projectGenericConfigOptions([])).toEqual([]);
  });
});

describe('selectValueOf', () => {
  it('reads a selected value id', () => {
    expect(selectValueOf(option({ currentValue: 'b' }))).toBe('b');
  });

  it('says nothing is selected for a boolean toggle rather than selecting "true"', () => {
    // A dropdown selects value ids. Pasting a toggle's `true` into the model
    // field would name a model that does not exist.
    expect(selectValueOf(option({ type: 'boolean', currentValue: true }))).toBeUndefined();
    expect(selectValueOf(option({ type: 'boolean', currentValue: false }))).toBeUndefined();
  });

  it('says nothing for an option that is not there', () => {
    expect(selectValueOf(undefined)).toBeUndefined();
  });
});
