/**
 * The parts of the Obsidian API our pure modules touch. Aliased in
 * `vitest.config.ts` so unit tests never need an Obsidian runtime (TZ §5.6).
 *
 * `normalizePath` mirrors the documented behaviour: collapse duplicate slashes,
 * strip leading and trailing slashes, trim, normalise unicode.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/([\\/])+/g, '/')
    .replace(/(^\/+|\/+$)/g, '')
    .trim()
    .normalize('NFC');
}

export const getLanguage = (): string => 'en';
export class TFile {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export const requestUrl = () => {
  throw new Error('requestUrl is not stubbed: a unit test tried to hit the network');
};
