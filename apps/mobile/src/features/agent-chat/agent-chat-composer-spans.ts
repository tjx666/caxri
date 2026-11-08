import type { MarkdownLivePreviewMark } from '@caxri/markdown/live-preview-marks';
import { markdownLivePreviewMarks } from '@caxri/markdown/live-preview-marks';
import { agentChatImageTokenRanges } from '@caxri/protocol';

type InlineStyle = Extract<MarkdownLivePreviewMark, { kind: 'text' }>['style'];
type LineStyle = Extract<MarkdownLivePreviewMark, { kind: 'line' }>['style'];

/**
 * One run of the draft drawn with a single look. The runs concatenate to the draft exactly, because a native text field
 * styles its text but cannot replace it: syntax the Desktop editor hides is drawn `isHidden` (shrunk and transparent),
 * and a bullet marker stays the typed `-`, dimmed.
 */
export interface AgentChatComposerSpan {
    /**
     * Where the run starts in the draft.
     */
    from: number;
    /**
     * Whether the span is an `[Image #N]` placeholder, drawn as a pill.
     */
    isImage: boolean;
    isHidden: boolean;
    inline: InlineStyle[];
    line: LineStyle | undefined;
    text: string;
}

const lineStarts = (text: string, from: number): number => text.lastIndexOf('\n', from - 1) + 1;
const lineEnds = (text: string, from: number): number => {
    const end = text.indexOf('\n', from);
    return end === -1 ? text.length : end;
};

/**
 * The composer draft split into styled runs, from the same live-preview marks the Desktop composer and the sent bubble
 * read. Syntax the cursor or selection touches stays visible, as on Desktop, so the caret never sits inside text the
 * reader cannot see. Only a placeholder an attached image owns (`owned`) is drawn as a pill; one typed by hand stays
 * text.
 */
export function agentChatComposerSpans(
    draft: string,
    selection: { end: number; start: number },
    owned?: ReadonlySet<number>,
): AgentChatComposerSpan[] {
    if (draft === '') return [];
    const marks = markdownLivePreviewMarks(draft, [{ from: selection.start, to: selection.end }]);
    const images = agentChatImageTokenRanges(draft).filter(
        ({ number }) => owned === undefined || owned.has(number),
    );
    const cuts = new Set([0, draft.length]);
    const lineStyles = new Map<number, LineStyle>();
    for (const mark of marks) {
        if (mark.kind === 'line') {
            lineStyles.set(mark.from, mark.style);
            cuts.add(mark.from);
            cuts.add(lineEnds(draft, mark.from));
        } else {
            cuts.add(mark.from);
            cuts.add(mark.to);
        }
    }
    for (const image of images) {
        cuts.add(image.from);
        cuts.add(image.to);
    }
    // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted.
    const sorted = [...cuts].sort((a, b) => a - b);
    const spans: AgentChatComposerSpan[] = [];
    for (let index = 0; index < sorted.length - 1; index += 1) {
        const from = sorted[index];
        const to = sorted[index + 1];
        if (from === to) continue;
        const isCovering = (range: { from: number; to: number }) =>
            range.from <= from && range.to >= to;
        const inline: InlineStyle[] = [];
        let isHidden = false;
        for (const mark of marks) {
            if (mark.kind === 'text' && isCovering(mark)) inline.push(mark.style);
            if (mark.kind === 'bullet' && isCovering(mark)) inline.push('syntax');
            if (mark.kind === 'hide' && isCovering(mark)) isHidden = true;
        }
        const lineStart = lineStarts(draft, from);
        const line = from < lineEnds(draft, lineStart) ? lineStyles.get(lineStart) : undefined;
        spans.push({
            from,
            inline,
            isHidden,
            isImage: images.some(isCovering),
            line,
            text: draft.slice(from, to),
        });
    }
    return spans;
}
