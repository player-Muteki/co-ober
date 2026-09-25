import { t } from '../i18n/index';

const EFFORT_LABEL_KEYS = ['default', 'low', 'medium', 'high', 'minimal', 'xhigh', 'max'] as const;

/**
 * Localize well-known reasoning-effort values; agent-supplied names for
 * unknown values pass through untouched so custom tiers stay visible.
 */
export function normalizeEffortLabel(value: string, name: string): string {
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const ef = t().toolbar.effort;
  for (const known of EFFORT_LABEL_KEYS) {
    if (known === key) return ef[known];
  }
  return name || value;
}
