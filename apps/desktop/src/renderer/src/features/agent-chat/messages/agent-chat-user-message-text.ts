import { proseFileReferences, proseWebLinks } from '@caxri/markdown';
import { agentChatImageTokenRanges } from '@caxri/protocol';

import { agentChatAbsolutePaths } from '../attachments/agent-chat-path-pills';

/**
 * A run of a user's message: plain text, a file path that opens in the editor, an absolute path drawn as the pill the
 * composer showed for it, a web link, or the `[Image #N]` placeholder of one of the message's images.
 */
export type AgentChatUserMessageSegment =
    | { kind: 'text'; text: string }
    | { kind: 'image'; text: string; number: number; index: number }
    | { kind: 'file'; text: string; file: string }
    | { kind: 'path'; text: string; path: string; isDirectory: boolean }
    | { kind: 'url'; text: string; url: string };

/**
 * The number the message's first image goes by in its `[Image #N]` placeholders, or `undefined` when the text places
 * none of its `imageCount` images. Caxri numbers each message's images from 1, as Codex and Orca do, but the Claude
 * Code CLI keeps counting across the conversation, so a conversation started there can send its images as `[Image #3]`
 * and `[Image #4]`; when the placeholders fit within the message's images that way, the lowest names the first image.
 */
export function agentChatFirstImageNumber(text: string, imageCount: number): number | undefined {
    if (imageCount === 0) return undefined;
    const numbers = agentChatImageTokenRanges(text).map(({ number }) => number);
    if (numbers.length === 0) return undefined;
    const lowest = Math.min(...numbers);
    if (Math.max(...numbers) - lowest < imageCount) return lowest;
    return numbers.some((number) => number <= imageCount) ? 1 : lowest;
}

/**
 * Splits a user's message into its text, the paths they typed or dropped in, and the URLs they pasted, in order. A
 * whole-word absolute path is a pill whether or not files can open (see `agentChatAbsolutePaths`). File paths are found
 * only when the Chat can open them. Where a path and a URL overlap (`https://a.dev/x.ts`), the run that starts first
 * wins, which is always the URL. A placeholder is an image only when it names one of the message's `imageCount` images
 * (see `agentChatFirstImageNumber`); otherwise it is what the user typed. An image segment's `index` is its image's
 * place in the message.
 */
export function agentChatUserMessageSegments(
    text: string,
    options: { withFiles: boolean; imageCount?: number },
): AgentChatUserMessageSegment[] {
    const imageCount = options.imageCount ?? 0;
    const first = agentChatFirstImageNumber(text, imageCount) ?? 1;
    const runs = [
        ...agentChatImageTokenRanges(text).flatMap(({ from, number, to }) =>
            number >= first && number - first < imageCount
                ? [
                      {
                          index: from,
                          segment: {
                              kind: 'image',
                              text: text.slice(from, to),
                              number,
                              index: number - first,
                          } as const,
                      },
                  ]
                : [],
        ),
        // Before the file links: where both start, the path pill wins.
        ...agentChatAbsolutePaths(text).map(({ index, ...segment }) => ({
            index,
            segment: { kind: 'path', ...segment } as const,
        })),
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
