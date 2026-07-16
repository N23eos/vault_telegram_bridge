import { getLanguage } from 'obsidian';
import { en, type Dictionary, type I18nKey } from './en';
import { ru } from './ru';

/**
 * TZ §1: the infrastructure lands with the first commit, the RU dictionary in
 * 0.2. Registering a locale is `dictionaries['ru'] = ru` and nothing else.
 */
const dictionaries: Partial<Record<string, Dictionary>> = { en, ru };

let active: Dictionary = en;

/** Obsidian sets `moment.locale()`, but the reliable signal is the app language. */
export function setLocale(locale: string): void {
  active = dictionaries[locale.toLowerCase().split('-')[0]] ?? en;
}

export function detectLocale(): string {
  // Official API since Obsidian 1.8; older builds fall back to the system language.
  if (typeof getLanguage === 'function') {
    try {
      return getLanguage();
    } catch {
      // pre-1.8 runtime without the export
    }
  }
  return typeof navigator !== 'undefined' ? navigator.language : 'en';
}

/**
 * `t('conn.status.connected', { name: 'my_bot' })`
 *
 * A missing placeholder is left as-is rather than rendered as `undefined`; a
 * wrong key is a compile error, so there is no runtime key-not-found path.
 */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const template: string = active[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

export type { I18nKey };
