import { markdownLivePreviewMarks } from './live-preview-marks.js';

/**
 * A run of a user's message as a client splits it: plain `text`, or any other kind (a web link, a path pill, a cited
 * Session) that the blocks keep whole. Desktop and the phone each pass their own segment union.
 */
export interface UserMessageSegment {
    kind: string;
    text: string;
}

/**
 * An inline style of the composer's live preview (`MarkdownLivePreviewMark`) over a run of a sent message.
 */
export type UserMessageStyle = 'code' | 'emphasis' | 'strike' | 'strong' | 'syntax';

/**
 * One inline run of a bubble line: the text between Markdown markers, a list bullet drawn in place of its `-`, `*`, or
 * `+`, or a non-text segment the bubble draws as a pill or link that may sit inside bold or italic text.
 */
export type UserMessageRun<S extends UserMessageSegment = UserMessageSegment> =
    | { kind: 'bullet' }
    | {
          kind: 'segment';
          segment: Exclude<S, { kind: 'text' }>;
          styles: readonly UserMessageStyle[];
      }
    | { kind: 'text'; styles: readonly UserMessageStyle[]; text: string };

/**
 * A block of a bubble. A `list` or `quote` block is one line drawn as the composer draws it, and `indent` is a list
 * line's hanging indent in characters; a block with no `line` holds the lines between them as typed, newlines kept.
 */
export interface UserMessageBlock<S extends UserMessageSegment = UserMessageSegment> {
    indent?: number;
    line?: 'list' | 'quote';
    runs: Array<UserMessageRun<S>>;
}

const STYLE_ORDER: readonly UserMessageStyle[] = ['strong', 'emphasis', 'strike', 'code', 'syntax'];

/**
 * Lays a user's message out as the composer showed it, from the same marks (`markdownLivePreviewMarks`, with nothing
 * selected): bold, italics, strikethrough, inline code, list bullets, and quotes render with their markers hidden, and
 * `__init__`, `snake_case`, and `src/*.ts` stay literal under the composer's rules. Headings and fenced code stay as
 * typed, and tables and images are never parsed. The text itself is unchanged: a marker is hidden by leaving it out of
 * the runs, so the message the Agent received (and Copy) is still the original. `segments` is the message's text,
 * paths, and links in order, covering `text` exactly; every non-`text` segment is kept whole. Desktop and the phone
 * share this, so a sent message reads the same on both.
 */
export function userMessageBlocks<S extends UserMessageSegment>(
    text: string,
    segments: readonly S[],
): Array<UserMessageBlock<S>> {
    type Line = UserMessageBlock<S>;
    type Run = UserMessageRun<S>;
    const hidden = new Uint8Array(text.length);
    const bullets = new Uint8Array(text.length);
    const styles = new Uint16Array(text.length);
    const lineMarks = new Map<number, { indent?: number; line: 'list' | 'quote' }>();
    const marks = markdownLivePreviewMarks(text, [], { withBlocks: false });
    for (const mark of marks) {
        if (mark.kind === 'line') {
            if (mark.style === 'list' || mark.style === 'quote')
                lineMarks.set(mark.from, { indent: mark.indent, line: mark.style });
        } else {
            for (let index = mark.from; index < mark.to; index += 1) {
                if (mark.kind === 'hide') hidden[index] = 1;
                else if (mark.kind === 'bullet') bullets[index] = 1;
                else styles[index] = (styles[index] ?? 0) | (1 << STYLE_ORDER.indexOf(mark.style));
            }
        }
    }
    const stylesAt = (offset: number): UserMessageStyle[] =>
        STYLE_ORDER.filter((_, bit) => ((styles[offset] ?? 0) & (1 << bit)) !== 0);

    const lines: Line[] = [];
    let current: Line = { ...lineMarks.get(0), runs: [] };
    const push = (run: Run, runs = current.runs): void => {
        const last = runs.at(-1);
        if (
            run.kind === 'text' &&
            last?.kind === 'text' &&
            last.styles.join(',') === run.styles.join(',')
        )
            last.text += run.text;
        else runs.push(run);
    };
    let offset = 0;
    for (const segment of segments) {
        if (segment.kind !== 'text') {
            if (hidden[offset] !== 1)
                push({
                    kind: 'segment',
                    segment: segment as Exclude<S, { kind: 'text' }>,
                    styles: stylesAt(offset),
                });
            offset += segment.text.length;
            continue;
        }
        for (const character of segment.text) {
            if (character === '\n') {
                lines.push(current);
                current = { ...lineMarks.get(offset + 1), runs: [] };
            } else if (bullets[offset] === 1) push({ kind: 'bullet' });
            else if (hidden[offset] !== 1)
                push({ kind: 'text', styles: stylesAt(offset), text: character });
            offset += character.length;
        }
    }
    lines.push(current);

    // A list or quote line is a block that ends its own line; the lines between them keep their newlines.
    const blocks: Line[] = [];
    let plain: Line | undefined;
    for (const line of lines) {
        if (line.line) {
            plain = undefined;
            blocks.push(line);
        } else if (plain) {
            push({ kind: 'text', styles: [], text: '\n' }, plain.runs);
            for (const run of line.runs) push(run, plain.runs);
        } else {
            plain = { runs: line.runs };
            blocks.push(plain);
        }
    }
    return blocks;
}
