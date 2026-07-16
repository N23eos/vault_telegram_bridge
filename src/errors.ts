import { t, type I18nKey } from './i18n';

/**
 * Every error a user can see. TZ §4.
 *
 * The rule: a `HumanError` carries an i18n key, never a rendered string, so the
 * message is translated at display time and the same error can be logged and
 * shown. Anything else that escapes to the UI goes through `toHumanError()` and
 * comes out as `error.unknown` — never as a stack trace in a Notice.
 */
export class HumanError extends Error {
  constructor(
    readonly key: I18nKey,
    readonly params?: Record<string, string | number>,
    readonly cause?: unknown,
  ) {
    super(key);
    this.name = 'HumanError';
  }

  /** Rendered in the active locale. Call this at the UI boundary, not before. */
  get human(): string {
    return t(this.key, this.params);
  }
}

/**
 * Retryable means "the same call, unchanged, may succeed later": offline,
 * rate-limited, another device holding the poll. A bad token is not retryable
 * and must interrupt the user; a dropped Wi-Fi connection must not.
 */
export function isRetryable(e: unknown): boolean {
  return (
    e instanceof HumanError &&
    (e.key === 'error.offline' ||
      e.key === 'error.network' ||
      e.key === 'error.conflict' ||
      e.key === 'error.rateLimited')
  );
}

export function toHumanError(e: unknown): HumanError {
  if (e instanceof HumanError) return e;
  if (!navigator.onLine) return new HumanError('error.offline', undefined, e);
  const message = e instanceof Error ? e.message : String(e);
  return new HumanError('error.unknown', { message }, e);
}

export const errNoToken = () => new HumanError('error.noToken');
export const errInvalidToken = () => new HumanError('error.invalidToken');
export const errTokenShape = () => new HumanError('error.tokenShape');
export const errNetwork = (cause?: unknown) => new HumanError('error.network', undefined, cause);
export const errOffline = () => new HumanError('error.offline');
export const errConflict = () => new HumanError('error.conflict');
export const errRateLimited = (seconds: number) => new HumanError('error.rateLimited', { seconds });
export const errTelegram = (message: string) => new HumanError('error.telegram', { message });
export const errFileTooBig = () => new HumanError('error.fileTooBig');
export const errBadTemplate = (template: string) => new HumanError('error.badTemplate', { template });
export const errWriteFailed = (path: string, reason: string) =>
  new HumanError('error.writeFailed', { path, reason });
export const errTranscriptionFailed = (reason: string, cause?: unknown) =>
  new HumanError('error.transcriptionFailed', { reason }, cause);
