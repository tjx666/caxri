/**
 * Where a message's images sit in its text. The Claude Code and Codex TUIs both write a pasted image into the prompt as
 * `[Image #N]`, numbered by the image's position in the message, and send the images beside the text; a Chat message
 * uses the same placeholder so the Agent reads each image where the user put it.
 */
const IMAGE_TOKEN = /\[Image #(?<number>[1-9]\d{0,3})\]/gu;

/**
 * The placeholder for the message's `number`th image, counting from 1.
 */
export function agentChatImageToken(number: number): string {
    return `[Image #${number}]`;
}

/**
 * A run of message text, or one image placeholder in it.
 */
export type AgentChatTextSegment =
    { kind: 'text'; text: string } | { kind: 'image'; number: number; text: string };

/**
 * `text` cut at its image placeholders, in order. Text without one is a single text segment.
 */
export function agentChatTextSegments(text: string): AgentChatTextSegment[] {
    const segments: AgentChatTextSegment[] = [];
    let index = 0;
    for (const match of text.matchAll(IMAGE_TOKEN)) {
        if (match.index > index)
            segments.push({ kind: 'text', text: text.slice(index, match.index) });
        segments.push({ kind: 'image', number: Number(match.groups?.number), text: match[0] });
        index = match.index + match[0].length;
    }
    if (index < text.length) segments.push({ kind: 'text', text: text.slice(index) });
    return segments;
}

/**
 * Every image placeholder in `text`, with where it starts and ends.
 */
export function agentChatImageTokenRanges(
    text: string,
): Array<{ number: number; from: number; to: number }> {
    // `Array.from` rather than iterator helpers: the mobile app's TypeScript lib does not declare them.
    return Array.from(text.matchAll(IMAGE_TOKEN), (match) => ({
        number: Number(match.groups?.number),
        from: match.index,
        to: match.index + match[0].length,
    }));
}

/**
 * `text` with each placeholder renumbered by `renumber`; a placeholder it returns `undefined` for stays as written.
 */
export function agentChatTextWithRenumberedImages(
    text: string,
    renumber: (number: number) => number | undefined,
): string {
    return text.replaceAll(IMAGE_TOKEN, (token, number: string) => {
        const next = renumber(Number(number));
        return next === undefined ? token : agentChatImageToken(next);
    });
}

/**
 * `text` with the placeholders of its own `imageCount` images moved past `offset` earlier images, for a message joined
 * after others into one: its first image becomes `[Image #offset+1]`. A placeholder past its own images is not one of
 * them and stays as written.
 */
export function agentChatTextWithOffsetImages(
    text: string,
    offset: number,
    imageCount: number,
): string {
    if (offset === 0) return text;
    return agentChatTextWithRenumberedImages(text, (number) =>
        number <= imageCount ? number + offset : undefined,
    );
}
