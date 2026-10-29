import { agentChatImageTokenRanges, agentChatTextWithRenumberedImages } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { AgentChatComposerImagePill } from '../composer/agent-chat-composer-extensions';
import type { AgentChatTextEdit } from '../composer/agent-chat-composer-list';
import { agentChatDraftChange } from '../composer/agent-chat-composer-view';
import type {
    AgentChatAttachment,
    AgentChatImageAttachment,
} from '../composer-input/agent-chat-drafts';
import { isAgentChatImageAttachment } from '../composer-input/agent-chat-drafts';

/**
 * The composer's image placeholders, as Cursor's file pills and the terminal Agents' `[Image #N]` work together: an
 * image attached in the composer is written into the draft as `[Image #N]` where the caret was, and the editor draws
 * that span as a pill. `N` is the image's `token`, fixed while the draft is written (removing image 1 leaves image 2
 * named 2, so the pill and its thumbnail never disagree); a sent message renumbers them 1..k in the order its images
 * are sent (`agentChatTextWithSentImageNumbers`), which is the numbering the Agent reads.
 */

/**
 * The token for the next attached image: one past every number the draft, its images, and the images removed from it
 * while it was written (which undo can bring back) already use.
 */
export function nextAgentChatImageToken(
    draft: string,
    attachments: readonly AgentChatAttachment[],
    removedTokens: Iterable<number>,
): number {
    const used = [
        ...agentChatImageTokenRanges(draft).map(({ number }) => number),
        ...attachments.flatMap((attachment) =>
            isAgentChatImageAttachment(attachment) && attachment.token !== undefined
                ? [attachment.token]
                : [],
        ),
        ...removedTokens,
    ];
    return Math.max(0, ...used) + 1;
}

/**
 * How an edit to the draft changes its images: an image whose placeholder the edit took out of the draft is `detached`,
 * and one whose placeholder came back (undo, or a paste of the cut pill) is `reattached` from `removed`, the images
 * taken out while this draft was written. An image without a token (attached before placeholders existed, or returned
 * with a message from an older build) never detaches.
 */
export function agentChatImagePlaceholderChanges(
    draft: string,
    attachments: readonly AgentChatAttachment[],
    removed: ReadonlyMap<number, AgentChatImageAttachment>,
): { detached: AgentChatImageAttachment[]; reattached: AgentChatImageAttachment[] } {
    const present = new Set(agentChatImageTokenRanges(draft).map(({ number }) => number));
    const images = attachments.filter(isAgentChatImageAttachment);
    const attached = new Set(images.map(({ token }) => token));
    return {
        detached: images.filter(({ token }) => token !== undefined && !present.has(token)),
        reattached: [...removed].flatMap(([token, image]) =>
            present.has(token) && !attached.has(token) ? [image] : [],
        ),
    };
}

/**
 * `attachments` with `returned` images put back among the images in token order, so an image brought back by undo
 * returns to its place in the row.
 */
export function attachmentsWithReattached(
    attachments: readonly AgentChatAttachment[],
    returned: readonly AgentChatImageAttachment[],
): AgentChatAttachment[] {
    const next = [...attachments];
    const inTokenOrder = returned.toSorted((a, b) => (a.token ?? 0) - (b.token ?? 0));
    for (const image of inTokenOrder) {
        const after = next.findIndex(
            (attachment) =>
                isAgentChatImageAttachment(attachment) &&
                attachment.token !== undefined &&
                attachment.token > (image.token ?? 0),
        );
        if (after === -1) next.push(image);
        else next.splice(after, 0, image);
    }
    return next;
}

/**
 * `draft` without the placeholders of `tokens`, each taking one space beside it along so no double space is left.
 */
export function draftWithoutImagePlaceholders(draft: string, tokens: ReadonlySet<number>): string {
    let next = draft;
    for (const { from, number, to } of agentChatImageTokenRanges(draft).toReversed()) {
        if (!tokens.has(number)) continue;
        const end = next[to] === ' ' ? to + 1 : to;
        const start = end === to && next[from - 1] === ' ' ? from - 1 : from;
        next = next.slice(0, start) + next.slice(end);
    }
    return next;
}

/**
 * The edit that takes the placeholders of `tokens` out of `draft` (`draftWithoutImagePlaceholders`) as one change, with
 * the caret kept where it was relative to the text around it. `undefined` when the draft holds none of them.
 */
export function agentChatImagePlaceholderRemoval(
    draft: string,
    caret: number,
    tokens: ReadonlySet<number>,
): AgentChatTextEdit | undefined {
    const change = agentChatDraftChange(draft, draftWithoutImagePlaceholders(draft, tokens));
    if (!change) return undefined;
    const { from, insert, to } = change;
    // A caret after the removed span shifts with the text after it; one inside it lands where the span was.
    if (caret <= from) return { from, to, text: insert, caret };
    const shift = insert.length - (to - from);
    return { from, to, text: insert, caret: caret >= to ? caret + shift : from + insert.length };
}

/**
 * The text a message is sent with: each placeholder of an attached image renumbered to that image's place among the
 * images sent, as the terminal Agents count them. A placeholder no attached image owns stays as typed.
 */
export function agentChatTextWithSentImageNumbers(
    text: string,
    images: readonly AgentChatImageAttachment[],
): string {
    const numbers = new Map<number, number>();
    for (const [index, { token }] of images.entries())
        if (token !== undefined) numbers.set(token, index + 1);
    return numbers.size === 0
        ? text
        : agentChatTextWithRenumberedImages(text, (number) => numbers.get(number));
}

/**
 * The pills the composer draws for its attached images' placeholders.
 */
export function agentChatComposerImagePills(
    attachments: readonly AgentChatAttachment[],
    t: Translate,
): AgentChatComposerImagePill[] {
    return attachments.flatMap((attachment) =>
        isAgentChatImageAttachment(attachment) && attachment.token !== undefined
            ? [
                  {
                      label: t('agentChat.attachments.imageNumber', {
                          number: attachment.token,
                      }),
                      thumbnail: attachment.image.thumbnail,
                      token: attachment.token,
                  },
              ]
            : [],
    );
}
