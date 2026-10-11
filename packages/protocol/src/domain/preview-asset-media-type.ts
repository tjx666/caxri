import type { PreviewAssetMediaType } from './domain.js';

const PREVIEW_ASSET_MEDIA_TYPES = new Map<string, PreviewAssetMediaType>([
    ['apng', 'image/apng'],
    ['avif', 'image/avif'],
    ['bmp', 'image/bmp'],
    ['gif', 'image/gif'],
    ['ico', 'image/x-icon'],
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['png', 'image/png'],
    ['svg', 'image/svg+xml'],
    ['webp', 'image/webp'],
]);

/**
 * The media type a preview may load `path` as, derived from its extension alone, or `undefined` for any file outside
 * the image allowlist. Every reader of a preview asset (Server Core for Project files, Main for external documents)
 * refuses a file this does not recognize before opening it.
 */
export function previewAssetMediaType(path: string): PreviewAssetMediaType | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? undefined : PREVIEW_ASSET_MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase());
}
