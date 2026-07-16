/**
 * Turning one Telegram message into Markdown lines.
 *
 * The template is a single setting rather than five checkboxes: a user who wants
 * `✏️ **{time}** {text}` can write it, and a user who wants a bullet can write
 * `- {time} {text}`. Adding a knob per decoration would have covered fewer cases
 * with more code.
 */

const ZWSP = '​';

export type BlockStyle = 'plain' | 'code' | 'callout';

export interface RenderOptions {
  /** `{time}`, `{date}` and `{text}` are substituted. Anything else is literal. */
  template: string;
  blockStyle: BlockStyle;
  /** Only read when `blockStyle` is `callout`. `note`, `tip`, `quote`, … */
  calloutType: string;
}

export interface RenderContext {
  time: string;
  date: string;
}

/**
 * Neutralise Markdown that would swallow the rest of the note.
 *
 * A lone `%%` opens an Obsidian block comment and hides everything after it — a
 * user who writes "50%% off" would watch the rest of their day disappear from
 * Reading View. `<!--` does the same. We insert a zero-width space between the
 * offending characters: nothing is deleted, the text looks identical, and the
 * comment never opens.
 *
 * Lookahead rather than literal replacement, so `%%%` and repeated application
 * both behave: after one pass no `%` is followed by `%`, so a second pass is a
 * no-op.
 *
 * Code is exempt at every level: the whole-entry `code` block style (see
 * `wrapCode`), fenced blocks inside the text, and inline backtick spans.
 * Markdown is inert there, `%%` never opens a comment — and a zero-width space
 * planted inside a code span survives a copy-paste into a terminal, which is
 * strictly worse than the hazard it would be neutralising.
 */
export function sanitizeInline(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const line of text.split('\n')) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (run && run[1][0] === fence.char && run[1].length >= fence.length) fence = null;
      out.push(line);
    } else if (run) {
      fence = { char: run[1][0], length: run[1].length };
      out.push(line);
    } else {
      out.push(sanitizeLine(line));
    }
  }
  return out.join('\n');
}

/** An inline code span: a backtick run, content, a matching run not extended by a further backtick. */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

function sanitizeLine(line: string): string {
  let out = '';
  let pos = 0;
  CODE_SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_SPAN.exec(line)) !== null) {
    out += sanitizeSegment(line.slice(pos, m.index)) + m[0];
    pos = m.index + m[0].length;
  }
  return out + sanitizeSegment(line.slice(pos));
}

function sanitizeSegment(segment: string): string {
  return segment
    .replace(/%(?=%)/g, `%${ZWSP}`)
    .replace(/--(?=>)/g, `--${ZWSP}`)
    .replace(/<!(?=--)/g, `<!${ZWSP}`);
}

/**
 * The shortest fence that the text cannot close. A message containing ``` gets
 * wrapped in ````, and so on. Truncating or escaping the user's backticks would
 * be worse than a longer fence.
 */
export function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function applyTemplate(template: string, ctx: RenderContext, firstLine: string): string {
  return template
    .replace(/\{time\}/g, ctx.time)
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{text\}/g, firstLine)
    .trimEnd();
}

/**
 * The first line of the message goes through the template; the rest follow it
 * verbatim, so a multi-line message stays one entry with one timestamp.
 *
 * Trailing blank lines are dropped — entity conversion can leave one behind a
 * closing fence, and renderEntry promises never to end on a blank.
 */
function templated(text: string, opts: RenderOptions, ctx: RenderContext): string[] {
  const [first = '', ...rest] = text.split('\n');
  const lines = [applyTemplate(opts.template, ctx, first), ...rest.map((l) => l.trimEnd())];
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function wrapCode(lines: string[], text: string): string[] {
  const fence = fenceFor(text);
  return [fence, ...lines, fence];
}

function wrapCallout(lines: string[], calloutType: string): string[] {
  const type = calloutType.trim() || 'note';
  // A blank line inside a callout must be `>`, not `> `, or the callout ends.
  return [`> [!${type}]`, ...lines.map((l) => (l.trim() === '' ? '>' : `> ${l}`))];
}

/**
 * The Markdown for one message. Never contains a trailing blank line.
 *
 * `attachmentLine` is an already-rendered Markdown line — an `![[embed]]` or a
 * placeholder — that belongs to this entry. It joins the callout's body, but in
 * `code` style it goes *after* the closing fence: an embed inside a fence is
 * just seven characters of punctuation.
 */
export function renderEntry(
  text: string,
  opts: RenderOptions,
  ctx: RenderContext,
  attachmentLine?: string | readonly string[],
): string[] {
  const attachmentLines = attachmentLine
    ? typeof attachmentLine === 'string'
      ? [attachmentLine]
      : [...attachmentLine]
    : [];
  if (opts.blockStyle === 'code') {
    // Inside a fence nothing is interpreted, so the text is written untouched.
    // The only hazard is the fence itself, and `fenceFor` handles it.
    const fenced = wrapCode(templated(text, opts, ctx), text + opts.template);
    return [...fenced, ...attachmentLines];
  }

  const lines = templated(sanitizeInline(text), opts, ctx);
  lines.push(...attachmentLines);
  return opts.blockStyle === 'callout' ? wrapCallout(lines, opts.calloutType) : lines;
}

/**
 * Entries, separated by one blank line.
 *
 * The blank line is not decoration. Without bullets, two consecutive lines are
 * one Markdown paragraph, and `15:29 a` / `15:30 b` would render as
 * `15:29 a 15:30 b` on a single line. Code blocks and callouts need the
 * separation too, or they merge into one block.
 */
export function joinEntries(entries: string[][]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (out.length > 0) out.push('');
    out.push(...entry);
  }
  return out;
}
