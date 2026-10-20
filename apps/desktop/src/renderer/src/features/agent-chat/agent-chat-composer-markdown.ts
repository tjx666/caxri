import { GFM, parser } from '@lezer/markdown';

const markdownParser = parser.configure(GFM);

/**
 * How the composer renders one span of its Markdown draft in place. The text itself never changes, so the message the
 * Agent receives is exactly what was typed:
 *
 * - `hide`: syntax the rendering replaces (`**`, a backtick, `# `, `> `).
 * - `bullet`: a `-`, `*`, or `+` list marker drawn as a bullet.
 * - `text`: an inline style over the span; `syntax` dims markers that stay visible (an ordered number, a code fence).
 * - `line`: a style for the whole line starting at `from`; `indent` is the hanging indent of a list line in characters,
 *   so its wrapped text lines up after the marker.
 */
export type AgentChatMarkdownMark =
    | { kind: 'bullet'; from: number; to: number }
    | { kind: 'hide'; from: number; to: number }
    | {
          kind: 'line';
          from: number;
          indent?: number;
          style: 'code' | 'fence' | 'heading1' | 'heading2' | 'heading3' | 'list' | 'quote';
      }
    | {
          kind: 'text';
          from: number;
          style: 'code' | 'emphasis' | 'strike' | 'strong' | 'syntax';
          to: number;
      };

interface Range {
    from: number;
    to: number;
}

const INLINE_STYLES: Partial<Record<string, 'code' | 'emphasis' | 'strike' | 'strong'>> = {
    Emphasis: 'emphasis',
    InlineCode: 'code',
    Strikethrough: 'strike',
    StrongEmphasis: 'strong',
};

const INLINE_MARKS = new Set(['CodeMark', 'EmphasisMark', 'StrikethroughMark']);

const FENCE = /^ {0,3}(?:`{3,}|~{3,})\s*$/;

const HEADINGS: Partial<Record<string, 'heading1' | 'heading2' | 'heading3'>> = {
    ATXHeading1: 'heading1',
    ATXHeading2: 'heading2',
    ATXHeading3: 'heading3',
    ATXHeading4: 'heading3',
    ATXHeading5: 'heading3',
    ATXHeading6: 'heading3',
};

/**
 * The live-preview marks for a draft, as in Obsidian's and the Codex app's composers: headings, bold, italics,
 * strikethrough, inline code, list bullets, quotes, and fenced code render in place, and an element's syntax shows
 * again while a selection touches it (the caret on a heading's line, or at either end of `**bold**`), so it can be
 * edited. `selection` is empty while the editor is not focused, which renders everything. Marks are not sorted.
 */
export function agentChatMarkdownMarks(
    text: string,
    selection: readonly Range[],
): AgentChatMarkdownMark[] {
    const marks: AgentChatMarkdownMark[] = [];
    const isTouched = (from: number, to: number): boolean =>
        selection.some((range) => range.from <= to && range.to >= from);
    const lineStart = (offset: number): number => text.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = (offset: number): number => {
        const lineBreak = text.indexOf('\n', offset);
        return lineBreak === -1 ? text.length : lineBreak;
    };
    const isLineTouched = (offset: number): boolean =>
        isTouched(lineStart(offset), lineEnd(offset));
    /**
     * The inline elements a selection touches; a marker inside one of them stays visible.
     */
    const revealed: Range[] = [];
    markdownParser.parse(text).iterate({
        enter: (node) => {
            const { from, name, to } = node;
            const heading = HEADINGS[name];
            if (heading) {
                marks.push({ kind: 'line', from: lineStart(from), style: heading });
                return;
            }
            const inline = INLINE_STYLES[name];
            if (inline) {
                marks.push({ kind: 'text', from, to, style: inline });
                if (isTouched(from, to)) revealed.push({ from, to });
                return;
            }
            if (INLINE_MARKS.has(name) && node.node.parent?.name !== 'FencedCode') {
                const isRevealed = revealed.some((range) => range.from <= from && range.to >= to);
                if (!isRevealed) marks.push({ kind: 'hide', from, to });
                else marks.push({ kind: 'text', from, to, style: 'syntax' });
                return;
            }
            switch (name) {
                case 'HeaderMark': {
                    if (node.node.parent?.name.startsWith('ATXHeading') !== true) return;
                    // The mark and the space after it; a closing `##` sequence stays as typed.
                    const end = text[to] === ' ' ? to + 1 : to;
                    if (from === lineStart(from) && !isLineTouched(from))
                        marks.push({ kind: 'hide', from, to: end });
                    return;
                }
                case 'QuoteMark': {
                    marks.push({ kind: 'line', from: lineStart(from), style: 'quote' });
                    const end = text[to] === ' ' ? to + 1 : to;
                    if (!isLineTouched(from)) marks.push({ kind: 'hide', from, to: end });
                    return;
                }
                case 'ListMark': {
                    const start = lineStart(from);
                    let gap = 0;
                    while (text[to + gap] === ' ') gap += 1;
                    marks.push({
                        kind: 'line',
                        from: start,
                        indent: to + gap - start,
                        style: 'list',
                    });
                    const isBullet = node.node.parent?.parent?.name === 'BulletList';
                    if (isBullet && !isTouched(from, to)) marks.push({ kind: 'bullet', from, to });
                    else marks.push({ kind: 'text', from, to, style: 'syntax' });
                    return;
                }
                case 'FencedCode': {
                    const first = lineStart(from);
                    for (let line = first; line <= to; line = lineEnd(line) + 1) {
                        // An unclosed fence runs to the end of the draft; its last line is code, not a fence.
                        const isFence =
                            line === first ||
                            (lineEnd(line) >= to && FENCE.test(text.slice(line, to)));
                        marks.push({ kind: 'line', from: line, style: isFence ? 'fence' : 'code' });
                    }
                    return false;
                }
                default: {
                    return;
                }
            }
        },
    });
    return marks;
}
