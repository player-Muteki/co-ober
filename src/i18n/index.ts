import en from './en';
import zh from './zh';

export type Locale = typeof en;

const locales: Record<string, Locale> = { en, zh };

let currentLocale: Locale = en;

export function setLocale(lang: string): void {
  currentLocale = locales[lang] ?? en;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Convenience alias for getLocale() */
export function t(): Locale {
  return currentLocale;
}
