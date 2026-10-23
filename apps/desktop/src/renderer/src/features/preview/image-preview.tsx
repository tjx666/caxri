import { useEffect, useState } from 'react';

import { Skeleton } from '../../components/ui/skeleton';
import { useTranslation } from '../../i18n';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import { documentLoadRecoveryAction, documentReadRecovery } from '../editor/document-load-recovery';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import { usePreviewSourceRevision } from './hooks/use-preview-source-revision';
import { readAssetObjectUrl } from './preview-asset-client';
import { PREVIEW_LOADING_LABEL_KEY } from './preview-registry';
import { PreviewZoomView } from './preview-zoom-view';

type ImageState =
    | { status: 'failed'; error: unknown }
    | { status: 'loading' }
    | { status: 'ready'; objectUrl: string };

interface ImageSize {
    width: number;
    height: number;
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1) || path;
}

/**
 * Reads one image and reports its settled state unless the read was abandoned meanwhile. Resolves to the object URL the
 * read created (revoked by the caller when the read is replaced) and never rejects: a failure becomes the failed
 * state.
 */
async function readImage(
    sessionId: string,
    path: string,
    signal: AbortSignal,
    report: (state: ImageState) => void,
): Promise<string | undefined> {
    try {
        const objectUrl = await readAssetObjectUrl(sessionId, path, signal);
        if (!signal.aborted) report({ status: 'ready', objectUrl });
        return objectUrl;
    } catch (error) {
        if (!signal.aborted) report({ status: 'failed', error });
        return undefined;
    }
}

/**
 * Reads the image once per path, per retry, and per rewrite of the file on disk. A settled result is tagged with the
 * read it answers, so a new read shows as loading on the very render that requested it. The object URL belongs to the
 * read and is revoked when the next read replaces it or the view unmounts.
 */
function useImageObjectUrl(
    sessionId: string,
    workbenchProjectId: string | undefined,
    path: string,
): { state: ImageState; retry: () => void } {
    const [attempt, setAttempt] = useState(0);
    const revision = usePreviewSourceRevision(workbenchProjectId, path);
    const requestKey = `${sessionId}\0${path}\0${attempt}\0${revision}`;
    const [result, setResult] = useState<{ key: string; state: ImageState }>();

    useEffect(() => {
        const controller = new AbortController();
        const read = readImage(sessionId, path, controller.signal, (state) =>
            setResult({ key: requestKey, state }),
        );
        return () => {
            controller.abort();
            void read.then((objectUrl) => objectUrl && URL.revokeObjectURL(objectUrl));
        };
    }, [path, requestKey, sessionId]);

    return {
        state: result?.key === requestKey ? result.state : { status: 'loading' },
        retry: () => setAttempt((value) => value + 1),
    };
}

/**
 * The image reading view for SVG and raster images (PNG, JPEG, GIF, WebP, and the rest `files.readAsset` serves). It
 * zooms and pans (see `PreviewZoomView`), opening at Fit.
 *
 * It reads the file again when it is rewritten on disk, so an image an Agent regenerates shows its current state. A
 * read that fails says why and offers the recovery that fits: Retry for a read that can succeed later, the default app
 * for a file over the preview size limit.
 *
 * The checkerboard is what makes transparency legible: an image with a transparent background is otherwise
 * indistinguishable from an empty canvas, and guessing a fill would misrepresent the file.
 */
export function ImagePreview({
    path,
    sessionId,
    viewStateKey,
    workbenchProjectId,
}: {
    path: string;
    sessionId: string;
    viewStateKey: string;
    workbenchProjectId: string | undefined;
}) {
    const { t } = useTranslation();
    const { state, retry } = useImageObjectUrl(sessionId, workbenchProjectId, path);
    const [size, setSize] = useState<ImageSize | undefined>(undefined);

    if (state.status === 'failed')
        return (
            <EditorLoadFailure
                {...describeDocumentReadFailure(state.error)}
                {...documentLoadRecoveryAction(documentReadRecovery(state.error), path, retry, t)}
            />
        );
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            {state.status === 'loading' ? (
                <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                    <Skeleton
                        className="h-full max-h-80 w-full max-w-120"
                        role="status"
                        aria-hidden={false}
                        aria-label={t(PREVIEW_LOADING_LABEL_KEY)}
                    />
                </div>
            ) : (
                <PreviewZoomView viewStateKey={viewStateKey}>
                    {/* Natural size: the zoom view scales it. Not draggable, so a drag pans instead of lifting the file. */}
                    <img
                        className="caxri-image-preview-canvas block max-w-none"
                        draggable={false}
                        src={state.objectUrl}
                        alt={basename(path)}
                        onLoad={(event) =>
                            setSize({
                                width: event.currentTarget.naturalWidth,
                                height: event.currentTarget.naturalHeight,
                            })
                        }
                    />
                </PreviewZoomView>
            )}
            <div className="flex h-6 flex-none items-center justify-center bg-surface text-[11px] text-muted">
                {size ? `${size.width} × ${size.height}` : ''}
            </div>
        </div>
    );
}
