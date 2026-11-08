import { agentChatImageToken, agentChatImageTokenRanges } from '@caxri/protocol';

/**
 * Desktop's image placeholders (`agent-chat-image-placeholders.ts` in the Renderer) for the phone's composer: an image
 * attached in the Chat composer is written into the draft as `[Image #N]` where the cursor was, and the field draws it
 * as a pill. `N` stays fixed while the draft is written; a sent message renumbers the placeholders by the order its
 * images are sent (`agentChatTextWithSentImageNumbers`).
 */

/**
 * How the attached images and their placeholders line up after the attachments or the draft changed. `tokens` maps each
 * attached image to its number. A new image first claims a placeholder no image owns, in order, which is how a message
 * returned unsent gets its images back without a second set of placeholders; otherwise it takes the next number and its
 * placeholder is `inserted` at the cursor. An image whose placeholder left the draft is `detached`, and the
 * placeholders of images taken out of the strip are `orphaned` for the draft to drop.
 */
export function agentChatImagePlaceholderSync({
    draft,
    imageIds,
    tokens,
}: {
    draft: string;
    imageIds: readonly string[];
    tokens: ReadonlyMap<string, number>;
}): {
    detached: string[];
    inserted: number[];
    orphaned: number[];
    tokens: Map<string, number>;
} {
    const inDraft = agentChatImageTokenRanges(draft).map(({ number }) => number);
    const present = new Set(inDraft);
    const next = new Map<string, number>();
    const detached: string[] = [];
    for (const id of imageIds) {
        const token = tokens.get(id);
        if (token === undefined) continue;
        if (present.has(token)) next.set(id, token);
        else detached.push(id);
    }
    const attached = new Set(imageIds);
    const orphaned = [...tokens].flatMap(([id, token]) =>
        attached.has(id) || !present.has(token) ? [] : [token],
    );
    const owned = new Set([...next.values(), ...orphaned]);
    const unowned = inDraft.filter((token) => !owned.has(token));
    const inserted: number[] = [];
    let highest = Math.max(0, ...inDraft, ...tokens.values());
    for (const id of imageIds) {
        if (tokens.has(id)) continue;
        const claimed = unowned.shift();
        if (claimed === undefined) {
            highest += 1;
            next.set(id, highest);
            inserted.push(highest);
        } else next.set(id, claimed);
    }
    return { detached, inserted, orphaned, tokens: next };
}

/**
 * `draft` with the placeholders of `numbers` written at `cursor`, each followed by a space, and where the cursor lands.
 */
export function draftWithImagePlaceholders(
    draft: string,
    cursor: number,
    numbers: readonly number[],
): { draft: string; cursor: number } {
    const at = Math.min(Math.max(cursor, 0), draft.length);
    const before = draft.slice(0, at);
    const after = draft.slice(at);
    const lead = before.length > 0 && !/\s$/u.test(before) ? ' ' : '';
    const tokens = numbers.map((number) => agentChatImageToken(number)).join(' ');
    // The space after lands the cursor past it, ready to type; text already starting with a space keeps its own.
    const trail = /^\s/u.test(after) ? '' : ' ';
    const insert = lead + tokens + trail;
    const landing = at + insert.length + (trail === '' ? 1 : 0);
    return { draft: before + insert + after, cursor: landing };
}

/**
 * `next` with any attached image's placeholder that a deletion cut into removed whole, so a placeholder behaves as one
 * pill, as on Desktop: one Backspace at its end takes the image out instead of leaving `[Image #` behind. Only a pure
 * deletion from `previous` is widened; typing and replacing are left as they are.
 */
export function draftWithWholePlaceholders(
    previous: string,
    next: string,
    owned: ReadonlySet<number>,
): string {
    if (next.length >= previous.length || owned.size === 0) return next;
    let from = 0;
    while (from < next.length && previous[from] === next[from]) from += 1;
    let kept = 0;
    while (
        kept < next.length - from &&
        previous[previous.length - 1 - kept] === next[next.length - 1 - kept]
    )
        kept += 1;
    const to = previous.length - kept;
    if (previous.slice(0, from) + previous.slice(to) !== next) return next;
    let start = from;
    let end = to;
    for (const range of agentChatImageTokenRanges(previous)) {
        const isCut = range.from < to && range.to > from;
        const isWhole = range.from >= from && range.to <= to;
        if (isWhole || !isCut || !owned.has(range.number)) continue;
        start = Math.min(start, range.from);
        end = Math.max(end, range.to);
    }
    return start === from && end === to ? next : previous.slice(0, start) + previous.slice(end);
}
