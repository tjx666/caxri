import type { AgentChatImageInput, AgentChatImageMediaType } from '@caxri/protocol';
import {
    agentChatImageMediaTypeSchema,
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
    MAX_AGENT_CHAT_THUMBNAIL_LENGTH,
} from '@caxri/protocol';

/**
 * Image attachments for the Chat composer. The full image is read once, sent to the provider, and dropped; the
 * projection and the transcript keep only a small thumbnail made here.
 */

/**
 * Device pixels a thumbnail must cover at 2x: the sent message preview is 96 CSS pixels tall, and the composer chip
 * crops it to a 64 CSS pixel square, so its short side needs 128. A thumbnail fitted only to its long edge is upscaled
 * in the preview and blurs screenshot text.
 */
const THUMBNAIL_MIN_HEIGHT = 192;
const THUMBNAIL_MIN_WIDTH = 128;
/**
 * Caps the long edge of an extreme aspect ratio, which the preview crops anyway, so the thumbnail stays bounded.
 */
const THUMBNAIL_MAX_EDGE = 768;
/**
 * JPEG qualities tried in order until the thumbnail fits the projection's bound; a dense screenshot needs a lower one.
 */
const THUMBNAIL_QUALITIES = [0.9, 0.8, 0.65, 0.5];

/**
 * A first resize aims a little under the byte limit, since encoded size only roughly follows pixel area.
 */
const RESIZE_TARGET_RATIO = 0.85;
/**
 * Each further attempt shrinks both edges by this factor, and a lossy format also steps down its quality.
 */
const RESIZE_STEP = 0.8;
const RESIZE_QUALITIES = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65];
/**
 * Below this long edge a resized image is too small to be worth sending, so it is refused as too large instead.
 */
const RESIZE_MIN_EDGE = 320;

/**
 * Formats a canvas can re-encode as themselves. GIF cannot (its animation would be lost), so an oversized GIF is still
 * refused up front.
 */
const RESIZABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
]);

export const AGENT_CHAT_IMAGE_RESIZED_NOTE = `Resized to fit the ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB limit`;

export type AgentChatImageRejection = 'count' | 'size' | 'total' | 'type';

/**
 * Images already attached to the message, or reserved by ones still being read.
 */
export interface AgentChatImageReservation {
    bytes: number;
    count: number;
}

/**
 * Bytes a file reserves against the combined limit while it is read: an oversized one is resized to at most the
 * per-image limit, so it cannot reserve more than that.
 */
export function agentChatImageReservedBytes(file: { size: number }): number {
    return Math.min(file.size, MAX_AGENT_CHAT_IMAGE_BYTES);
}

/**
 * Thrown by `readAgentChatImage` when an oversized image could not be resized under the limit.
 */
export class AgentChatImageTooLargeError extends Error {
    constructor() {
        super('Image is too large even after resizing');
        this.name = 'AgentChatImageTooLargeError';
    }
}

function isAgentChatImageType(type: string): type is AgentChatImageMediaType {
    return (agentChatImageMediaTypeSchema.options as readonly string[]).includes(type);
}

/**
 * Why a file cannot be attached next to the images already `reserved`, or `undefined` when it can.
 */
export function agentChatImageRejection(
    file: { type: string; size: number },
    reserved: AgentChatImageReservation,
): AgentChatImageRejection | undefined {
    if (!isAgentChatImageType(file.type)) return 'type';
    if (file.size > MAX_AGENT_CHAT_IMAGE_BYTES && !RESIZABLE_IMAGE_TYPES.has(file.type))
        return 'size';
    if (reserved.count >= MAX_AGENT_CHAT_IMAGES) return 'count';
    if (reserved.bytes + agentChatImageReservedBytes(file) > MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES)
        return 'total';
    return undefined;
}

/**
 * Decoded bytes of an attached image, from its base64 length, so images kept across a remount count against the
 * combined limit without being decoded.
 */
export function agentChatImageBytes(image: Pick<AgentChatImageInput, 'data'>): number {
    const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
    return (image.data.length / 4) * 3 - padding;
}

const MEGABYTE = 1024 * 1024;

/**
 * The toast for one kind of rejection. `fileNames` names the files a size or combined-size rejection refused, so the
 * user knows which one to shrink or leave out when several were dropped at once.
 */
export function agentChatImageRejectionMessage(
    rejection: AgentChatImageRejection,
    fileNames: readonly string[] = [],
): string {
    const named = (message: string): string =>
        fileNames.length > 0 ? `${message}: ${fileNames.join(', ')}` : message;
    switch (rejection) {
        case 'count': {
            return `A message can include up to ${MAX_AGENT_CHAT_IMAGES} images`;
        }
        case 'size': {
            return named(`Images must be ${MAX_AGENT_CHAT_IMAGE_BYTES / MEGABYTE} MB or smaller`);
        }
        case 'total': {
            return named(
                `Images in one message must add up to ${MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES / MEGABYTE} MB or less`,
            );
        }
        case 'type': {
            return 'Only PNG, JPEG, GIF, and WebP images can be attached';
        }
    }
}

/**
 * How a drop splits its image files. A dropped file has a path on disk, so an image the provider cannot take for its
 * format or size (an oversized GIF, the one format that cannot be resized) is cited by path like any other file instead
 * of being refused; `inserted` keeps why, for the info toast. The count and combined limits are judged against the
 * images already attached, so they stay with `add`'s own check.
 */
export function agentChatDroppedImagePlan<Image extends { type: string; size: number }>(
    images: readonly Image[],
): {
    attach: Image[];
    inserted: Array<{ file: Image; rejection: 'size' | 'type' }>;
} {
    const attach: Image[] = [];
    const inserted: Array<{ file: Image; rejection: 'size' | 'type' }> = [];
    for (const file of images) {
        const rejection = agentChatImageRejection(file, { bytes: 0, count: 0 });
        if (rejection === 'size' || rejection === 'type') inserted.push({ file, rejection });
        else attach.push(file);
    }
    return { attach, inserted };
}

/**
 * The info toast after dropped images were cited by path instead of attached (`agentChatDroppedImagePlan`).
 */
export function agentChatInsertedImagePathMessage(
    rejections: ReadonlyArray<'size' | 'type'>,
): string | undefined {
    if (rejections.length === 0) return undefined;
    const reason = rejections.includes('type')
        ? 'Only PNG, JPEG, GIF, and WebP images can be attached'
        : `GIFs over ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB cannot be attached`;
    return `${reason}. Inserted the ${rejections.length === 1 ? 'path' : 'paths'} instead`;
}

/**
 * Said when an image is pasted into a Chat whose provider takes no image input, so the gesture does not silently do
 * nothing. A drop or pick needs no message: it cites the image by path instead.
 */
export function agentChatImagesUnsupportedMessage(providerName: string): string {
    return `${providerName} Chat does not accept images`;
}

/**
 * Thumbnail dimensions that keep the aspect ratio and cover every place the thumbnail is shown at 2x; an image already
 * smaller keeps its size.
 */
export function agentChatThumbnailSize(
    width: number,
    height: number,
): { width: number; height: number } {
    const cover = Math.max(
        THUMBNAIL_MIN_HEIGHT / Math.max(height, 1),
        THUMBNAIL_MIN_WIDTH / Math.max(width, 1),
    );
    const scale = Math.min(1, cover, THUMBNAIL_MAX_EDGE / Math.max(width, height, 1));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

export interface AgentChatImageResizeAttempt {
    width: number;
    height: number;
    /**
     * Encoder quality for a lossy format; a PNG stays lossless, keeping its transparency and crisp screenshot text.
     */
    quality?: number;
}

/**
 * The re-encodings tried, in order, to bring an oversized image of `bytes` under `MAX_AGENT_CHAT_IMAGE_BYTES` in its
 * own format. Encoded size grows roughly with pixel area, so the first attempt scales both edges by the square root of
 * the shrink needed, and each later one shrinks further. Empty when even the first attempt would fall under
 * `RESIZE_MIN_EDGE`.
 */
export function agentChatImageResizeAttempts(
    width: number,
    height: number,
    bytes: number,
    mediaType: AgentChatImageMediaType,
): AgentChatImageResizeAttempt[] {
    const isLossy = mediaType !== 'image/png';
    let scale = Math.min(
        1,
        Math.sqrt((MAX_AGENT_CHAT_IMAGE_BYTES * RESIZE_TARGET_RATIO) / Math.max(bytes, 1)),
    );
    const attempts: AgentChatImageResizeAttempt[] = [];
    for (const quality of RESIZE_QUALITIES) {
        const size = {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        };
        if (Math.max(size.width, size.height) < RESIZE_MIN_EDGE) break;
        attempts.push(isLossy ? { ...size, quality } : size);
        scale *= RESIZE_STEP;
    }
    return attempts;
}

/**
 * The image files among those a paste, drop, or pick carries. Other files, and text, are left to other handling.
 */
export function agentChatImageFiles(files: Iterable<File>): File[] {
    return [...files].filter((file) => file.type.startsWith('image/'));
}

async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    // Chunked so a multi-megabyte image does not overflow the argument limit of `String.fromCharCode`.
    for (let index = 0; index < bytes.length; index += 0x80_00)
        binary += String.fromCodePoint(...bytes.subarray(index, index + 0x80_00));
    return btoa(binary);
}

async function thumbnailDataUrl(image: Blob): Promise<string> {
    const bitmap = await createImageBitmap(image);
    try {
        const size = agentChatThumbnailSize(bitmap.width, bitmap.height);
        const canvas = new OffscreenCanvas(size.width, size.height);
        const context = canvas.getContext('2d');
        if (context) context.imageSmoothingQuality = 'high';
        context?.drawImage(bitmap, 0, 0, size.width, size.height);
        // JPEG keeps a photo-sized preview under the projection's thumbnail bound.
        for (const quality of THUMBNAIL_QUALITIES) {
            // Encoded one at a time on purpose: most images fit at the first quality.
            // eslint-disable-next-line no-await-in-loop -- each lower quality runs only when the previous one is too large
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
            // eslint-disable-next-line no-await-in-loop -- see above
            const dataUrl = `data:image/jpeg;base64,${await blobToBase64(blob)}`;
            if (dataUrl.length <= MAX_AGENT_CHAT_THUMBNAIL_LENGTH) return dataUrl;
        }
        throw new Error('Thumbnail is too large');
    } finally {
        bitmap.close();
    }
}

/**
 * Re-encodes an oversized image in its own format, trying `agentChatImageResizeAttempts` until one fits the limit.
 */
async function resizeAgentChatImage(file: File, mediaType: AgentChatImageMediaType): Promise<Blob> {
    const bitmap = await createImageBitmap(file);
    try {
        const attempts = agentChatImageResizeAttempts(
            bitmap.width,
            bitmap.height,
            file.size,
            mediaType,
        );
        for (const attempt of attempts) {
            const canvas = new OffscreenCanvas(attempt.width, attempt.height);
            const context = canvas.getContext('2d');
            if (context) context.imageSmoothingQuality = 'high';
            context?.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
            // Encoded one at a time on purpose: the first attempt usually fits.
            // eslint-disable-next-line no-await-in-loop -- each smaller attempt runs only when the previous one is too large
            const blob = await canvas.convertToBlob({ type: mediaType, quality: attempt.quality });
            // A browser that cannot encode the format falls back to PNG; sending that under another type would lie.
            if (blob.type === mediaType && blob.size <= MAX_AGENT_CHAT_IMAGE_BYTES) return blob;
        }
        throw new AgentChatImageTooLargeError();
    } finally {
        bitmap.close();
    }
}

/**
 * Reads an accepted image file into a message attachment, first resizing an oversized PNG, JPEG, or WebP under the
 * limit (`isResized`). Rejects when the file cannot be decoded, or with `AgentChatImageTooLargeError` when no resize
 * fits.
 */
export async function readAgentChatImage(
    file: File,
): Promise<{ image: AgentChatImageInput; isResized: boolean }> {
    if (!isAgentChatImageType(file.type)) throw new Error('Unsupported image type');
    const isResized = file.size > MAX_AGENT_CHAT_IMAGE_BYTES;
    const source = isResized ? await resizeAgentChatImage(file, file.type) : file;
    const [data, thumbnail] = await Promise.all([blobToBase64(source), thumbnailDataUrl(source)]);
    return { image: { mediaType: file.type, data, thumbnail }, isResized };
}

/**
 * A thumbnail for an image read back from the provider's record (`agentChat.readImage`), made the same way as one for a
 * newly attached file so a resumed message looks like it did when it was sent.
 */
export async function agentChatImageThumbnail(
    image: Omit<AgentChatImageInput, 'thumbnail'>,
): Promise<string> {
    const bytes = Uint8Array.from(atob(image.data), (character) => character.codePointAt(0) ?? 0);
    return thumbnailDataUrl(new Blob([bytes], { type: image.mediaType }));
}
