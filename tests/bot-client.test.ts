import { describe, expect, it } from 'vitest';
import { parseUpdates } from '../src/telegram/bot-client';

const msg = (updateId: number, chatId: number, messageId: number, text?: string, date = 1_700_000_000) => ({
  update_id: updateId,
  message: { message_id: messageId, date, chat: { id: chatId }, ...(text === undefined ? {} : { text }) },
});

describe('parseUpdates — binding', () => {
  it('binds to the first chat that speaks', () => {
    const r = parseUpdates([msg(1, 555, 10, 'hi')], null);
    expect(r.newBinding).toBe('555');
    expect(r.messages).toHaveLength(1);
  });

  it('does not re-bind once bound', () => {
    const r = parseUpdates([msg(1, 555, 10, 'hi')], '555');
    expect(r.newBinding).toBeUndefined();
  });

  it('binds once, then filters the rest of the same batch', () => {
    const r = parseUpdates([msg(1, 555, 10, 'mine'), msg(2, 999, 11, 'stranger')], null);
    expect(r.newBinding).toBe('555');
    expect(r.messages.map((m) => m.messageId)).toEqual([10]);
    expect(r.skipped.foreignChat).toBe(1);
  });

  it('ignores a stranger entirely when already bound', () => {
    const r = parseUpdates([msg(1, 999, 10, 'stranger')], '555');
    expect(r.messages).toHaveLength(0);
    expect(r.skipped.foreignChat).toBe(1);
  });

  it('handles negative chat ids (groups)', () => {
    const r = parseUpdates([msg(1, -1001234, 10, 'hi')], null);
    expect(r.newBinding).toBe('-1001234');
    expect(r.messages[0].chatId).toBe('-1001234');
  });
});

describe('parseUpdates — cursor', () => {
  it('is undefined for an empty batch, so a good cursor is never clobbered', () => {
    expect(parseUpdates([], '555').cursor).toBeUndefined();
  });

  it('advances past the last update', () => {
    expect(parseUpdates([msg(7, 555, 1, 'a'), msg(8, 555, 2, 'b')], '555').cursor).toBe(9);
  });

  it('advances past messages we ignore — otherwise Telegram redelivers them forever', () => {
    const r = parseUpdates([msg(4, 999, 1, 'stranger')], '555');
    expect(r.messages).toHaveLength(0);
    expect(r.cursor).toBe(5);
  });

  it('advances past non-text messages', () => {
    const r = parseUpdates([msg(4, 555, 1, undefined)], '555');
    expect(r.skipped.nonText).toBe(1);
    expect(r.cursor).toBe(5);
  });

  it('advances past updates with no message at all', () => {
    expect(parseUpdates([{ update_id: 12 }], '555').cursor).toBe(13);
  });
});

describe('parseUpdates — content', () => {
  it('skips a message with no text field', () => {
    const r = parseUpdates([msg(1, 555, 10, undefined)], '555');
    expect(r.skipped.nonText).toBe(1);
    expect(r.messages).toHaveLength(0);
  });

  it('skips a whitespace-only message', () => {
    expect(parseUpdates([msg(1, 555, 10, '   \n ')], '555').skipped.nonText).toBe(1);
  });

  it('keeps text verbatim, including newlines — sanitising happens at render', () => {
    const r = parseUpdates([msg(1, 555, 10, 'a\nb  ')], '555');
    expect(r.messages[0].text).toBe('a\nb  ');
  });

  it('carries the unix date through unchanged', () => {
    expect(parseUpdates([msg(1, 555, 10, 'x', 1_234_567)], '555').messages[0].date).toBe(1_234_567);
  });

  it('survives a malformed update without a chat', () => {
    const bad = { update_id: 1, message: { message_id: 1, date: 1, text: 'x' } } as never;
    const r = parseUpdates([bad], '555');
    expect(r.messages).toHaveLength(0);
    expect(r.cursor).toBe(2);
  });
});

describe('parseUpdates — attachments', () => {
  const media = (updateId: number, messageId: number, fields: Record<string, unknown>) => ({
    update_id: updateId,
    message: { message_id: messageId, date: 1_700_000_000, chat: { id: 555 }, ...fields },
  });

  it('turns a photo with a caption into a message with an attachment', () => {
    const r = parseUpdates(
      [
        media(1, 10, {
          caption: 'sunset',
          photo: [
            { file_id: 'small', file_size: 100, width: 90, height: 60 },
            { file_id: 'big', file_size: 900, width: 900, height: 600 },
          ],
        }),
      ],
      '555',
    );
    expect(r.skipped.nonText).toBe(0);
    expect(r.messages[0].text).toBe('sunset');
    expect(r.messages[0].attachment).toEqual({ kind: 'photo', fileId: 'big', fileSize: 900 });
  });

  it('keeps a captionless photo — the embed is the content', () => {
    const r = parseUpdates([media(1, 10, { photo: [{ file_id: 'p', width: 1, height: 1 }] })], '555');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].text).toBe('');
  });

  it('carries caption_entities as the message entities', () => {
    const r = parseUpdates(
      [media(1, 10, { caption: 'bold cap', caption_entities: [{ type: 'bold', offset: 0, length: 4 }], photo: [{ file_id: 'p', width: 1, height: 1 }] })],
      '555',
    );
    expect(r.messages[0].entities).toEqual([{ type: 'bold', offset: 0, length: 4 }]);
  });

  it('takes a document’s original file name', () => {
    const r = parseUpdates(
      [media(1, 10, { document: { file_id: 'd', file_name: 'report.pdf', file_size: 5 } })],
      '555',
    );
    expect(r.messages[0].attachment).toEqual({ kind: 'document', fileId: 'd', fileName: 'report.pdf', fileSize: 5 });
  });

  it('classifies an animation as its own kind, not as its legacy document twin', () => {
    const r = parseUpdates(
      [media(1, 10, { animation: { file_id: 'a' }, document: { file_id: 'a-doc' } })],
      '555',
    );
    expect(r.messages[0].attachment?.fileId).toBe('a');
  });

  it('maps voice, audio, video and video_note', () => {
    const kinds = [
      { fields: { voice: { file_id: 'v' } }, kind: 'voice' },
      { fields: { audio: { file_id: 'a' } }, kind: 'audio' },
      { fields: { video: { file_id: 'vd' } }, kind: 'video' },
      { fields: { video_note: { file_id: 'vn' } }, kind: 'video_note' },
    ];
    for (const k of kinds) {
      const r = parseUpdates([media(1, 10, k.fields)], '555');
      expect(r.messages[0].attachment?.kind).toBe(k.kind);
    }
  });

  it('still skips stickers, polls and the like', () => {
    const r = parseUpdates(
      [media(1, 10, { sticker: { file_id: 's' } }), media(2, 11, { poll: { id: 'p' } })],
      '555',
    );
    expect(r.messages).toHaveLength(0);
    expect(r.skipped.nonText).toBe(2);
    expect(r.cursor).toBe(3);
  });

  it('carries text entities on a plain text message', () => {
    const r = parseUpdates(
      [media(1, 10, { text: 'bold text', entities: [{ type: 'bold', offset: 0, length: 4 }] })],
      '555',
    );
    expect(r.messages[0].entities).toEqual([{ type: 'bold', offset: 0, length: 4 }]);
  });
});
