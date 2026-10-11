import { useEffect, useState } from 'react';

import { acquireAsset, releaseAsset } from './preview-asset-client';

interface ImageState {
    status: 'failed' | 'loading' | 'ready';
    objectUrl?: string;
}

interface ImageSize {
    width: number;
    height: number;
}

async function readImage(
    sessionId: string,
    path: string,
    signal: AbortSignal,
    report: (state: ImageState) => void,
): Promise<string | undefined> {
    const objectUrl = await acquireAsset({ sessionId }, path);
    if (!signal.aborted) report(objectUrl ? { status: 'ready', objectUrl } : { status: 'failed' });
    return objectUrl;
}

/**
 * The release has to wait for the read: dropping a reference that has not been taken yet leaves the finished read
 * holding the last one forever, and the object URL is never revoked.
 */
async function releaseImage(
    read: Promise<string | undefined>,
    sessionId: string,
    path: string,
): Promise<void> {
    if (await read) releaseAsset({ sessionId }, path);
}

/**
 * The image reading view, currently reached for SVG.
 *
 * Bytes arrive as an object URL from the shared asset cache rather than through the query cache: what has to survive a
 * remount here is the decoded blob and its reference count, which the cache owns, and a `blob:` URL held by a discarded
 * query entry would be revoked out from under a live `img`.
 *
 * The checkerboard is what makes transparency legible: an SVG with a transparent background is otherwise
 * indistinguishable from an empty canvas, and guessing a fill would misrepresent the file.
 */
export function ImagePreview({ sessionId, path }: { sessionId: string; path: string }) {
    const [state, setState] = useState<ImageState>({ status: 'loading' });
    const [size, setSize] = useState<ImageSize | undefined>(undefined);

    useEffect(() => {
        const controller = new AbortController();
        const read = readImage(sessionId, path, controller.signal, setState);
        return () => {
            controller.abort();
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see the helper above
            void releaseImage(read, sessionId, path);
        };
    }, [path, sessionId]);

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                {state.status === 'loading' && <span className="text-muted">Loading image…</span>}
                {state.status === 'failed' && (
                    <span className="text-danger">This image could not be read.</span>
                )}
                {state.status === 'ready' && state.objectUrl && (
                    <img
                        className="caxri-image-preview-canvas max-h-full max-w-full object-contain"
                        src={state.objectUrl}
                        alt={path}
                        onLoad={(event) =>
                            setSize({
                                width: event.currentTarget.naturalWidth,
                                height: event.currentTarget.naturalHeight,
                            })
                        }
                    />
                )}
            </div>
            <div className="flex h-6 flex-none items-center justify-center bg-surface text-[11px] text-muted">
                {size ? `${size.width} × ${size.height}` : ''}
            </div>
        </div>
    );
}
