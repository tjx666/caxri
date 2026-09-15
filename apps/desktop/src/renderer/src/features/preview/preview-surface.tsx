import { useEffect } from 'react';

import type { FilePreviewTab } from '@caxri/protocol';

import { useSelectedSession, useSelectedWorkbenchProject, useTheme } from '../../stores/selectors';
import { useDocument } from '../../stores/session-view';
import { cacheDocument } from '../editor/document-commands';
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
    useEffect(() => {
        if (document) return;
        // Fire-and-forget: `cacheDocument` reports its own failure through a toast. The read is needed whenever the
        // preview is opened without its source tab, or after the document cache evicted the buffer.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void cacheDocument(sessionId, path);
    }, [document, path, sessionId]);
    if (!theme) return null;
    if (!document) return <div className={emptyWorkClassName}>Loading file…</div>;
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
 * entry plus its view — no branch in the editor surface, the tab bar, or the commands.
 */
export function PreviewSurface({ tab }: { tab: FilePreviewTab }) {
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
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
