import type { AgentChatImageMediaType, MethodResult } from '@caxri/protocol';

type ImageChunk = MethodResult<'mobile.agentChat.readImage'>;

export interface AgentChatImageData {
    mediaType: AgentChatImageMediaType;
    /**
     * The whole image as base64.
     */
    data: string;
}

/**
 * Which image of which message, and whether the phone wants its thumbnail or the original.
 */
export interface AgentChatImageTarget {
    terminalId: string;
    itemId: string;
    index: number;
    variant: 'thumbnail' | 'original';
}

/**
 * Pages one image through `mobile.agentChat.readImage` and joins the chunks. Resolves `null` when the Chat holds no
 * such image or thumbnail; fails when the image changed between chunks rather than joining two different pictures.
 */
export async function readAgentChatImage(
    readChunk: (chunkIndex: number) => Promise<ImageChunk>,
    onProgress?: (progress: number) => void,
): Promise<AgentChatImageData | null> {
    const first = await readChunk(0);
    if (!first) return null;
    const parts = [first.data];
    onProgress?.(1 / first.chunkCount);
    for (let chunkIndex = 1; chunkIndex < first.chunkCount; chunkIndex += 1) {
        // The Server pages one image in order, and one chunk already fills a gateway frame.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const next = await readChunk(chunkIndex); // eslint-disable-line no-await-in-loop
        if (!next || next.chunkCount !== first.chunkCount || next.mediaType !== first.mediaType)
            throw new Error('The image changed while it was loading.');
        parts.push(next.data);
        onProgress?.((chunkIndex + 1) / first.chunkCount);
    }
    return { mediaType: first.mediaType, data: parts.join('') };
}

export const agentChatImageDataUri = (image: AgentChatImageData): string =>
    `data:${image.mediaType};base64,${image.data}`;

const EXTENSIONS: Record<AgentChatImageMediaType, string> = {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

export const agentChatImageExtension = (mediaType: AgentChatImageMediaType): string =>
    EXTENSIONS[mediaType];

/**
 * Keeps a zoomed image's pan within its own edges: at `scale` the picture overhangs the viewport by half the extra size
 * on each side, so it can move that far and no further. At the fitted size it cannot move at all.
 */
export const clampZoomPan = (translation: number, scale: number, viewport: number): number => {
    'worklet';
    const limit = Math.max(0, (viewport * scale - viewport) / 2);
    return Math.min(limit, Math.max(-limit, translation));
};

/**
 * What the full-screen viewer shows for one message image:
 *
 * - `imageUri`: the zoomable picture, the original or, when the record has none (Codex), the thumbnail as a preview.
 * - `placeholderUri`: the already loaded thumbnail, shown still while the original loads or after it failed.
 * - `message`: why there is no original, or `null`.
 */
export const agentChatViewerContent = (
    original: { uri: string | null; isMissing: boolean; isError: boolean },
    thumbnailUri: string | null,
): {
    imageUri: string | null;
    isPreview: boolean;
    placeholderUri: string | null;
    message: string | null;
} => {
    const preview = original.isMissing ? thumbnailUri : null;
    return {
        imageUri: original.uri ?? preview,
        isPreview: original.uri === null && preview !== null,
        placeholderUri: original.uri === null && !original.isMissing ? thumbnailUri : null,
        message:
            preview === null && original.isMissing
                ? 'This image is no longer available.'
                : original.isError
                  ? 'The image could not be loaded.'
                  : null,
    };
};
