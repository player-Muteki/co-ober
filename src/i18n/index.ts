import en from './en';
import zh from './zh';

export type Locale = typeof en;

const locales: Record<string, Locale> = { en, zh };

let currentLocale: Locale = en;

type LocaleListener = () => void;
const listeners = new Set<LocaleListener>();

export function onLocaleChange(listener: LocaleListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLocale(lang: string): void {
  currentLocale = locales[lang] ?? en;
  for (const listener of listeners) {
    try { listener(); } catch (e) { console.error('[co-ober] locale listener error:', e); }
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Convenience alias for getLocale() */
export function t(): Locale {
  return currentLocale;
}

/**
 * Resolve a dotted key path (e.g. "copy.button") against the active locale.
 * Returns undefined for missing paths or non-string leaves, so callers can
 * fall back to their own rendering instead of printing "undefined".
 */
export function lookupLocaleString(path: string): string | undefined {
  let node: unknown = currentLocale;
  for (const seg of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === 'string' ? node : undefined;
}
