import { normalizePath, TFile, type App } from 'obsidian';
import { isRetryable, toHumanError } from '../errors';
import { t } from '../i18n';
import type { InboundMessage, ResolvedFile } from '../telegram/types';
import { parentFolderOf } from './daily-note';

/**
 * Getting one attachment from Telegram's cloud into the vault. SPEC v0.2.
 *
 * The contract with the engine is one string: the Markdown line that represents
 * the attachment in the note — an `![[embed]]` on success, a placeholder when
 * the file cannot ever arrive. The error policy is the load-bearing part:
 *
 *   - *retryable* failures (offline, network, rate limit, conflict) are thrown;
 *     the engine's cursor logic re-fetches the whole batch next tick;
 *   - *everything else* becomes a placeholder line. A permanently refused file
 *     that kept throwing would abort every pass before the cursor persist and
 *     wedge the pipeline on one poisoned message forever — the message and the
 *     file are still safe in the Telegram chat, and the placeholder says so.
 *
 * File names are deterministic per message, and the bytes are fetched only
 * after the vault is checked for a file with that name. A pass that crashed
 * between the binary write and the note write finds its own file — anywhere in
 * the vault, even if the attachment-folder setting resolved differently — and
 * skips both the transfer and the write.
 */

export interface AttachmentSink {
  /** The Markdown line and, on request, bytes for STT. Throws only what is worth retrying. */
  save(m: InboundMessage, notePath: string, includeData?: boolean): Promise<SavedAttachment>;
}

export interface SavedAttachment {
  line: string;
  /** Present only when requested and a real file was available. */
  data?: ArrayBuffer;
  fileName?: string;
}

/** The Bot API's documented ceiling for `getFile`. */
export const MAX_BOT_FILE_BYTES = 20 * 1024 * 1024;

/** Mirrors `ILLEGAL_IN_FILENAME` in daily-note.ts, plus the path separators an original name must not smuggle in. */
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

/**
 * `TG-<date>-<messageId><ext>`, or `<original stem> TG-<messageId><ext>` when
 * Telegram preserved an original name (documents, audio). The `TG-<messageId>`
 * suffix is the determinism; the stem is for the human scanning a folder.
 * Leading dots are stripped — a `.env` must not become a hidden vault file.
 */
export function attachmentFileName(m: InboundMessage, dateStr: string, serverExt: string): string {
  const original = m.attachment?.fileName?.trim() ?? '';
  const dot = original.lastIndexOf('.');
  const stem = (dot > 0 ? original.slice(0, dot) : original)
    .replace(ILLEGAL, '')
    .replace(/^\.+/, '')
    .trim();
  const originalExtension = dot > 0 ? original.slice(dot).replace(ILLEGAL, '') : '';
  const ext = originalExtension || serverExt;

  if (stem !== '') return `${stem} TG-${m.messageId}${ext}`;
  return `TG-${dateStr}-${m.messageId}${ext}`;
}

/** `.pdf` from `report.pdf`; `''` when the original name is absent or extension-less. */
export function originalExt(m: InboundMessage): string {
  const original = m.attachment?.fileName?.trim() ?? '';
  const dot = original.lastIndexOf('.');
  return dot > 0 ? original.slice(dot).replace(ILLEGAL, '') : '';
}

export function embedLine(path: string): string {
  return `![[${path}]]`;
}

export interface VaultAttachmentDeps {
  app: App;
  /** `getFile`: exchanges the id for a server path and extension. Cheap. */
  resolve: (fileId: string) => Promise<ResolvedFile>;
  /** The byte transfer. Expensive — called only after the vault checks come up empty. */
  fetch: (filePath: string) => Promise<ArrayBuffer>;
  /** Renders `YYYY-MM-DD` for the file name. Injected for the same reason daily-note.ts injects it. */
  format: (template: string, date: Date) => string;
}

export class VaultAttachmentStore implements AttachmentSink {
  constructor(private readonly deps: VaultAttachmentDeps) {}

  async save(m: InboundMessage, notePath: string, includeData = false): Promise<SavedAttachment> {
    const a = m.attachment;
    if (!a) return { line: '' };

    // Known-oversize: skip the doomed round-trip entirely.
    if (a.fileSize !== undefined && a.fileSize > MAX_BOT_FILE_BYTES) {
      return { line: t('entry.attachmentTooBig') };
    }

    try {
      // The name needs an extension; `getFile` is called only when the original
      // name does not already carry one.
      let resolved: ResolvedFile | null = null;
      let ext = originalExt(m);
      if (ext === '') {
        resolved = await this.deps.resolve(a.fileId);
        ext = resolved.ext;
      }

      const name = attachmentFileName(m, this.deps.format('YYYY-MM-DD', new Date(m.date * 1000)), ext);

      // Already in the vault — at today's target, or anywhere else if the
      // attachment-folder setting resolved differently last pass.
      const target = await this.targetPath(name, notePath);
      const existing = this.findByName(name, target);
      if (existing !== null) {
        const data = includeData ? await this.deps.app.vault.readBinary(existing) : undefined;
        return { line: embedLine(existing.path), fileName: name, ...(data ? { data } : {}) };
      }

      if (!resolved) resolved = await this.deps.resolve(a.fileId);
      const data = await this.deps.fetch(resolved.filePath);

      await this.ensureFolder(parentFolderOf(target));
      await this.deps.app.vault.createBinary(target, data);
      return { line: embedLine(target), fileName: name, ...(includeData ? { data } : {}) };
    } catch (e) {
      const err = toHumanError(e);
      if (err.key === 'error.fileTooBig') return { line: t('entry.attachmentTooBig') };
      if (isRetryable(err)) throw err;
      return { line: t('entry.attachmentFailed') };
    }
  }

  /** The exact target first, then the whole vault — the deterministic name is unique per message. */
  private findByName(name: string, target: string): TFile | null {
    const atTarget = this.deps.app.vault.getAbstractFileByPath(target);
    if (atTarget instanceof TFile) return atTarget;
    const elsewhere = this.deps.app.vault.getFiles().find((f) => f.name === name);
    return elsewhere ?? null;
  }

  /**
   * The user's own "attachment folder" setting decides *where*; our
   * deterministic name decides *what*. `getAvailablePathForAttachment` is asked
   * only for the folder — its de-duplicating suffix (`name 1.jpg`) is exactly
   * what idempotence must avoid.
   */
  private async targetPath(name: string, notePath: string): Promise<string> {
    const available = await this.deps.app.fileManager.getAvailablePathForAttachment(name, notePath);
    const folder = parentFolderOf(available);
    return normalizePath(folder === '' ? name : `${folder}/${name}`);
  }

  private async ensureFolder(folder: string): Promise<void> {
    if (folder === '' || this.deps.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.deps.app.vault.createFolder(folder);
    } catch {
      // Racing another device's sync is a success, not a failure.
      if (!this.deps.app.vault.getAbstractFileByPath(folder)) throw new Error(`cannot create folder ${folder}`);
    }
  }
}
