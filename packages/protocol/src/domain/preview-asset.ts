import { z } from 'zod';

import { pathSchema } from './domain.js';

/**
 * Upper bound on one previewable image. Images referenced by a document are the common consumer, and a preview that
 * inlines a file larger than this would cost more than it shows; the Renderer falls back to a placeholder.
 */
export const MAX_PREVIEW_ASSET_BYTES = 8 * 1_048_576;

/**
 * Upper bound on a previewable document (a PDF). A PDF is the whole tab rather than one of many images inside it, and
 * scanned or illustrated PDFs routinely pass the image ceiling, so it gets its own, larger one. It is also the largest
 * payload `files.readAsset` can carry; `previewAssetByteLimit` picks the ceiling for each media type.
 */
export const MAX_PREVIEW_DOCUMENT_BYTES = 32 * 1_048_576;

/**
 * Media types a preview may load. The allowlist is the type contract: the Server never echoes a caller-supplied one.
 */
export const previewAssetMediaTypes = [
    'application/pdf',
    'image/apng',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
    'image/x-icon',
] as const;

export const previewAssetMediaTypeSchema = z.enum(previewAssetMediaTypes);

/**
 * One binary read for a preview surface: an image, or a whole PDF. Carried as base64 over the ordinary request channel
 * so every client (Renderer today, a mobile client later) reaches it the same way, without an Electron-only protocol
 * handler.
 */
export const fileAssetSchema = z.object({
    path: pathSchema,
    mediaType: previewAssetMediaTypeSchema,
    base64: z.string().max(Math.ceil(MAX_PREVIEW_DOCUMENT_BYTES / 3) * 4),
    size: z.number().int().nonnegative().max(MAX_PREVIEW_DOCUMENT_BYTES),
});

export type FileAsset = z.infer<typeof fileAssetSchema>;
export type PreviewAssetMediaType = z.infer<typeof previewAssetMediaTypeSchema>;

const PREVIEW_ASSET_MEDIA_TYPES = new Map<string, PreviewAssetMediaType>([
    ['apng', 'image/apng'],
    ['avif', 'image/avif'],
    ['bmp', 'image/bmp'],
    ['gif', 'image/gif'],
    ['ico', 'image/x-icon'],
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['svg', 'image/svg+xml'],
    ['webp', 'image/webp'],
]);

/**
 * The media type a preview may load `path` as, derived from its extension alone, or `undefined` for any file outside
 * the allowlist. Every reader of a preview asset (Server Core for Project files, Main for external documents) refuses a
 * file this does not recognize before opening it.
 */
export function previewAssetMediaType(path: string): PreviewAssetMediaType | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? undefined : PREVIEW_ASSET_MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase());
}

/**
 * Whether `path` names an image a document may embed. `files.readAsset` also serves documents (PDF), which an `<img>`
 * cannot display, so an embedding surface checks this before spending a read on them.
 */
export function isPreviewImagePath(path: string): boolean {
    return previewAssetMediaType(path)?.startsWith('image/') ?? false;
}

/**
 * The size ceiling every reader enforces for one media type: a PDF is a whole document, an image one asset of many.
 */
export function previewAssetByteLimit(mediaType: PreviewAssetMediaType): number {
    return mediaType === 'application/pdf' ? MAX_PREVIEW_DOCUMENT_BYTES : MAX_PREVIEW_ASSET_BYTES;
}
