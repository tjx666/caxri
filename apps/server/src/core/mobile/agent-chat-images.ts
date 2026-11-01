import type {
    AgentChatImageMediaType,
    AgentChatImagePending,
    AgentChatSnapshot,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

/**
 * An image a phone reads from a Chat message: its thumbnail from the projection, or its original in chunks.
 */
export interface MobileAgentChatImage {
    mediaType: AgentChatImageMediaType;
    data: string;
}

/**
 * The originals a phone is currently paging through. A provider record is re-read for every `agentChat.readImage`, and
 * an original arrives in dozens of chunks, so the last few stay in memory briefly instead of being re-read per chunk.
 */
const recentOriginals = new Map<
    string,
    { image: MobileAgentChatImage | null; expiresAt: number }
>();
const RECENT_ORIGINALS_LIMIT = 2;
const RECENT_ORIGINAL_LIFETIME_MS = 60_000;

export async function readMobileAgentChatOriginal(
    domainService: ServerDomainService,
    target: { terminalId: string; itemId: string; index: number },
): Promise<MobileAgentChatImage | AgentChatImagePending | null> {
    const key = JSON.stringify([target.terminalId, target.itemId, target.index]);
    const now = Date.now();
    for (const [cached, entry] of recentOriginals)
        if (entry.expiresAt <= now) recentOriginals.delete(cached);
    const hit = recentOriginals.get(key);
    if (hit) return hit.image;
    const image = await domainService.request('agentChat.readImage', target);
    // A message not recorded yet is asked about again shortly, and must not keep answering `pending` once it is.
    if (image && 'pending' in image) return image;
    recentOriginals.set(key, { image, expiresAt: now + RECENT_ORIGINAL_LIFETIME_MS });
    while (recentOriginals.size > RECENT_ORIGINALS_LIMIT)
        recentOriginals.delete(recentOriginals.keys().next().value!);
    return image;
}

const THUMBNAIL_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/su;

/**
 * The thumbnail a projection item carries, `null` when it has none, or `undefined` when the item already left the
 * projection (a message the phone read through `mobile.agentChat.readHistory`).
 */
export function mobileAgentChatThumbnail(
    snapshot: AgentChatSnapshot,
    itemId: string,
    index: number,
): MobileAgentChatImage | null | undefined {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) return undefined;
    const thumbnail = item.type === 'userMessage' ? item.images?.[index]?.thumbnail : undefined;
    const match = thumbnail ? THUMBNAIL_PATTERN.exec(thumbnail) : null;
    return match ? { mediaType: match[1] as AgentChatImageMediaType, data: match[2] } : null;
}
