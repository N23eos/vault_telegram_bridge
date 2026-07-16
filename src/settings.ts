/**
 * Settings schema, defaults and migrations. TZ §5.1.
 *
 * `data.json` lives in `configDir`, which a large share of users sync through
 * git, iCloud or Obsidian Sync. Two consequences, both deliberate:
 *
 *   - the bot token is stored here in plain text, and the wizard says so. A bot
 *     token is not an account credential (ADR-001), and encrypting it behind a
 *     passphrase the user must retype on every launch would be theatre;
 *   - `cursor` is stored here too, and is therefore *expected* to conflict
 *     across devices. It is an optimisation. Deduplication is done by markers
 *     in the note (SPEC §5а), so a stale cursor costs a re-read, never a
 *     duplicate line.
 */

import type { BlockStyle } from './sync/render';

export const CURRENT_SCHEMA_VERSION = 3;

export interface HashtagRoute {
  /** Telegram hashtag without the leading `#`, stored lower-case. */
  tag: string;
  /** Vault-relative note path. Moment tokens are allowed; `.md` is optional. */
  notePath: string;
  /** Falls back to the global heading when absent. */
  heading?: string;
}

export interface Settings {
  version: number;

  /** From @BotFather. Empty means not connected. */
  botToken: string;

  /**
   * The only chat we accept messages from. Bot usernames are enumerable, so
   * without this a stranger writes into the user's daily note. Bound to the
   * first chat that talks to the bot; see ADR-001.
   */
  boundChatId: string | null;

  /**
   * Write into the note the core Daily Notes plugin owns — its folder, name
   * format and template — instead of the two fields below. Falls back to them
   * when the core plugin is disabled.
   */
  useCoreDailyNote: boolean;

  /** First matching Telegram hashtag routes the message away from the daily note. */
  routes: HashtagRoute[];

  /** Vault-relative. Empty string is the vault root. Ignored while `useCoreDailyNote` works. */
  folder: string;

  /** Moment.js tokens. One note per day holds that day's messages. */
  filenameTemplate: string;

  /** Messages are appended beneath this. Created if the note lacks it. */
  heading: string;

  /**
   * How one message is rendered. `{time}`, `{date}` and `{text}` are substituted;
   * everything else is literal, so an emoji, bold markers or a `- ` bullet all
   * go here rather than each becoming its own checkbox.
   */
  lineTemplate: string;

  /** Wrap each entry in nothing, a fenced code block, or a callout. */
  blockStyle: BlockStyle;

  /** `note`, `tip`, `quote`, … Only used when `blockStyle` is `callout`. */
  calloutType: string;

  /** Between polls, while Obsidian is open. */
  syncIntervalSeconds: number;

  /** Optional OpenAI-compatible speech-to-text service. */
  transcriptionEnabled: boolean;
  transcriptionBaseUrl: string;
  transcriptionApiKey: string;
  transcriptionModel: string;

  /** Telegram's `getUpdates` offset. Optimisation only — see the note above. */
  cursor: number | undefined;

  /** Purely informational, rendered in the settings tab. */
  lastSync: { at: number; ok: boolean; count?: number; errorKey?: string } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_SCHEMA_VERSION,
  botToken: '',
  boundChatId: null,
  useCoreDailyNote: false,
  routes: [],
  folder: '',
  filenameTemplate: 'YYYY-MM-DD',
  heading: '## Telegram',
  lineTemplate: '**{time}** {text}',
  blockStyle: 'plain',
  calloutType: 'note',
  syncIntervalSeconds: 30,
  transcriptionEnabled: false,
  transcriptionBaseUrl: 'https://api.openai.com/v1',
  transcriptionApiKey: '',
  transcriptionModel: 'whisper-1',
  cursor: undefined,
  lastSync: null,
};

export const MIN_SYNC_INTERVAL_SECONDS = 15;
export const MAX_SYNC_INTERVAL_SECONDS = 3600;

export const BLOCK_STYLES: readonly BlockStyle[] = ['plain', 'code', 'callout'];

/**
 * Migrations are keyed by the version being migrated *from*. Each step is
 * total: it must accept anything the previous version could have written,
 * including data hand-edited by a user.
 *
 * There are no migrations yet. The machinery ships in v0.1 anyway, because
 * retrofitting it once users have data in the field is how settings get lost.
 */
type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  /**
   * v1 → v2: the line format became a template, and entries can be wrapped.
   *
   * v1 wrote `- HH:mm text %%tg:chat:id%%` and nothing else was configurable.
   * The closest template is `- {time} {text}`, but the marker is gone from the
   * body (records moved to frontmatter), so a v1 user's notes will look slightly
   * different from the day they upgrade. Carrying the bullet across keeps the
   * change to one thing rather than two.
   */
  1: (data) => ({
    ...data,
    version: 2,
    lineTemplate: '- {time} {text}',
    blockStyle: 'plain',
    calloutType: 'note',
  }),
  /** v2 → v3: hashtag routing and opt-in transcription. */
  2: (data) => ({
    ...data,
    version: 3,
    routes: [],
    transcriptionEnabled: false,
    transcriptionBaseUrl: 'https://api.openai.com/v1',
    transcriptionApiKey: '',
    transcriptionModel: 'whisper-1',
  }),
};

/**
 * Never throws. A corrupt or hand-mangled `data.json` degrades to defaults for
 * the fields it broke, rather than preventing the plugin from loading — the
 * alternative is a user who cannot reach the settings tab to fix it.
 */
export function migrate(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return freshDefaults();

  let data = { ...(raw as Record<string, unknown>) };
  let version = typeof data.version === 'number' ? data.version : 0;

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) {
      // Unknown gap (a downgrade, or a version we never shipped). Keep whatever
      // fields still validate and stop guessing.
      break;
    }
    data = step(data);
    version = typeof data.version === 'number' ? data.version : version + 1;
  }

  return sanitize(data);
}

/** Coerces one loaded object into a valid `Settings`, field by field. */
function sanitize(data: Record<string, unknown>): Settings {
  const s = freshDefaults();

  if (typeof data.botToken === 'string') s.botToken = data.botToken.trim();
  if (typeof data.boundChatId === 'string' && /^-?\d+$/.test(data.boundChatId)) {
    s.boundChatId = data.boundChatId;
  }
  if (typeof data.useCoreDailyNote === 'boolean') s.useCoreDailyNote = data.useCoreDailyNote;
  if (Array.isArray(data.routes)) s.routes = sanitizeRoutes(data.routes);
  if (typeof data.folder === 'string') s.folder = stripSlashes(data.folder);
  if (typeof data.filenameTemplate === 'string' && data.filenameTemplate.trim() !== '') {
    s.filenameTemplate = data.filenameTemplate.trim();
  }
  if (typeof data.heading === 'string' && data.heading.trim() !== '') {
    s.heading = data.heading.trim();
  }
  if (typeof data.lineTemplate === 'string' && data.lineTemplate.trim() !== '') {
    // Not trimmed at the start: a leading space may be intentional inside a callout.
    s.lineTemplate = data.lineTemplate.replace(/\n/g, ' ').trimEnd();
  }
  if (typeof data.blockStyle === 'string' && (BLOCK_STYLES as readonly string[]).includes(data.blockStyle)) {
    s.blockStyle = data.blockStyle as BlockStyle;
  }
  if (typeof data.calloutType === 'string' && /^[A-Za-z-]+$/.test(data.calloutType.trim())) {
    s.calloutType = data.calloutType.trim();
  }
  if (typeof data.syncIntervalSeconds === 'number' && Number.isFinite(data.syncIntervalSeconds)) {
    s.syncIntervalSeconds = clamp(
      Math.round(data.syncIntervalSeconds),
      MIN_SYNC_INTERVAL_SECONDS,
      MAX_SYNC_INTERVAL_SECONDS,
    );
  }
  if (typeof data.transcriptionEnabled === 'boolean') {
    s.transcriptionEnabled = data.transcriptionEnabled;
  }
  if (typeof data.transcriptionBaseUrl === 'string') {
    const url = normalizeHttpUrl(data.transcriptionBaseUrl);
    if (url) s.transcriptionBaseUrl = url;
  }
  if (typeof data.transcriptionApiKey === 'string') {
    s.transcriptionApiKey = data.transcriptionApiKey.trim();
  }
  if (typeof data.transcriptionModel === 'string' && data.transcriptionModel.trim() !== '') {
    s.transcriptionModel = data.transcriptionModel.trim();
  }
  if (typeof data.cursor === 'number' && Number.isInteger(data.cursor) && data.cursor >= 0) {
    s.cursor = data.cursor;
  }
  if (isLastSync(data.lastSync)) s.lastSync = data.lastSync;

  s.version = CURRENT_SCHEMA_VERSION;
  return s;
}

function freshDefaults(): Settings {
  return { ...DEFAULT_SETTINGS, routes: [] };
}

/** A tag a Telegram hashtag entity can actually produce. */
export const HASHTAG_SHAPE = /^[\p{L}\p{N}_]+$/u;

/**
 * Normalises rows but never silently deletes one: a typo'd tag or half-filled
 * row must survive the restart so the user can fix it in the settings tab. An
 * invalid tag simply never matches; the tab marks it visually.
 */
function sanitizeRoutes(value: unknown[]): HashtagRoute[] {
  const routes: HashtagRoute[] = [];
  for (const item of value.slice(0, 100)) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.tag !== 'string' || typeof raw.notePath !== 'string') continue;
    const tag = raw.tag.trim().replace(/^#/, '').toLowerCase();
    const notePath = stripSlashes(raw.notePath);
    if (tag === '' && notePath === '') continue;
    const heading = typeof raw.heading === 'string' ? raw.heading.trim() : '';
    routes.push({ tag, notePath, ...(heading !== '' ? { heading } : {}) });
  }
  return routes;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The API key travels as a Bearer header, so remote endpoints must be https.
 * Plain http is allowed only for loopback — a local whisper server is a real
 * use case and never leaves the machine.
 */
export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'https:') return trimmed;
    if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return trimmed;
    return null;
  } catch {
    return null;
  }
}

function isLastSync(v: unknown): v is Settings['lastSync'] {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.at === 'number' && typeof o.ok === 'boolean';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `/Inbox/TG/` and `Inbox/TG` are the same folder. The root is `''`, not `/`. */
export function stripSlashes(folder: string): string {
  return folder.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * A bot token is `<numeric bot id>:<~35 chars>`. Checking the shape locally
 * turns a typo into an immediate, specific message instead of a round-trip and
 * a generic 401.
 */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}
