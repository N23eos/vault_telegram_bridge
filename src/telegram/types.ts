/**
 * Transport contracts. TZ §4.
 *
 * Nothing below mentions bots or MTProto. `BotClient` implements `MessageSource`
 * in v0.1; a GramJS client implements the same interface in v0.3 and
 * `sync/engine.ts` never learns the difference. See docs/ADR-001-bot-mode-first.md.
 *
 * Changing anything in this file is a BREAKING commit.
 */

/** Identifies a message globally. A message id is unique per chat, not per account. */
export interface MsgRef {
  chatId: string;
  messageId: number;
}

/**
 * One formatting span, as Telegram reports it. `offset`/`length` are UTF-16
 * code units — the same units JavaScript strings index by.
 */
export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  /** Only on `text_link`. */
  url?: string;
  /** Only on `pre`. */
  language?: string;
}

/** What kind of file rode along with the message. */
export type AttachmentKind = 'photo' | 'voice' | 'audio' | 'video' | 'video_note' | 'document';

export interface TgAttachment {
  kind: AttachmentKind;
  /** Telegram's opaque file id, exchanged for a download path via `getFile`. */
  fileId: string;
  /** Original name, when Telegram preserves one (documents, audio, video). */
  fileName?: string;
  /** Bytes, when Telegram reports it. Used to refuse >20 MB before a doomed round-trip. */
  fileSize?: number;
}

/** A message, normalised. For a media message `text` is the caption, possibly empty. */
export interface InboundMessage extends MsgRef {
  /** Unix seconds, as Telegram reports it. Local-time formatting happens in the writer. */
  date: number;
  text: string;
  /** Formatting spans over `text`. Absent means plain. */
  entities?: TgEntity[];
  attachment?: TgAttachment;
}

/** What `getFile` reveals about an attachment before any bytes move. */
export interface ResolvedFile {
  /** The server path the file endpoint wants. */
  filePath: string;
  /** `.jpg`, `.oga`, … — lower-case, with the dot. `''` when the server path had none. */
  ext: string;
}

export type SourceStatus = 'disconnected' | 'connecting' | 'connected' | 'auth_required';

export interface SourceIdentity {
  /** What to show the user so they know which bot/account is connected. */
  displayName: string;
}

/**
 * The result of one poll.
 *
 * `cursor` is what gets persisted and sent back on the next call. It is an
 * optimisation, never the source of truth: two devices sharing a vault keep
 * independent cursors, so deduplication is done by markers in the note itself
 * (SPEC §5а). A lost or stale cursor costs a re-read, never a duplicate.
 */
export interface PollResult {
  messages: InboundMessage[];
  cursor: number | undefined;
  /** Updates we understood but chose not to write: non-text, wrong chat. Counted for the UI, never logged. */
  skipped: { nonText: number; foreignChat: number };
}

export interface MessageSource {
  status(): SourceStatus;

  /** Validate credentials and learn who we are. Throws HumanError. */
  connect(): Promise<SourceIdentity>;

  /** Release sockets and timers. Safe to call when never connected. */
  disconnect(): Promise<void>;

  /**
   * Fetch whatever is new since `cursor`. Rate limits and transient conflicts
   * are handled inside the implementation; a rejection here is a real failure
   * the user must see.
   */
  poll(cursor: number | undefined): Promise<PollResult>;

  /** Revoke/forget credentials locally. Does not delete anything in the vault. */
  wipe(): Promise<void>;
}
