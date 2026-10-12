import { useEffect, useState } from 'react';

import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import { documentLoadRecoveryAction, documentReadRecovery } from '../editor/document-load-recovery';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import { readAssetObjectUrl } from './preview-asset-client';
import { PREVIEW_LOADING_LABEL } from './preview-registry';
import { usePreviewSourceRevision } from './use-preview-source-revision';

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
        let objectUrl: string | undefined;
        const read = async (): Promise<void> => {
            try {
                objectUrl = await readAssetObjectUrl(sessionId, path, controller.signal);
                if (controller.signal.aborted) URL.revokeObjectURL(objectUrl);
                else setResult({ key: requestKey, state: { status: 'ready', objectUrl } });
            } catch (error) {
                if (!controller.signal.aborted)
                    setResult({ key: requestKey, state: { status: 'failed', error } });
            }
        };
        // eslint-disable-next-line no-void -- every failure is caught above and becomes the failed state
        void read();
        return () => {
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [path, requestKey, sessionId]);

    return {
        state: result?.key === requestKey ? result.state : { status: 'loading' },
        retry: () => setAttempt((value) => value + 1),
    };
}

/**
 * The image reading view, currently reached for SVG.
 *
 * It reads the file again when it is rewritten on disk, so an SVG an Agent regenerates shows its current state. A read
 * that fails says why and offers the recovery that fits: Retry for a read that can succeed later, the default app for a
 * file over the preview size limit.
 *
 * The checkerboard is what makes transparency legible: an SVG with a transparent background is otherwise
 * indistinguishable from an empty canvas, and guessing a fill would misrepresent the file.
 */
export function ImagePreview({
    path,
    sessionId,
    workbenchProjectId,
}: {
    path: string;
    sessionId: string;
    workbenchProjectId: string | undefined;
}) {
    const { state, retry } = useImageObjectUrl(sessionId, workbenchProjectId, path);
    const [size, setSize] = useState<ImageSize | undefined>(undefined);

    if (state.status === 'failed')
        return (
            <EditorLoadFailure
                {...describeDocumentReadFailure(state.error)}
                {...documentLoadRecoveryAction(documentReadRecovery(state.error), path, retry)}
            />
        );
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                {state.status === 'loading' ? (
                    <span className="text-muted">{PREVIEW_LOADING_LABEL}</span>
                ) : (
                    <img
                        className="caxri-image-preview-canvas max-h-full max-w-full object-contain"
                        src={state.objectUrl}
                        alt={basename(path)}
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
