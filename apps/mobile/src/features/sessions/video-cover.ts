import * as ImageManipulator from 'expo-image-manipulator';
import { createVideoPlayer } from 'expo-video';

/**
 * The longest side of a cover in pixels: three times the 64pt strip cell, so it stays sharp on a 3x screen.
 */
const COVER_MAX_PIXELS = 192;

/**
 * The first frame of a local video as a small JPEG file, for a composer card's cover. `expo-video` grabs the frame as a
 * native image reference, which React Native's `Image` cannot show; `expo-image-manipulator` (already used for images)
 * writes it to a file `Image` can read, so no image library is added for this.
 */
export const renderVideoCover = async (uri: string): Promise<string> => {
    const player = createVideoPlayer(uri);
    try {
        const frames = await player.generateThumbnailsAsync(0, {
            maxHeight: COVER_MAX_PIXELS,
            maxWidth: COVER_MAX_PIXELS,
        });
        const frame = frames.at(0);
        if (!frame) throw new Error('No frame');
        const image = await ImageManipulator.ImageManipulator.manipulate(frame).renderAsync();
        const saved = await image.saveAsync({
            compress: 0.7,
            format: ImageManipulator.SaveFormat.JPEG,
        });
        return saved.uri;
    } finally {
        player.release();
    }
};

/**
 * Remembers each video's cover by its local URI, so a card that remounts (leaving and returning to the composer, a
 * strip reorder) shows it at once instead of grabbing the frame again. A video whose frame cannot be read resolves to
 * `null` once and is not retried; the card keeps its file glyph.
 */
export const createVideoCoverCache = (render: (uri: string) => Promise<string>) => {
    const settled = new Map<string, string | null>();
    const pending = new Map<string, Promise<string | null>>();
    return {
        /**
         * The cover already made for `uri`: a file URI, `null` after a failure, or `undefined` while none was made.
         */
        peek: (uri: string): string | null | undefined => settled.get(uri),
        load: (uri: string): Promise<string | null> => {
            if (settled.has(uri)) return Promise.resolve(settled.get(uri) ?? null);
            const inFlight = pending.get(uri);
            if (inFlight) return inFlight;
            const settle = async (): Promise<string | null> => {
                let result: string | null;
                try {
                    result = await render(uri);
                } catch {
                    result = null;
                }
                pending.delete(uri);
                settled.set(uri, result);
                return result;
            };
            const cover = settle();
            pending.set(uri, cover);
            return cover;
        },
    };
};

export const videoCovers = createVideoCoverCache(renderVideoCover);
