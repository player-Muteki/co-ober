import type { SessionConfigOption } from '../types';

/**
 * One agent-declared config option projected onto a generic control. `label`
 * and `values[].label` are the agent's own words, so they are never localized.
 */
export interface ExtraConfigOption {
  id: string;
  label: string;
  value: string;
  values: Array<{ value: string; label: string }>;
}

/** Options with a dedicated toolbar control; the rest are projected generically. */
const DEDICATED_CONFIG_IDS = new Set(['model', 'mode', 'effort']);

/**
 * A dropdown can only select a value id. A boolean toggle's current value is a
 * real boolean, and it has no choices to select from, so it never reaches one
 * of the three dedicated controls — read it as "nothing selected" instead of
 * letting `true` be pasted into a model name.
 */
export function selectValueOf(opt: SessionConfigOption | undefined): string | undefined {
  return typeof opt?.currentValue === 'string' ? opt.currentValue : undefined;
}

/**
 * An agent may declare config options beyond the three Co-Ober renders itself
 * (reasoning budget, persona, context window…). Before this they were stored on
 * the session and never shown, so the reader could not tell the agent had
 * offered them; anything with a real choice now becomes a control.
 */
export function projectGenericConfigOptions(options: SessionConfigOption[]): ExtraConfigOption[] {
  return options
    .filter((opt) => !DEDICATED_CONFIG_IDS.has(opt.id))
    // Fewer than two choices means there is nothing to choose; a control that
    // cannot be changed would claim the agent offered a decision it did not.
    .filter((opt) => opt.options.length > 1)
    .map((opt) => ({
      id: opt.id,
      label: opt.name,
      value: String(opt.currentValue),
      values: opt.options.map((o) => ({ value: o.value, label: o.name })),
    }));
}
