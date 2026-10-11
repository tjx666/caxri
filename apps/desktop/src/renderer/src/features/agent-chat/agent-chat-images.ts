import type { AgentChatImageInput, AgentChatImageMediaType } from '@caxri/protocol';
import {
    agentChatImageMediaTypeSchema,
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
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

export type AgentChatImageRejection = 'count' | 'size' | 'type';

function isAgentChatImageType(type: string): type is AgentChatImageMediaType {
    return (agentChatImageMediaTypeSchema.options as readonly string[]).includes(type);
}

/**
 * Why a file cannot be attached next to `attachedCount` images, or `undefined` when it can.
 */
export function agentChatImageRejection(
    file: { type: string; size: number },
    attachedCount: number,
): AgentChatImageRejection | undefined {
    if (!isAgentChatImageType(file.type)) return 'type';
    if (file.size > MAX_AGENT_CHAT_IMAGE_BYTES) return 'size';
    if (attachedCount >= MAX_AGENT_CHAT_IMAGES) return 'count';
    return undefined;
}

/**
 * The toast for one kind of rejection. `fileNames` names the files a size rejection refused, so the user knows which
 * one to shrink when several were dropped at once.
 */
export function agentChatImageRejectionMessage(
    rejection: AgentChatImageRejection,
    fileNames: readonly string[] = [],
): string {
    switch (rejection) {
        case 'count': {
            return `A message can include up to ${MAX_AGENT_CHAT_IMAGES} images`;
        }
        case 'size': {
            const limit = `Images must be ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB or smaller`;
            return fileNames.length > 0 ? `${limit}: ${fileNames.join(', ')}` : limit;
        }
        case 'type': {
            return 'Only PNG, JPEG, GIF, and WebP images can be attached';
        }
    }
}

/**
 * Said when an image is pasted into a Chat whose provider takes no image input, so the gesture does not silently do
 * nothing. A drop needs no message: it cites the image by path instead.
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

/**
 * The image files a paste or drop carries. Other files, and text, are left to the input's default handling.
 */
export function agentChatImageFiles(transfer: DataTransfer | null): File[] {
    return [...(transfer?.files ?? [])].filter((file) => file.type.startsWith('image/'));
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
 * Reads an accepted image file into a message attachment. Rejects when the file cannot be decoded as an image.
 */
export async function readAgentChatImage(file: File): Promise<AgentChatImageInput> {
    if (!isAgentChatImageType(file.type)) throw new Error('Unsupported image type');
    const [data, thumbnail] = await Promise.all([blobToBase64(file), thumbnailDataUrl(file)]);
    return { mediaType: file.type, data, thumbnail };
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
