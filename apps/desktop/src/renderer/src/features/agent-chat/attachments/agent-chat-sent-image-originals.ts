import type { AgentChatImageInput } from '@caxri/protocol';

/**
 * Base64 characters of sent originals kept at once: a few full messages' worth of screenshots (one message may carry
 * 20MiB of images). The oldest go first.
 */
const MAX_RETAINED_BASE64_LENGTH = 64 * 1024 * 1024;

const originals = new Map<string, Pick<AgentChatImageInput, 'data' | 'mediaType'>>();
const retained = { length: 0 };

/**
 * Keeps the originals of images this window just sent, keyed by the thumbnail the transcript shows for each, so the
 * larger preview shows the image the user sent without a round trip. The provider's record (`readChatImage`) is the
 * only other source of an original, and it re-reads the transcript or rollout per image.
 */
export function retainAgentChatSentImageOriginals(images: readonly AgentChatImageInput[]): void {
    for (const { data, mediaType, thumbnail } of images) {
        const previous = originals.get(thumbnail);
        if (previous) {
            retained.length -= previous.data.length;
            originals.delete(thumbnail);
        }
        originals.set(thumbnail, { data, mediaType });
        retained.length += data.length;
    }
    for (const [thumbnail, original] of originals) {
        if (retained.length <= MAX_RETAINED_BASE64_LENGTH) break;
        originals.delete(thumbnail);
        retained.length -= original.data.length;
    }
}

/**
 * The original this window sent behind `thumbnail`, as a data URL, or `undefined` once it was dropped or when the image
 * came from history.
 */
export function agentChatSentImageOriginal(thumbnail: string | undefined): string | undefined {
    const original = thumbnail === undefined ? undefined : originals.get(thumbnail);
    return original && `data:${original.mediaType};base64,${original.data}`;
}

/**
 * Whether this window still holds the original sent behind `thumbnail`, without building its data URL.
 */
export function hasAgentChatSentImageOriginal(thumbnail: string | undefined): boolean {
    return thumbnail !== undefined && originals.has(thumbnail);
}

/**
 * Drops every retained original; tests only.
 */
export function clearAgentChatSentImageOriginals(): void {
    originals.clear();
    retained.length = 0;
}
