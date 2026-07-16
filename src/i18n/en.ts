/**
 * The single source of user-visible strings. TZ §1: no hardcoded strings in
 * components, from the first commit. `en` is the schema — `I18nKey` is derived
 * from it, so a missing key in a translation is a type error, not a runtime
 * fallback to English.
 *
 * `{placeholders}` are substituted by `t()`.
 */
export const en = {
  // --- plugin ---
  'plugin.name': 'Vault Telegram Bridge',

  // --- connection ---
  'conn.status.disconnected': 'Not connected',
  'conn.status.connecting': 'Connecting…',
  'conn.status.connected': 'Connected as @{name}',
  'conn.status.authRequired': 'Bot token missing or invalid',

  // --- settings: connection ---
  'settings.token.name': 'Bot token',
  'settings.token.desc':
    'Create a bot with @BotFather in Telegram and paste the token here. The token is stored in this plugin’s data.json, inside your Obsidian config folder.',
  'settings.token.placeholder': '123456789:AA…',
  'settings.token.connect': 'Connect',
  'settings.token.connected': 'Connected to @{name}',

  'settings.disconnect.name': 'Disconnect and forget token',
  'settings.disconnect.desc':
    'Removes the token from this vault. To disable the bot everywhere, also send /revoke to @BotFather.',
  'settings.disconnect.button': 'Disconnect',
  'settings.disconnect.done': 'Token removed. Revoke it in @BotFather if you no longer need the bot.',

  'settings.boundChat.name': 'Bound chat',
  'settings.boundChat.desc':
    'Anyone who knows your bot’s username can message it. The first chat that writes to the bot is bound, and messages from every other chat are ignored.',
  'settings.boundChat.none': 'Not bound yet — send your bot a message.',
  'settings.boundChat.bound': 'Bound to chat {chatId}',
  'settings.boundChat.reset': 'Unbind',
  'settings.boundChat.resetDone': 'Unbound. The next chat that writes to the bot will be bound.',

  // --- settings: destination ---
  'settings.section.destination': 'Where messages go',
  'settings.coreDaily.name': 'Use core Daily Notes',
  'settings.coreDaily.desc':
    'Write into the daily note the core Daily Notes plugin owns — its folder, note name and template. The folder and note name fields are hidden while this is on; the heading still applies.',
  'settings.coreDaily.unavailable':
    'The core Daily Notes plugin is disabled, so the folder and note name below are used until it comes back.',
  'settings.folder.name': 'Folder',
  'settings.folder.desc': 'Leave empty for the vault root.',
  'settings.folder.placeholder': 'Inbox/Telegram',

  'settings.filename.name': 'Note name',
  'settings.filename.desc':
    'Date format for the note holding one day of messages. Uses Moment.js tokens. Preview: {preview}',
  'settings.filename.placeholder': 'YYYY-MM-DD',

  'settings.heading.name': 'Heading',
  'settings.heading.desc': 'Messages are appended under this heading. It is created if missing.',

  'settings.section.format': 'How each message looks',
  'settings.template.name': 'Line format',
  'settings.template.desc':
    '{time}, {date} and {text} are replaced. Everything else is written as-is — put an emoji, bold markers or a “- ” bullet here.',
  'settings.template.placeholder': '✏️ **{time}** {text}',

  'settings.blockStyle.name': 'Wrap each message in',
  'settings.blockStyle.plain': 'Nothing',
  'settings.blockStyle.code': 'A code block',
  'settings.blockStyle.callout': 'A callout',
  'settings.blockStyle.codeWarning':
    'Inside a code block Markdown is inert: **bold** shows its asterisks and links stay as text. Use a callout if you want formatting in a boxed entry.',

  'settings.calloutType.name': 'Callout type',
  'settings.calloutType.desc': 'note, tip, quote, info, warning — anything Obsidian accepts after [!…].',

  'settings.preview.name': 'Preview',

  // --- settings: sync ---
  'settings.section.sync': 'Sync',
  'settings.interval.name': 'Check every',
  'settings.interval.desc': 'Telegram is only polled while Obsidian is open.',
  'settings.interval.seconds': '{n} seconds',
  'settings.interval.minutes': '{n} minutes',

  'settings.syncNow.name': 'Sync now',
  'settings.syncNow.button': 'Sync',

  'settings.status.name': 'Last sync',
  'settings.status.never': 'Never',
  'settings.status.ok': '{time} — {n} new',
  'settings.status.okNothing': '{time} — nothing new',
  'settings.status.running': 'Running…',
  'settings.status.error': '{time} — failed: {message}',

  // --- commands ---
  'command.syncNow': 'Sync now',

  // --- entry fragments written into notes ---
  'entry.attachmentTooBig': '*Attachment over 20 MB — the bot API refuses it; it stays in your Telegram chat.*',
  'entry.attachmentFailed': '*Attachment could not be downloaded — it stays in your Telegram chat.*',
  'entry.transcription': '🎙️ {text}',

  // --- notices ---
  'notice.synced': 'Telegram: {n} new',
  'notice.skipped.nonText': '{n} unsupported message(s) skipped (stickers, polls, locations and the like).',
  'notice.skipped.foreignChat': '{n} message(s) from an unbound chat were ignored.',
  'notice.bound': 'Bot bound to this chat. Messages from other chats will be ignored.',

  // --- errors (HumanError keys) ---
  'error.noToken': 'Add your bot token in the plugin settings first.',
  'error.invalidToken': 'Telegram rejected this token. Check it with @BotFather, or create a new bot.',
  'error.tokenShape':
    'That doesn’t look like a bot token. It should be a number, a colon, then about 35 characters.',
  'error.network': 'Could not reach Telegram. Check your connection.',
  'error.offline': 'Offline — will try again on the next check.',
  'error.conflict':
    'Another device is already polling this bot. That is fine: whichever device is open will sync, and the note reaches the others through vault sync.',
  'error.rateLimited': 'Telegram is rate-limiting the bot. Waiting {seconds}s.',
  'error.telegram': 'Telegram said: {message}',
  'error.fileTooBig': 'Telegram refuses to serve files over 20 MB to bots.',
  'error.badFolder': 'The folder “{folder}” could not be used: {reason}',
  'error.badTemplate': 'The note-name format “{template}” produces an empty or invalid file name.',
  'error.noTextPlaceholder': 'The line format has no {text}, so message bodies would be dropped.',
  'error.writeFailed': 'Could not write to “{path}”: {reason}',
  'error.transcriptionFailed': 'Voice transcription failed ({reason}). The attachment was still saved.',
  'error.unknown': 'Something went wrong: {message}',
} as const;

export type I18nKey = keyof typeof en;
export type Dictionary = Record<I18nKey, string>;
