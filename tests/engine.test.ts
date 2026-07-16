import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanError, errConflict, errInvalidToken, errOffline, errRateLimited } from '../src/errors';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings';
import { extractMarkers, markerKey } from '../src/sync/dedupe';
import { readSyncedIds } from '../src/vault/frontmatter';
import { SyncEngine } from '../src/sync/engine';
import { applyEntries, type NoteEntry } from '../src/vault/writer';
import type { MessageSource, PollResult } from '../src/telegram/types';
import type { SavedAttachment } from '../src/vault/attachments';
import type { Transcriber } from '../src/transcription';

/* ---------------- fakes ---------------- */

const fmt = (template: string, date: Date): string =>
  template
    .replace(/YYYY/g, String(date.getUTCFullYear()))
    .replace(/MM/g, String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/DD/g, String(date.getUTCDate()).padStart(2, '0'))
    .replace(/HH/g, String(date.getUTCHours()).padStart(2, '0'))
    .replace(/mm/g, String(date.getUTCMinutes()).padStart(2, '0'));

/** In-memory vault running the real `applyEntries`, so dedupe is exercised end to end. */
class FakeWriter {
  notes = new Map<string, string>();
  async appendEntries(path: string, heading: string, entries: NoteEntry[], seed = ''): Promise<number> {
    const base = this.notes.get(path) ?? seed;
    const { content, written } = applyEntries(base, heading, entries);
    this.notes.set(path, content);
    return written;
  }
  async recordedKeys(path: string): Promise<Set<string>> {
    const content = this.notes.get(path) ?? '';
    const keys = readSyncedIds(content);
    for (const key of extractMarkers(content)) keys.add(key);
    return keys;
  }
  /** The body, without the bookkeeping frontmatter. */
  body(path: string): string {
    const c = this.notes.get(path) ?? '';
    const parts = c.split('---\n');
    return parts.length >= 3 ? parts.slice(2).join('---\n') : c;
  }
}

/** TZ §7 Track B: the engine is tested against this, never against a real client. */
class FakeSource implements MessageSource {
  polls: Array<number | undefined> = [];
  constructor(private readonly results: Array<PollResult | Error>) {}
  status() {
    return 'connected' as const;
  }
  async connect() {
    return { displayName: 'fake' };
  }
  async disconnect() {}
  async wipe() {}
  async poll(cursor: number | undefined): Promise<PollResult> {
    this.polls.push(cursor);
    const next = this.results.shift();
    if (!next) return empty();
    if (next instanceof Error) throw next;
    return next;
  }
}

const empty = (): PollResult => ({ messages: [], cursor: undefined, skipped: { nonText: 0, foreignChat: 0 } });

const result = (
  messages: PollResult['messages'],
  cursor?: number,
  skipped = { nonText: 0, foreignChat: 0 },
): PollResult => ({ messages, cursor, skipped });

/** 2026-07-08 09:12 UTC */
const T = Date.UTC(2026, 6, 8, 9, 12) / 1000;

const message = (messageId: number, text: string, date = T) => ({ chatId: '555', messageId, date, text });

function build(
  results: Array<PollResult | Error>,
  overrides: Partial<Settings> = {},
  hooks: {
    save?: (m: unknown, notePath: string, includeData?: boolean) => Promise<SavedAttachment>;
    seed?: (date: Date) => Promise<string>;
    transcribe?: Transcriber['transcribe'];
  } = {},
) {
  const settings: Settings = { ...DEFAULT_SETTINGS, botToken: '123456:x', ...overrides };
  const writer = new FakeWriter();
  const source = new FakeSource(results);
  const onNotice = vi.fn();
  const engine = new SyncEngine({
    source,
    writer,
    settings: () => settings,
    persist: async (patch) => {
      Object.assign(settings, patch);
    },
    format: fmt,
    onNotice,
    attachments: { save: hooks.save ?? (async () => ({ line: '![[unexpected-attachment]]' })) },
    transcriber: { transcribe: hooks.transcribe ?? (async () => 'unexpected transcription') },
    seed: hooks.seed ?? (async () => ''),
  });
  return { engine, writer, source, settings, onNotice };
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
});

/* ---------------- tests ---------------- */

describe('SyncEngine — the core promise: one message, one entry', () => {
  it('writes a message into today’s note under the heading', async () => {
    const { engine, writer } = build([result([message(1, 'buy milk')], 2)]);
    const r = await engine.run('manual');

    expect(r).toEqual({ written: 1, skipped: { nonText: 0, foreignChat: 0, duplicate: 0 } });
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n**09:12** buy milk\n');
  });

  it('leaves no marker in the body', async () => {
    const { engine, writer } = build([result([message(1, 'buy milk')], 2)]);
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).not.toContain('%%');
  });

  it('records the id in frontmatter instead', async () => {
    const { engine, writer } = build([result([message(1, 'x')], 2)]);
    await engine.run('manual');
    expect(writer.notes.get('2026-07-08.md')).toContain('tg_ids:\n  - "555:1"');
  });

  it('honours a template with an emoji', async () => {
    const { engine, writer } = build([result([message(1, 'an idea')], 2)], {
      lineTemplate: '✏️ **{time}** {text}',
    });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toContain('✏️ **09:12** an idea');
  });

  it('honours the code block style', async () => {
    const { engine, writer } = build([result([message(1, 'an idea')], 2)], {
      blockStyle: 'code',
      lineTemplate: '{time} {text}',
    });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n```\n09:12 an idea\n```\n');
  });

  it('honours the callout style', async () => {
    const { engine, writer } = build([result([message(1, 'an idea')], 2)], {
      blockStyle: 'callout',
      calloutType: 'tip',
    });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n> [!tip]\n> **09:12** an idea\n');
  });

  it('separates consecutive messages with a blank line', async () => {
    const { engine, writer } = build([result([message(1, 'a'), message(2, 'b')], 3)]);
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n**09:12** a\n\n**09:12** b\n');
  });

  it('honours the folder and filename template', async () => {
    const { engine, writer } = build([result([message(1, 'hi')], 2)], {
      folder: 'Inbox/TG',
      filenameTemplate: 'YYYY/MM/DD',
    });
    await engine.run('manual');
    expect([...writer.notes.keys()]).toEqual(['Inbox/TG/2026/07/08.md']);
  });

  it('routes a Telegram hashtag to a configured note and removes the routing tag', async () => {
    const routed = {
      ...message(1, '#idea buy milk'),
      entities: [{ type: 'hashtag', offset: 0, length: 5 }],
    };
    const { engine, writer } = build([result([routed], 2)], {
      routes: [{ tag: 'idea', notePath: 'Inbox/Ideas.md', heading: '## Ideas' }],
    });
    await engine.run('manual');
    expect([...writer.notes.keys()]).toEqual(['Inbox/Ideas.md']);
    expect(writer.body('Inbox/Ideas.md')).toBe('## Ideas\n\n**09:12** buy milk\n');
  });

  it('falls back to the daily note when no route matches', async () => {
    const unrouted = {
      ...message(1, '#work buy milk'),
      entities: [{ type: 'hashtag', offset: 0, length: 5 }],
    };
    const { engine, writer } = build([result([unrouted], 2)], {
      routes: [{ tag: 'idea', notePath: 'Inbox/Ideas.md' }],
    });
    await engine.run('manual');
    expect([...writer.notes.keys()]).toEqual(['2026-07-08.md']);
    expect(writer.body('2026-07-08.md')).toContain('#work buy milk');
  });

  it('groups the same routed note by heading so each route keeps its section', async () => {
    const idea = {
      ...message(1, '#idea one'),
      entities: [{ type: 'hashtag', offset: 0, length: 5 }],
    };
    const task = {
      ...message(2, '#task two'),
      entities: [{ type: 'hashtag', offset: 0, length: 5 }],
    };
    const { engine, writer } = build([result([idea, task], 3)], {
      routes: [
        { tag: 'idea', notePath: 'Inbox.md', heading: '## Ideas' },
        { tag: 'task', notePath: 'Inbox.md', heading: '## Tasks' },
      ],
    });
    await engine.run('manual');
    expect(writer.body('Inbox.md')).toContain('## Ideas\n\n**09:12** one');
    expect(writer.body('Inbox.md')).toContain('## Tasks\n\n**09:12** two');
  });

  it('appends to a note the user already wrote in, without disturbing it', async () => {
    const { engine, writer } = build([result([message(1, 'from telegram')], 2)]);
    writer.notes.set('2026-07-08.md', '# Journal\n\nmy own thoughts\n');
    await engine.run('manual');
    const note = writer.notes.get('2026-07-08.md')!;
    expect(note).toContain('# Journal\n\nmy own thoughts\n\n## Telegram\n\n**09:12** from telegram\n');
  });

  it('splits a batch that straddles midnight across two notes', async () => {
    const before = Date.UTC(2026, 6, 8, 23, 59) / 1000;
    const after = Date.UTC(2026, 6, 9, 0, 1) / 1000;
    const { engine, writer } = build([result([message(1, 'late', before), message(2, 'early', after)], 3)]);
    await engine.run('manual');

    expect([...writer.notes.keys()].sort()).toEqual(['2026-07-08.md', '2026-07-09.md']);
    expect(writer.body('2026-07-08.md')).toContain('23:59** late');
    expect(writer.body('2026-07-09.md')).toContain('00:01** early');
  });

  it('keeps a multi-line message as one entry', async () => {
    const { engine, writer } = build([result([message(1, 'first\nsecond')], 2)]);
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n**09:12** first\nsecond\n');
  });

  it('sanitises a body that would hide the rest of the note', async () => {
    const { engine, writer } = build([result([message(1, '50%% off')], 2)]);
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).not.toContain('50%% off');
  });
});

describe('SyncEngine — deduplication', () => {
  it('does not rewrite a message already recorded in the note', async () => {
    const { engine, writer } = build([result([message(1, 'once')], 2), result([message(1, 'once')], 2)]);
    await engine.run('manual');
    const first = writer.notes.get('2026-07-08.md');
    const second = await engine.run('manual');

    expect(second).toEqual({ written: 0, skipped: { nonText: 0, foreignChat: 0, duplicate: 1 } });
    expect(writer.notes.get('2026-07-08.md')).toBe(first);
  });

  it('deduplicates against a note another device wrote, ignoring our cursor', async () => {
    // The scenario SPEC §5а exists for: phone synced, vault synced, desktop's
    // cursor is stale, desktop re-reads the same update.
    const { engine, writer } = build([result([message(7, 'from the phone')], 8)]);
    writer.notes.set('2026-07-08.md', '---\ntg_ids:\n  - "555:7"\n---\n## Telegram\n\nfrom the phone\n');

    const r = await engine.run('startup');
    expect(r?.written).toBe(0);
    expect(r?.skipped.duplicate).toBe(1);
  });

  it('deduplicates against a note written by the v1 marker format', async () => {
    const { engine, writer } = build([result([message(7, 'old')], 8)]);
    writer.notes.set('2026-07-08.md', '## Telegram\n- 09:12 old %%tg:555:7%%\n');
    expect((await engine.run('startup'))?.written).toBe(0);
  });

  it('deduplicates within a single batch', async () => {
    const { engine } = build([result([message(1, 'a'), message(1, 'a')], 2)]);
    expect(await engine.run('manual')).toEqual({
      written: 1,
      skipped: { nonText: 0, foreignChat: 0, duplicate: 1 },
    });
  });

  it('treats the same message id in different chats as different messages', async () => {
    const a = { chatId: '555', messageId: 1, date: T, text: 'a' };
    const b = { chatId: '999', messageId: 1, date: T, text: 'b' };
    expect((await build([result([a, b], 2)]).engine.run('manual'))?.written).toBe(2);
  });
});

describe('SyncEngine — cursor', () => {
  it('advances the cursor only after the lines are written', async () => {
    const { engine, settings } = build([result([message(1, 'x')], 42)]);
    await engine.run('manual');
    expect(settings.cursor).toBe(42);
  });

  it('leaves the cursor alone when the poll returned nothing', async () => {
    const { engine, settings } = build([empty()], { cursor: 7 });
    await engine.run('manual');
    expect(settings.cursor).toBe(7);
  });

  it('advances past a batch of only skipped messages — otherwise they redeliver forever', async () => {
    const { engine, settings } = build([result([], 99, { nonText: 3, foreignChat: 1 })]);
    const r = await engine.run('manual');
    expect(settings.cursor).toBe(99);
    expect(r?.skipped).toEqual({ nonText: 3, foreignChat: 1, duplicate: 0 });
  });

  it('does not advance the cursor when the write failed', async () => {
    const { engine, settings, writer } = build([result([message(1, 'x')], 42)], { cursor: 7 });
    writer.appendEntries = async () => {
      throw new Error('disk full');
    };
    await engine.run('manual');
    expect(settings.cursor).toBe(7); // the update will be re-fetched, as it must be
  });

  it('passes the stored cursor to the source', async () => {
    const { engine, source } = build([empty()], { cursor: 11 });
    await engine.run('manual');
    expect(source.polls).toEqual([11]);
  });
});

describe('SyncEngine — failure handling', () => {
  it('is a silent no-op when no token is configured', async () => {
    const { engine, source } = build([empty()], { botToken: '' });
    expect(await engine.run('startup')).toBeNull();
    expect(source.polls).toEqual([]);
  });

  it('is a silent no-op when offline — not an error every 30 seconds', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    const { engine, source, onNotice, settings } = build([empty()]);
    expect(await engine.run('interval')).toBeNull();
    expect(source.polls).toEqual([]);
    expect(onNotice).not.toHaveBeenCalled();
    expect(settings.lastSync).toBeNull();
  });

  it('swallows a 409 conflict: the other device is doing the work', async () => {
    const { engine, onNotice, settings } = build([errConflict()]);
    expect(await engine.run('interval')).toBeNull();
    expect(onNotice).not.toHaveBeenCalled();
    expect(settings.lastSync).toBeNull(); // not recorded as a failed sync
    expect(engine.error?.key).toBe('error.conflict');
  });

  it('swallows an offline error raised mid-poll', async () => {
    const { engine, onNotice } = build([errOffline()]);
    await engine.run('interval');
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('surfaces a bad token, because only the user can fix it', async () => {
    const { engine, onNotice, settings } = build([errInvalidToken()]);
    expect(await engine.run('interval')).toBeNull();
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect((onNotice.mock.calls[0][0] as HumanError).key).toBe('error.invalidToken');
    expect(settings.lastSync).toEqual({ at: expect.any(Number), ok: false, errorKey: 'error.invalidToken' });
  });

  it('records a successful sync', async () => {
    const { engine, settings } = build([result([message(1, 'x')], 2)]);
    await engine.run('manual');
    expect(settings.lastSync).toEqual({ at: expect.any(Number), ok: true, count: 1 });
  });

  it('clears the last error after a success', async () => {
    const { engine } = build([errInvalidToken(), result([message(1, 'x')], 2)]);
    await engine.run('interval');
    expect(engine.error).not.toBeNull();
    await engine.run('interval');
    expect(engine.error).toBeNull();
  });

  it('never throws, whatever the source does', async () => {
    await expect(build([new Error('kaboom')]).engine.run('manual')).resolves.toBeNull();
  });

  it('surfaces a bad filename template rather than crashing the timer', async () => {
    const { engine, onNotice } = build([result([message(1, 'x')], 2)], { filenameTemplate: '../oops' });
    expect(await engine.run('interval')).toBeNull();
    expect((onNotice.mock.calls[0][0] as HumanError).key).toBe('error.badTemplate');
  });
});

describe('SyncEngine — reentrancy', () => {
  it('refuses a second run while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const { engine, source } = build([]);
    source.poll = async () => {
      await gate;
      return empty();
    };

    const first = engine.run('interval');
    expect(engine.isRunning).toBe(true);
    expect(await engine.run('manual')).toBeNull(); // the timer fired mid-click

    release();
    await first;
    expect(engine.isRunning).toBe(false);
  });

  it('releases the guard even when the pass throws', async () => {
    const { engine } = build([new Error('kaboom')]);
    await engine.run('manual');
    expect(engine.isRunning).toBe(false);
    expect(await engine.run('manual')).toEqual({
      written: 0,
      skipped: { nonText: 0, foreignChat: 0, duplicate: 0 },
    });
  });
});

describe('SyncEngine — attachments', () => {
  const withPhoto = (messageId: number, text: string) => ({
    chatId: '555',
    messageId,
    date: T,
    text,
    attachment: { kind: 'photo' as const, fileId: 'f1' },
  });

  it('appends the line the attachment sink returns', async () => {
    const { engine, writer } = build([result([withPhoto(1, 'sunset')], 2)], {}, {
      save: async () => ({ line: '![[Files/TG-42.jpg]]' }),
    });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n**09:12** sunset\n![[Files/TG-42.jpg]]\n');
  });

  it('hands the sink the message and the destination note path', async () => {
    const seen: string[] = [];
    const { engine } = build([result([withPhoto(1, '')], 2)], { folder: 'Inbox' }, {
      save: async (_m, notePath) => {
        seen.push(notePath);
        return { line: '![[x.jpg]]' };
      },
    });
    await engine.run('manual');
    expect(seen).toEqual(['Inbox/2026-07-08.md']);
  });

  it('does not advance the cursor when a download fails — the message must be retried', async () => {
    const { engine, settings } = build([result([withPhoto(1, '')], 42)], { cursor: 7 }, {
      save: async () => {
        throw new Error('network died mid-download');
      },
    });
    await engine.run('manual');
    expect(settings.cursor).toBe(7);
  });

  it('transcribes voice bytes once and writes the transcript below the embed', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const includeData: boolean[] = [];
    const transcribe = vi.fn(async () => 'remember the milk');
    const { engine, writer } = build(
      [result([voice], 2)],
      { transcriptionEnabled: true, transcriptionApiKey: 'key' },
      {
        save: async (_m, _path, include) => {
          includeData.push(include ?? false);
          return { line: '![[voice.oga]]', fileName: 'voice.oga', data: new ArrayBuffer(3) };
        },
        transcribe,
      },
    );
    await engine.run('manual');
    expect(includeData).toEqual([true]);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(writer.body('2026-07-08.md')).toBe(
      '## Telegram\n\n**09:12**\n![[voice.oga]]\n🎙️ remember the milk\n',
    );
  });

  it('falls back to the daily note and keeps syncing when a saved route path is invalid', async () => {
    const msg = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '#idea hello',
      entities: [{ type: 'hashtag' as const, offset: 0, length: 5 }],
    };
    const { engine, writer, settings, onNotice } = build([result([msg], 9)], {
      routes: [{ tag: 'idea', notePath: 'Bad [path]' }],
    });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toContain('hello');
    expect(settings.cursor).toBe(9);
    expect(onNotice.mock.calls[0][0]).toMatchObject({ key: 'error.badTemplate' });
  });

  it('seeds a routed note with the daily template when the route lands on the daily note', async () => {
    const msg = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '#log hi',
      entities: [{ type: 'hashtag' as const, offset: 0, length: 4 }],
    };
    const { engine, writer } = build(
      [result([msg], 2)],
      { routes: [{ tag: 'log', notePath: 'YYYY-MM-DD' }] },
      { seed: async () => '# Template\n' },
    );
    await engine.run('manual');
    expect(writer.notes.get('2026-07-08.md')).toContain('# Template');
  });

  it('rethrows retryable transcription errors so the batch retries with the cursor unmoved', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const { engine, writer, settings } = build(
      [result([voice], 2)],
      { cursor: 1, transcriptionEnabled: true, transcriptionApiKey: 'key' },
      {
        save: async () => ({ line: '![[v.oga]]', fileName: 'v.oga', data: new ArrayBuffer(1) }),
        transcribe: async () => {
          throw errRateLimited(30);
        },
      },
    );
    await engine.run('manual');
    expect(settings.cursor).toBe(1);
    expect(writer.notes.size).toBe(0);
  });

  it('does not re-transcribe a message already recorded in the note', async () => {
    const voice = {
      chatId: '555',
      messageId: 7,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const transcribe = vi.fn(async () => 'should not be called');
    const { engine, writer } = build(
      [result([voice], 2)],
      { transcriptionEnabled: true, transcriptionApiKey: 'key' },
      {
        save: async () => ({ line: '![[v.oga]]', fileName: 'v.oga', data: new ArrayBuffer(1) }),
        transcribe,
      },
    );
    await writer.appendEntries('2026-07-08.md', '## Telegram', [
      { key: markerKey({ chatId: '555', messageId: 7 }), lines: ['**09:12**', '![[v.oga]]'] },
    ]);
    await engine.run('manual');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('writes no transcript line and no notice when the transcript is empty', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const { engine, writer, onNotice } = build(
      [result([voice], 2)],
      { transcriptionEnabled: true, transcriptionApiKey: 'key' },
      {
        save: async () => ({ line: '![[voice.oga]]', fileName: 'voice.oga', data: new ArrayBuffer(3) }),
        transcribe: async () => '',
      },
    );
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toBe('## Telegram\n\n**09:12**\n![[voice.oga]]\n');
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('keeps the embed, advances the cursor and reports a transcription failure', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const { engine, writer, settings, onNotice } = build(
      [result([voice], 2)],
      { transcriptionEnabled: true, transcriptionApiKey: 'key' },
      {
        save: async () => ({ line: '![[voice.oga]]', fileName: 'voice.oga', data: new ArrayBuffer(3) }),
        transcribe: async () => {
          throw new HumanError('error.transcriptionFailed', { reason: 'HTTP 500' });
        },
      },
    );
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toContain('![[voice.oga]]');
    expect(settings.cursor).toBe(2);
    expect(onNotice.mock.calls[0][0]).toMatchObject({ key: 'error.transcriptionFailed' });
  });

  it('sanitises and correctly wraps multi-line transcripts in a callout', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const { engine, writer } = build(
      [result([voice], 2)],
      {
        transcriptionEnabled: true,
        transcriptionApiKey: 'key',
        blockStyle: 'callout',
      },
      {
        save: async () => ({ line: '![[voice.oga]]', fileName: 'voice.oga', data: new ArrayBuffer(3) }),
        transcribe: async () => 'first line\n50%% off',
      },
    );
    await engine.run('manual');
    const body = writer.body('2026-07-08.md');
    expect(body).toContain('> ![[voice.oga]]\n> 🎙️ first line\n> 50%​% off');
    expect(body).not.toContain('50%% off');
  });

  it('does not request bytes or STT while transcription is disabled', async () => {
    const voice = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: '',
      attachment: { kind: 'voice' as const, fileId: 'v1' },
    };
    const includeData: boolean[] = [];
    const transcribe = vi.fn(async () => 'unused');
    const { engine } = build([result([voice], 2)], {}, {
      save: async (_m, _path, include) => {
        includeData.push(include ?? false);
        return { line: '![[voice.oga]]' };
      },
      transcribe,
    });
    await engine.run('manual');
    expect(includeData).toEqual([false]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('converts entities to Markdown on the way in', async () => {
    const m = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: 'bold text',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    };
    const { engine, writer } = build([result([m], 2)]);
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toContain('**bold** text');
  });

  it('keeps the raw text in code block style, where Markdown is inert', async () => {
    const m = {
      chatId: '555',
      messageId: 1,
      date: T,
      text: 'bold text',
      entities: [{ type: 'bold', offset: 0, length: 4 }],
    };
    const { engine, writer } = build([result([m], 2)], { blockStyle: 'code', lineTemplate: '{time} {text}' });
    await engine.run('manual');
    expect(writer.body('2026-07-08.md')).toContain('bold text');
    expect(writer.body('2026-07-08.md')).not.toContain('**bold**');
  });
});

describe('SyncEngine — note seeding', () => {
  it('seeds a brand-new note with the template content', async () => {
    const { engine, writer } = build([result([message(1, 'hi')], 2)], {}, {
      seed: async () => '# 2026-07-08\n\ndaily template body\n',
    });
    await engine.run('manual');
    const body = writer.body('2026-07-08.md');
    expect(body).toContain('daily template body');
    expect(body).toContain('## Telegram\n\n**09:12** hi');
  });

  it('never seeds an existing note', async () => {
    const { engine, writer } = build([result([message(1, 'hi')], 2)], {}, {
      seed: async () => 'TEMPLATE',
    });
    writer.notes.set('2026-07-08.md', '# already here\n');
    await engine.run('manual');
    expect(writer.notes.get('2026-07-08.md')).not.toContain('TEMPLATE');
  });

  it('seeds with the date of the messages, not today', async () => {
    const seen: Date[] = [];
    const yesterday = Date.UTC(2026, 6, 7, 22, 0) / 1000;
    const { engine } = build([result([message(1, 'x', yesterday)], 2)], {}, {
      seed: async (d) => {
        seen.push(d);
        return '';
      },
    });
    await engine.run('manual');
    expect(seen[0].getTime()).toBe(yesterday * 1000);
  });
});
