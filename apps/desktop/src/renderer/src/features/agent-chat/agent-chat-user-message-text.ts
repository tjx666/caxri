import { proseFileReferences, proseWebLinks } from '@caxri/markdown';

/**
 * A run of a user's message: plain text, a file path that opens in the editor, or a web link.
 */
export type AgentChatUserMessageSegment =
    | { kind: 'text'; text: string }
    | { kind: 'file'; text: string; file: string }
    | { kind: 'url'; text: string; url: string };

/**
 * Splits a user's message into its text, the paths they typed or dropped in, and the URLs they pasted, in order. File
 * paths are found only when the Chat can open them. Where a path and a URL overlap (`https://a.dev/x.ts`), the run that
 * starts first wins, which is always the URL.
 */
export function agentChatUserMessageSegments(
    text: string,
    options: { withFiles: boolean },
): AgentChatUserMessageSegment[] {
    const runs = [
        ...proseWebLinks(text).map((link) => ({
            index: link.index,
            segment: { kind: 'url', text: link.text, url: link.url } as const,
        })),
        ...(options.withFiles ? proseFileReferences(text) : []).map((reference) => ({
            index: reference.index,
            segment: { kind: 'file', text: reference.text, file: reference.file } as const,
        })),
    ].toSorted((a, b) => a.index - b.index);
    const segments: AgentChatUserMessageSegment[] = [];
    let offset = 0;
    for (const { index, segment } of runs) {
        if (index < offset) continue;
        if (index > offset) segments.push({ kind: 'text', text: text.slice(offset, index) });
        segments.push(segment);
        offset = index + segment.text.length;
    }
    if (offset < text.length) segments.push({ kind: 'text', text: text.slice(offset) });
    return segments;
}
