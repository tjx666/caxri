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

export type AgentChatViewerSwipe = 'dismiss' | 'next' | 'previous';

/**
 * Distance, as a share of the viewport, and fling speed (points per second) past which a drag at the fitted size closes
 * the viewer (downward) or turns the page (sideways). A shorter or slower drag springs back.
 */
const SWIPE_DISTANCE_RATIO = 0.2;
const SWIPE_FLING_VELOCITY = 800;
const SWIPE_FLING_MIN_DISTANCE = 32;

/**
 * What a one-finger drag over the image at its fitted size does when it ends: a mostly downward drag closes the viewer,
 * a mostly sideways one turns to the next or previous image of the message, and anything else does nothing. A zoomed
 * image pans instead and never reaches here, so paging and closing never fight the zoom.
 */
export const agentChatViewerSwipe = (
    drag: { translationX: number; translationY: number; velocityX: number; velocityY: number },
    viewport: { width: number; height: number },
): AgentChatViewerSwipe | null => {
    'worklet';
    const { translationX, translationY, velocityX, velocityY } = drag;
    const isVertical = Math.abs(translationY) > Math.abs(translationX);
    if (isVertical) {
        if (translationY <= 0) return null;
        const isFar = translationY > viewport.height * SWIPE_DISTANCE_RATIO;
        const isFling = velocityY > SWIPE_FLING_VELOCITY && translationY > SWIPE_FLING_MIN_DISTANCE;
        return isFar || isFling ? 'dismiss' : null;
    }
    const isFar = Math.abs(translationX) > viewport.width * SWIPE_DISTANCE_RATIO;
    const isFling =
        Math.abs(velocityX) > SWIPE_FLING_VELOCITY &&
        Math.abs(translationX) > SWIPE_FLING_MIN_DISTANCE &&
        Math.sign(velocityX) === Math.sign(translationX);
    if (!isFar && !isFling) return null;
    return translationX < 0 ? 'next' : 'previous';
};

/**
 * The image a swipe turns to, or `null` at the first or last image, where the page springs back.
 */
export const agentChatViewerPage = (
    index: number,
    count: number,
    swipe: Exclude<AgentChatViewerSwipe, 'dismiss'>,
): number | null => {
    const next = swipe === 'next' ? index + 1 : index - 1;
    return next >= 0 && next < count ? next : null;
};

/**
 * The viewer's `2 / 3` counter, or `null` for a message with one image.
 */
export const agentChatViewerPosition = (index: number, count: number): string | null =>
    count > 1 ? `${index + 1} / ${count}` : null;

/**
 * What a screen reader gets on the viewer's image. The one-finger swipes that page a fitted picture never reach the
 * image while VoiceOver or TalkBack is on, so turning to another image is an adjustable control: increment is the next
 * image and decrement the previous one, offered only toward an image that exists, and the hint names those gestures
 * instead of the sighted swipes.
 */
export const agentChatViewerAccessibility = (neighbors: {
    next: boolean;
    previous: boolean;
}): {
    actions: Array<{ name: 'increment' | 'decrement'; label: string }>;
    hint: string;
    role: 'adjustable' | 'image';
} => {
    const actions = [
        ...(neighbors.next ? [{ name: 'increment' as const, label: 'Next image' }] : []),
        ...(neighbors.previous ? [{ name: 'decrement' as const, label: 'Previous image' }] : []),
    ];
    if (actions.length === 0)
        return { actions, hint: 'Pinch or double-tap to zoom.', role: 'image' };
    return {
        actions,
        hint: 'Swipe up or down to see the next or previous image. Pinch or double-tap to zoom.',
        role: 'adjustable',
    };
};

/**
 * The page a screen reader's adjust action turns to, or `null` for any other action.
 */
export const agentChatViewerAccessibilitySwipe = (
    actionName: string,
): Exclude<AgentChatViewerSwipe, 'dismiss'> | null =>
    actionName === 'increment' ? 'next' : actionName === 'decrement' ? 'previous' : null;
