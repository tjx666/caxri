import { useCallback } from 'react';

import type { FilePreviewTab } from '@caxri/protocol';
import { isExternalEditorTabPath } from '@caxri/protocol';

import { useResourceLoad } from '../../hooks/use-resource-load';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import { useProjectById, useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import { cacheDocument } from '../editor/document-commands';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { ImagePreview } from './image-preview';
import { MarkdownPreview } from './markdown-preview';
import { previewerForPath } from './preview-registry';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

/**
 * Reads the source of a text-backed preview through the Session document cache.
 *
 * Sharing the cache with the editor is what makes the preview live: the same buffer the user is typing into is the one
 * rendered here, with no second read and no reconciliation between two copies of the document.
 */
function MarkdownPreviewSurface({
    sessionId,
    workbenchProjectId,
    projectRoot,
    path,
}: {
    sessionId: string;
    workbenchProjectId: string | undefined;
    projectRoot: string;
    path: string;
}) {
    const theme = useTheme();
    const document = useDocument(sessionId, path, workbenchProjectId);
    const load = useCallback(() => cacheDocument(sessionId, path), [path, sessionId]);
    const { failure, retry } = useResourceLoad({
        target: `${sessionViewScope(sessionId, workbenchProjectId)}\u{0}${path}`,
        enabled: !document,
        load,
    });
    if (!theme) return null;
    /**
     * An external document lives only in the Renderer cache; there is no Project file to read it back from once its
     * source tab is gone, so say so instead of showing a load that never finishes.
     */
    if (!document && isExternalEditorTabPath(path))
        return <div className={emptyWorkClassName}>External file is no longer available.</div>;
    if (!document)
        return failure ? (
            <EditorLoadFailure
                actionLabel="Retry"
                {...describeDocumentReadFailure(failure.error)}
                onAction={retry}
            />
        ) : (
            <div className={emptyWorkClassName}>Loading file…</div>
        );
    return (
        <MarkdownPreview
            sessionId={sessionId}
            documentPath={path}
            projectRoot={projectRoot}
            source={document.content}
            theme={theme}
        />
    );
}

/**
 * Routes a `caxri-file-preview://` tab to the view registered for its format.
 *
 * Every renderer is reached through {@link previewerForPath}, so adding HTML, CSV, or a spreadsheet later is a registry
 * entry plus its view: no branch in the editor surface, the tab bar, or the commands.
 */
export function PreviewSurface({ tab }: { tab: FilePreviewTab }) {
    const session = usePaneViewSession();
    const project = useProjectById(session?.workbenchProjectId);
    if (!session || !project) return null;
    const previewer = previewerForPath(tab.path);
    if (!previewer)
        return <div className={emptyWorkClassName}>No preview is available for this file.</div>;
    switch (previewer.id) {
        case 'image': {
            return <ImagePreview sessionId={session.id} path={tab.path} />;
        }
        case 'markdown': {
            return (
                <MarkdownPreviewSurface
                    sessionId={session.id}
                    workbenchProjectId={session.workbenchProjectId}
                    projectRoot={project.rootPath}
                    path={tab.path}
                />
            );
        }
    }
}
