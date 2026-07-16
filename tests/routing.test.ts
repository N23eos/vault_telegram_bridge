import { describe, expect, it } from 'vitest';
import type { TgEntity } from '../src/telegram/types';
import { resolveRoute, routeMessage } from '../src/sync/routing';

const fmt = (template: string): string =>
  template.replace(/YYYY/g, '2026').replace(/MM/g, '07').replace(/DD/g, '16');

describe('resolveRoute', () => {
  it('matches routes in settings order, case-insensitively', () => {
    const entities: TgEntity[] = [
      { type: 'hashtag', offset: 0, length: 5 },
      { type: 'hashtag', offset: 6, length: 5 },
    ];
    const result = resolveRoute(
      '#Work #IDEA text',
      entities,
      [
        { tag: 'idea', notePath: 'Ideas.md' },
        { tag: 'work', notePath: 'Work.md' },
      ],
    );
    expect(result?.route.tag).toBe('idea');
  });

  it('returns undefined when Telegram did not mark a hashtag entity', () => {
    expect(resolveRoute('#idea text', undefined, [{ tag: 'idea', notePath: 'Ideas.md' }])).toBeUndefined();
  });
});

describe('route path formatting', () => {
  it('does not pass ordinary path words through Moment token formatting', () => {
    const seen: string[] = [];
    const result = routeMessage(
      '#idea x',
      [{ type: 'hashtag', offset: 0, length: 5 }],
      [{ tag: 'idea', notePath: 'Inbox/Ideas.md' }],
      new Date(),
      (template) => {
        seen.push(template);
        return 'mangled';
      },
    );
    expect(result?.path).toBe('Inbox/Ideas.md');
    expect(seen).toEqual([]);
  });

  it('formats complete date-token chunks while preserving literal path chunks', () => {
    const result = routeMessage(
      '#idea x',
      [{ type: 'hashtag', offset: 0, length: 5 }],
      [{ tag: 'idea', notePath: 'Topics/YYYY-MM/YYYYMMDD.md' }],
      new Date(),
      fmt,
    );
    expect(result?.path).toBe('Topics/2026-07/20260716.md');
  });
});

describe('routeMessage', () => {
  it('removes the routing hashtag and surrounding extra space', () => {
    const result = routeMessage(
      '#idea buy milk',
      [{ type: 'hashtag', offset: 0, length: 5 }],
      [{ tag: 'idea', notePath: 'Inbox/Ideas.md' }],
      new Date(),
      fmt,
    );
    expect(result).toMatchObject({ path: 'Inbox/Ideas.md', text: 'buy milk' });
  });

  it('keeps unrelated hashtags and adjusts later entity offsets', () => {
    const entities: TgEntity[] = [
      { type: 'hashtag', offset: 0, length: 5 },
      { type: 'bold', offset: 6, length: 4 },
      { type: 'hashtag', offset: 11, length: 5 },
    ];
    const result = routeMessage(
      '#idea bold #work',
      entities,
      [{ tag: 'idea', notePath: 'Ideas.md' }],
      new Date(),
      fmt,
    );
    expect(result?.text).toBe('bold #work');
    expect(result?.entities).toEqual([
      { type: 'bold', offset: 0, length: 4 },
      { type: 'hashtag', offset: 5, length: 5 },
    ]);
  });

  it('supports a routing hashtag in the middle of a sentence', () => {
    const result = routeMessage(
      'buy #idea milk',
      [{ type: 'hashtag', offset: 4, length: 5 }],
      [{ tag: 'idea', notePath: 'Ideas.md' }],
      new Date(),
      fmt,
    );
    expect(result?.text).toBe('buy milk');
  });

  it('renders Moment tokens and adds .md when omitted', () => {
    const result = routeMessage(
      '#idea x',
      [{ type: 'hashtag', offset: 0, length: 5 }],
      [{ tag: 'idea', notePath: 'Topics/YYYY/MM' }],
      new Date(),
      fmt,
    );
    expect(result?.path).toBe('Topics/2026/07.md');
  });

  it('preserves a custom heading', () => {
    const result = routeMessage(
      '#idea x',
      [{ type: 'hashtag', offset: 0, length: 5 }],
      [{ tag: 'idea', notePath: 'Ideas.md', heading: '## New ideas' }],
      new Date(),
      fmt,
    );
    expect(result?.heading).toBe('## New ideas');
  });

  it('rejects traversal and invalid paths', () => {
    expect(() =>
      routeMessage(
        '#idea x',
        [{ type: 'hashtag', offset: 0, length: 5 }],
        [{ tag: 'idea', notePath: '../Secrets.md' }],
        new Date(),
        fmt,
      ),
    ).toThrow();
  });
});
