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

export const AGENT_CHAT_IMAGE_ACCEPT = agentChatImageMediaTypeSchema.options.join(',');

/**
 * Longest edge of a thumbnail, in CSS pixels at 2x, sized for the composer chip and the sent message preview.
 */
const THUMBNAIL_EDGE = 160;

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

export function agentChatImageRejectionMessage(rejection: AgentChatImageRejection): string {
    switch (rejection) {
        case 'count': {
            return `A message can include up to ${MAX_AGENT_CHAT_IMAGES} images`;
        }
        case 'size': {
            return `Images must be ${MAX_AGENT_CHAT_IMAGE_BYTES / 1024 / 1024} MB or smaller`;
        }
        case 'type': {
            return 'Only PNG, JPEG, GIF, and WebP images can be attached';
        }
    }
}

/**
 * Thumbnail dimensions that fit `edge` while keeping the aspect ratio; an image already smaller keeps its size.
 */
export function agentChatThumbnailSize(
    width: number,
    height: number,
    edge = THUMBNAIL_EDGE,
): { width: number; height: number } {
    const scale = Math.min(1, edge / Math.max(width, height, 1));
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

async function thumbnailDataUrl(file: File): Promise<string> {
    const bitmap = await createImageBitmap(file);
    try {
        const size = agentChatThumbnailSize(bitmap.width, bitmap.height);
        const canvas = new OffscreenCanvas(size.width, size.height);
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
        // JPEG keeps a photo-sized preview well under the projection's thumbnail bound.
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
        const dataUrl = `data:image/jpeg;base64,${await blobToBase64(blob)}`;
        if (dataUrl.length > MAX_AGENT_CHAT_THUMBNAIL_LENGTH)
            throw new Error('Thumbnail is too large');
        return dataUrl;
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
