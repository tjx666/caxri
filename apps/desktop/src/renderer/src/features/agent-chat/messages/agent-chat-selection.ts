/**
 * The gap between the selected text and the selection toolbar, and the margin the toolbar keeps inside the transcript.
 */
export const AGENT_CHAT_SELECTION_TOOLBAR_GAP = 8;

interface Box {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/**
 * Selected transcript text as a Markdown quote, the form an Agent reads as "the part of the conversation I mean". Each
 * line is quoted, blank lines keep the quote one block, and surrounding blank lines are dropped. Empty for a selection
 * of whitespace alone.
 */
export function agentChatSelectionQuote(text: string): string {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
    return lines.map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>')).join('\n');
}

/**
 * Where the selection toolbar goes, in viewport coordinates: centered above the selection's first line, or below its
 * last line when the transcript has no room above, and kept horizontally inside the transcript. `undefined` when the
 * selection is scrolled out of the transcript, so the toolbar never floats over the composer or the tab bar.
 */
export function agentChatSelectionToolbarPosition({
    bounds,
    first,
    last,
    size,
}: {
    /**
     * The visible transcript.
     */
    bounds: Box;
    /**
     * The selection's first and last line boxes.
     */
    first: Box;
    last: Box;
    size: { width: number; height: number };
}): { top: number; left: number } | undefined {
    if (last.bottom < bounds.top || first.top > bounds.bottom) return undefined;
    const gap = AGENT_CHAT_SELECTION_TOOLBAR_GAP;
    const above = first.top - gap - size.height;
    const top =
        above >= bounds.top ? above : Math.min(last.bottom + gap, bounds.bottom - size.height);
    const center = (first.left + first.right) / 2;
    const left = Math.min(
        Math.max(center - size.width / 2, bounds.left + gap),
        bounds.right - gap - size.width,
    );
    return { top, left };
}
