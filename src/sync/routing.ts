import { normalizePath } from 'obsidian';
import { errBadTemplate } from '../errors';
import type { HashtagRoute } from '../settings';
import type { TgEntity } from '../telegram/types';
import type { DateFormatter } from '../vault/daily-note';

const ILLEGAL_IN_PATH = /[\\:*?"<>|#^[\]]/;

export interface MatchedRoute {
  route: HashtagRoute;
  entity: TgEntity;
}

export interface RoutedMessage {
  path: string;
  heading?: string;
  text: string;
  entities?: TgEntity[];
}

/** Settings order is priority order; only Telegram-declared hashtags count. */
export function resolveRoute(
  text: string,
  entities: readonly TgEntity[] | undefined,
  routes: readonly HashtagRoute[],
): MatchedRoute | undefined {
  if (!entities || routes.length === 0) return undefined;
  const hashtags = entities.filter((entity) => entity.type === 'hashtag');

  for (const route of routes) {
    const tag = route.tag.replace(/^#/, '').toLocaleLowerCase();
    const entity = hashtags.find((candidate) =>
      text.slice(candidate.offset, candidate.offset + candidate.length).replace(/^#/, '').toLocaleLowerCase() === tag,
    );
    if (entity) return { route, entity };
  }
  return undefined;
}

export function routeMessage(
  text: string,
  entities: readonly TgEntity[] | undefined,
  routes: readonly HashtagRoute[],
  date: Date,
  format: DateFormatter,
): RoutedMessage | undefined {
  const matched = resolveRoute(text, entities, routes);
  if (!matched) return undefined;

  const path = resolveRoutePath(matched.route.notePath, date, format);
  const removed = removeEntity(text, entities ?? [], matched.entity);
  return {
    path,
    ...(matched.route.heading ? { heading: matched.route.heading } : {}),
    text: removed.text,
    ...(removed.entities.length > 0 ? { entities: removed.entities } : {}),
  };
}

export function resolveRoutePath(template: string, date: Date, format: DateFormatter): string {
  const rendered = formatRoutePath(template, date, format).trim();
  if (rendered === '' || ILLEGAL_IN_PATH.test(rendered)) throw errBadTemplate(template);

  const segments = rendered.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.trim() === '')) {
    throw errBadTemplate(template);
  }

  const withExtension = rendered.toLocaleLowerCase().endsWith('.md') ? rendered : `${rendered}.md`;
  return normalizePath(withExtension);
}

/**
 * Moment treats ordinary letters as tokens (`d`, `m`, `a`, …). Passing a path
 * like `Inbox/Ideas.md` to `moment().format()` would therefore mangle the note
 * name. Only complete chunks made solely of common multi-character tokens are
 * formatted; literal path words never enter Moment.
 */
function formatRoutePath(template: string, date: Date, format: DateFormatter): string {
  return template.replace(/[A-Za-z]+/g, (chunk) => (isDateTokenChunk(chunk) ? format(chunk, date) : chunk));
}

const DATE_TOKENS = [
  'YYYY',
  'MMMM',
  'DDDD',
  'SSS',
  'MMM',
  'DDD',
  'YY',
  'MM',
  'DD',
  'HH',
  'hh',
  'mm',
  'ss',
  'WW',
  'ww',
  'ZZ',
  'Q',
  'Z',
  'X',
  'x',
] as const;

function isDateTokenChunk(chunk: string): boolean {
  let offset = 0;
  while (offset < chunk.length) {
    const token = DATE_TOKENS.find((candidate) => chunk.startsWith(candidate, offset));
    if (!token) return false;
    offset += token.length;
  }
  return true;
}

function removeEntity(
  text: string,
  entities: readonly TgEntity[],
  target: TgEntity,
): { text: string; entities: TgEntity[] } {
  let start = target.offset;
  let end = target.offset + target.length;

  // Prefer consuming whitespace after the tag: it preserves the natural space
  // before a hashtag in the middle (`buy #idea milk` → `buy milk`). At the end,
  // consume whitespace before it instead.
  while (end < text.length && /\s/.test(text[end])) end++;
  if (end === target.offset + target.length && end === text.length) {
    while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
  }

  const removedLength = end - start;
  const adjusted: TgEntity[] = [];
  for (const entity of entities) {
    if (entity === target) continue;
    const entityEnd = entity.offset + entity.length;
    if (entityEnd <= start) {
      adjusted.push({ ...entity });
    } else if (entity.offset >= end) {
      adjusted.push({ ...entity, offset: entity.offset - removedLength });
    } else if (entity.offset <= start && entityEnd >= end) {
      const length = entity.length - removedLength;
      if (length > 0) adjusted.push({ ...entity, length });
    }
    // Entities wholly or partially inside the removed hashtag are discarded.
  }

  return { text: text.slice(0, start) + text.slice(end), entities: adjusted };
}
