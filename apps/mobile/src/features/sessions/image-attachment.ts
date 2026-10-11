import { MAX_AGENT_CHAT_THUMBNAIL_LENGTH } from '@caxri/protocol';

const CHUNK_LENGTH = 24_000;
const MAX_BASE64_LENGTH = 4 * 1_024 * 1_024;

export function splitMobileImage(base64: string): string[] {
    const encoded = base64.replace(/^data:image\/jpeg;base64,/u, '').replaceAll(/\s+/gu, '');
    if (encoded.length === 0 || encoded.length > MAX_BASE64_LENGTH)
        throw new Error('Images can be at most 3 MB after compression.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
        throw new Error('This image could not be prepared for upload.');
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += CHUNK_LENGTH)
        chunks.push(encoded.slice(offset, offset + CHUNK_LENGTH));
    if (chunks.length > 192) throw new Error('Image requires too many upload chunks.');
    return chunks;
}

const THUMBNAIL_PREFIX = 'data:image/jpeg;base64,';

/**
 * The box a Chat thumbnail is scaled into, and the JPEG qualities tried in turn until it fits the projection's
 * thumbnail limit. Desktop's message strip shows thumbnails 96 points tall, so this stays sharp there and on the
 * phone.
 */
const CHAT_THUMBNAIL_BOX = 384;
export const CHAT_THUMBNAIL_QUALITIES = [0.7, 0.5, 0.35] as const;

/**
 * Whether a JPEG thumbnail fits `agentChat.send`'s thumbnail limit once the Server wraps it in a data URL.
 */
export const isWithinChatThumbnailLimit = (base64: string): boolean =>
    base64.length > 0 && THUMBNAIL_PREFIX.length + base64.length <= MAX_AGENT_CHAT_THUMBNAIL_LENGTH;

/**
 * The size that fits an image into the thumbnail box, never enlarging a small one.
 */
export const chatThumbnailSize = (
    width: number,
    height: number,
): { width: number; height: number } => {
    const scale = Math.min(1, CHAT_THUMBNAIL_BOX / Math.max(width, height, 1));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
};
