import { proseFileReferences, proseWebLinks } from '@caxri/markdown';
import { agentChatImageTokenRanges } from '@caxri/protocol';

/**
 * A run of a user's message: plain text, a file path that opens in the editor, a web link, or the `[Image #N]`
 * placeholder of one of the message's images.
 */
export type AgentChatUserMessageSegment =
    | { kind: 'text'; text: string }
    | { kind: 'image'; text: string; number: number }
    | { kind: 'file'; text: string; file: string }
    | { kind: 'url'; text: string; url: string };

/**
 * Splits a user's message into its text, the paths they typed or dropped in, and the URLs they pasted, in order. File
 * paths are found only when the Chat can open them. Where a path and a URL overlap (`https://a.dev/x.ts`), the run that
 * starts first wins, which is always the URL. A placeholder is an image only when the message has that many images
 * (`imageCount`); otherwise it is what the user typed.
 */
export function agentChatUserMessageSegments(
    text: string,
    options: { withFiles: boolean; imageCount?: number },
): AgentChatUserMessageSegment[] {
    const imageCount = options.imageCount ?? 0;
    const runs = [
        ...agentChatImageTokenRanges(text).flatMap(({ from, number, to }) =>
            number <= imageCount
                ? [
                      {
                          index: from,
                          segment: { kind: 'image', text: text.slice(from, to), number } as const,
                      },
                  ]
                : [],
        ),
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

/**
 * Whether `text` places any of its `imageCount` images with a placeholder, so their tiles wear the numbers it uses.
 */
export function hasAgentChatImagePlaceholders(text: string, imageCount: number): boolean {
    return agentChatImageTokenRanges(text).some(({ number }) => number <= imageCount);
}
