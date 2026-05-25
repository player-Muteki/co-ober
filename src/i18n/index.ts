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
  for (const listener of listeners) listener();
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Convenience alias for getLocale() */
export function t(): Locale {
  return currentLocale;
}
