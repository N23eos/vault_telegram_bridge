import { HumanError, isRetryable, toHumanError } from '../errors';
import { t } from '../i18n';
import { entitiesToMarkdown } from '../telegram/entities';
import type { InboundMessage, MessageSource } from '../telegram/types';
import type { Settings } from '../settings';
import type { AttachmentSink } from '../vault/attachments';
import { resolveDailyNotePath, type DateFormatter } from '../vault/daily-note';
import type { NoteEntry, NoteWriter } from '../vault/writer';
import type { Transcriber } from '../transcription';
import { markerKey } from './dedupe';
import { renderEntry } from './render';
import { routeMessage } from './routing';

/**
 * Orchestration. TZ §5.4. The only module that knows about both a `MessageSource`
 * and a `NoteWriter`; neither knows about the other.
 */

export interface SyncResult {
  written: number;
  skipped: { nonText: number; foreignChat: number; duplicate: number };
}

export interface EngineDeps {
  source: MessageSource;
  writer: NoteWriter;
  settings: () => Settings;
  /** Persist cursor and lastSync. Called at most once per run. */
  persist: (patch: Partial<Settings>) => Promise<void>;
  format: DateFormatter;
  onNotice: (e: HumanError) => void;
  /** Download-and-store for media messages. Returns the entry's attachment line. */
  attachments: AttachmentSink;
  /** Optional STT transport; settings still decide whether it is called. */
  transcriber: Transcriber;
  /**
   * Initial content for a note that does not exist yet — the daily-note
   * template, rendered for the given day. `''` means create empty, as before.
   */
  seed: (date: Date) => Promise<string>;
}

export class SyncEngine {
  /** Reentrancy guard. A 30 s timer and a "Sync now" click will collide. */
  private running = false;
  private lastError: HumanError | null = null;

  constructor(private readonly deps: EngineDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get error(): HumanError | null {
    return this.lastError;
  }

  /**
   * One sync pass. Never throws: a failure becomes `lastError` plus, for anything
   * the user can act on, a Notice.
   *
   * Returns `null` when the pass was skipped — already running, no token, or
   * offline. A skip is not a failure and must not overwrite `lastSync`.
   */
  async run(trigger: 'interval' | 'manual' | 'startup'): Promise<SyncResult | null> {
    if (this.running) return null;

    const settings = this.deps.settings();
    if (!settings.botToken) return null;
    if (!navigator.onLine) {
      // Silent skip, per TZ §5.4. Every 30 s on a train is not a notification.
      return null;
    }

    this.running = true;
    try {
      const result = await this.pass();
      this.lastError = null;
      await this.deps.persist({ lastSync: { at: Date.now(), ok: true, count: result.written } });
      return result;
    } catch (e) {
      const err = toHumanError(e);
      this.lastError = err;

      // A conflict means the other device is doing the work. Offline means try
      // again in thirty seconds. Neither is worth a popup, and neither is worth
      // recording as a failed sync.
      if (!isRetryable(err)) {
        this.deps.onNotice(err);
        await this.deps.persist({ lastSync: { at: Date.now(), ok: false, errorKey: err.key } });
      }
      return null;
    } finally {
      this.running = false;
      void trigger;
    }
  }

  private async pass(): Promise<SyncResult> {
    const settings = this.deps.settings();
    const { messages, cursor, skipped } = await this.deps.source.poll(settings.cursor);

    if (messages.length === 0) {
      // Still advance: the batch may have been all non-text or all foreign, and
      // an unconfirmed update is redelivered forever.
      if (cursor !== undefined) await this.deps.persist({ cursor });
      return { written: 0, skipped: { ...skipped, duplicate: 0 } };
    }

    let written = 0;
    let duplicate = 0;

    // Messages sent either side of midnight belong to different notes. Group by
    // destination so each note is opened and written exactly once.
    for (const group of this.groupByNote(messages)) {
      // Deduplication happens inside the writer, against the note as it exists at
      // the instant of the write. Doing it here, against content read a moment
      // earlier, is how a note that arrived over vault sync in between produces
      // duplicates.
      //
      // Attachments download *before* that dedup check, so a stale-cursor
      // re-read re-downloads the bytes once. The deterministic file name makes
      // that harmless — same path, already on disk, no second copy.
      const entries: NoteEntry[] = [];
      for (const m of group.messages) entries.push(await this.toEntry(m, group.path));

      const seed = group.routed ? '' : await this.deps.seed(new Date(group.messages[0].date * 1000));
      const count = await this.deps.writer.appendEntries(group.path, group.heading, entries, seed);
      written += count;
      duplicate += entries.length - count;
    }

    // The cursor moves only after every line is on disk. Crash halfway and the
    // next pass re-reads those updates, finds them recorded, and writes nothing.
    if (cursor !== undefined) await this.deps.persist({ cursor });

    return { written, skipped: { ...skipped, duplicate } };
  }

  private groupByNote(messages: InboundMessage[]): DestinationGroup[] {
    const settings = this.deps.settings();
    const groups = new Map<string, DestinationGroup>();

    for (const m of messages) {
      const when = new Date(m.date * 1000);
      const routed = routeMessage(m.text, m.entities, settings.routes, when, this.deps.format);
      const path = routed?.path ?? resolveDailyNotePath(settings, when, this.deps.format);
      const heading = routed?.heading ?? settings.heading;
      const message = routed ? { ...m, text: routed.text, entities: routed.entities } : m;
      const key = JSON.stringify([path, heading]);
      const bucket = groups.get(key);
      if (bucket) bucket.messages.push(message);
      else groups.set(key, { path, heading, messages: [message], routed: routed !== undefined });
    }
    return [...groups.values()];
  }

  private async toEntry(m: InboundMessage, notePath: string): Promise<NoteEntry> {
    const s = this.deps.settings();
    const when = new Date(m.date * 1000);

    // Inside a code fence Markdown is inert, so converted `**bold**` would show
    // its asterisks — the raw text reads better there.
    const text = s.blockStyle === 'code' ? m.text : entitiesToMarkdown(m.text, m.entities);
    const wantsTranscription =
      s.transcriptionEnabled &&
      s.transcriptionApiKey !== '' &&
      m.attachment !== undefined &&
      isTranscribable(m.attachment.kind);
    const saved = m.attachment
      ? await this.deps.attachments.save(m, notePath, wantsTranscription)
      : undefined;
    const attachmentLines = saved ? [saved.line] : [];

    if (wantsTranscription && saved?.data && saved.fileName) {
      try {
        const transcript = await this.deps.transcriber.transcribe(
          { data: saved.data, fileName: saved.fileName },
          {
            baseUrl: s.transcriptionBaseUrl,
            apiKey: s.transcriptionApiKey,
            model: s.transcriptionModel,
          },
        );
        attachmentLines.push(t('entry.transcription', { text: transcript }));
      } catch (error) {
        this.deps.onNotice(
          error instanceof HumanError
            ? error
            : new HumanError('error.transcriptionFailed', { reason: 'unexpected error' }, error),
        );
      }
    }

    const lines = renderEntry(
      text,
      { template: s.lineTemplate, blockStyle: s.blockStyle, calloutType: s.calloutType },
      { time: this.deps.format('HH:mm', when), date: this.deps.format('YYYY-MM-DD', when) },
      attachmentLines,
    );
    return { key: markerKey(m), lines };
  }
}

function isTranscribable(kind: NonNullable<InboundMessage['attachment']>['kind']): boolean {
  return kind === 'voice' || kind === 'audio' || kind === 'video_note';
}

interface DestinationGroup {
  path: string;
  heading: string;
  messages: InboundMessage[];
  routed: boolean;
}
