import type { MarkdownAsset } from '@caxri/markdown';
import { isPreviewImagePath } from '@caxri/protocol';

import type { PreviewAssetSource } from './preview-asset-client';
import { acquireAsset, releaseAsset } from './preview-asset-client';

async function attachImage(
    element: HTMLImageElement,
    source: PreviewAssetSource,
    path: string,
    signal: AbortSignal,
    held: string[],
): Promise<void> {
    const objectUrl = await acquireAsset(source, path);
    if (objectUrl) held.push(path);
    if (signal.aborted) return;
    if (objectUrl) element.src = objectUrl;
    else element.dataset.state = 'unresolved';
}

/**
 * Releasing has to wait for the reads: dropping a reference that has not been taken yet leaves the finished read
 * holding the last one forever, and the object URL is never revoked.
 */
async function releaseImages(
    reads: ReadonlyArray<Promise<unknown>>,
    source: PreviewAssetSource,
    held: readonly string[],
): Promise<void> {
    await Promise.allSettled(reads);
    for (const path of held) releaseAsset(source, path);
}

/**
 * Points every `img` the document declared at something it is allowed to load.
 *
 * A relative image becomes an object URL read through the channel that authorizes the document (the Session's Project,
 * or Main's grant for an external document's folder); a remote one keeps its own URL, which the Renderer's
 * Content-Security-Policy narrows to HTTPS. An image that resolves to neither (a path escaping the Project root, a
 * scheme the app will not fetch) is marked instead of silently rendering as a broken glyph, so the document reads as
 * "this reference is unresolved" rather than "the preview is broken".
 *
 * Returns the release for the object URLs this pass acquired.
 */
export function attachImages(
    container: HTMLElement,
    assets: readonly MarkdownAsset[],
    source: PreviewAssetSource,
    signal: AbortSignal,
): () => void {
    const held: string[] = [];
    const reads: Array<Promise<unknown>> = [];
    for (const asset of assets) {
        const element = container.querySelector(`[data-caxri-asset="${CSS.escape(asset.id)}"]`);
        if (!(element instanceof HTMLImageElement)) continue;
        if (asset.url) {
            element.src = asset.url;
            continue;
        }
        if (!asset.path || !isPreviewImagePath(asset.path)) {
            element.dataset.state = 'unresolved';
            continue;
        }
        reads.push(attachImage(element, source, asset.path, signal, held));
    }
    return () => {
        // Fire-and-forget: nothing observes when the release lands, only that it happens after the reads.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void releaseImages(reads, source, held);
    };
}
