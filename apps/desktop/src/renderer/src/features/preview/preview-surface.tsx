import type { ReactNode } from 'react';
import { lazy, Suspense, useCallback } from 'react';

import type { FilePreviewTab } from '@caxri/protocol';
import { isExternalEditorTabPath, parseExternalEditorTab } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { executeCommand } from '../../commands/execute';
import { useResourceLoad } from '../../hooks/use-resource-load';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import { useProjectById, useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import { cacheDocument } from '../editor/document-commands';
import { documentLoadRecoveryAction, documentReadRecovery } from '../editor/document-load-recovery';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { ImagePreview } from './image-preview';
import { MarkdownPreview } from './markdown-preview';
import { MermaidPreview } from './mermaid-preview';
import { PREVIEW_LOADING_LABEL, previewerForPath } from './preview-registry';
import { previewViewStateKey } from './preview-view-state';

/**
 * Lazy because the table view carries the CSV parser, and the PDF view carries pdf.js and its worker. A Markdown
 * preview must pay for neither, and pdf.js alone outweighs everything else a preview loads.
 */
const CsvPreview = lazy(async () => {
    const module = await import('./csv-preview');
    return { default: module.CsvPreview };
});

const PdfPreview = lazy(async () => {
    const module = await import('./pdf-preview');
    return { default: module.PdfPreview };
});

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

/**
 * Reads the source of a text-backed preview through the Session document cache, then hands the document to `children`.
 *
 * Sharing the cache with the editor is what makes the preview live: the same buffer the user is typing into is the one
 * rendered here, with no second read and no reconciliation between two copies of the document.
 */
function TextPreviewSurface({
    sessionId,
    workbenchProjectId,
    path,
    children,
}: {
    sessionId: string;
    workbenchProjectId: string | undefined;
    path: string;
    children: (document: EditorDocument) => ReactNode;
}) {
    const document = useDocument(sessionId, path, workbenchProjectId);
    const load = useCallback(() => cacheDocument(sessionId, path), [path, sessionId]);
    const { failure, retry } = useResourceLoad({
        target: `${sessionViewScope(sessionId, workbenchProjectId)}\u{0}${path}`,
        enabled: !document,
        load,
    });
    /**
     * An external document lives only in the Renderer cache; there is no Project file to read it back from once its
     * source tab is gone, so say so instead of showing a load that never finishes.
     */
    if (!document && isExternalEditorTabPath(path))
        return (
            // Recovery is the same free-path Open File the user reached it through (Cmd+P), because an external file
            // outside every Project can only come back through an explicit open.
            <EditorLoadFailure
                actionLabel="Open File…"
                reason="This file is outside every Project and is no longer open. Open it again to preview it."
                tone="interrupted"
                onAction={() => executeCommand('pathBrowser.open')}
            />
        );
    if (!document)
        return failure ? (
            <EditorLoadFailure
                {...describeDocumentReadFailure(failure.error)}
                {...documentLoadRecoveryAction(documentReadRecovery(failure.error), path, retry)}
            />
        ) : (
            <div className={emptyWorkClassName}>{PREVIEW_LOADING_LABEL}</div>
        );
    return children(document);
}

/**
 * Routes a `caxri-file-preview://` tab to the view registered for its format.
 *
 * Every renderer is reached through {@link previewerForPath}, so adding a format is a registry entry plus its view: no
 * branch in the editor surface, the tab bar, or the commands. A scrollable view remembers where it was per pane, so the
 * same file previewed in two panes keeps two positions.
 */
export function PreviewSurface({ paneId, tab }: { paneId: string; tab: FilePreviewTab }) {
    const session = usePaneViewSession();
    const project = useProjectById(session?.workbenchProjectId);
    const theme = useTheme();
    if (!session || !project || !theme) return null;
    const previewer = previewerForPath(tab.path);
    if (!previewer)
        return <div className={emptyWorkClassName}>No preview is available for this file.</div>;
    const viewStateKey = previewViewStateKey(session.id, paneId, tab.path);
    const textSurface = (render: (document: EditorDocument) => ReactNode) => (
        <TextPreviewSurface
            sessionId={session.id}
            workbenchProjectId={session.workbenchProjectId}
            path={tab.path}
        >
            {render}
        </TextPreviewSurface>
    );
    switch (previewer.id) {
        case 'image': {
            return (
                <ImagePreview
                    path={tab.path}
                    sessionId={session.id}
                    workbenchProjectId={session.workbenchProjectId}
                />
            );
        }
        case 'markdown': {
            return textSurface((document) => {
                const external = parseExternalEditorTab(tab.path);
                /**
                 * An external document resolves its relative images and links against its own folder, which is the
                 * whole grant Main holds for it; a Project document resolves against the Project.
                 */
                if (external && document.displayPath) {
                    const { displayPath } = document;
                    return (
                        <MarkdownPreview
                            sessionId={session.id}
                            externalDocumentId={external.documentId}
                            documentPath={displayPath}
                            projectRoot={displayPath.slice(0, displayPath.lastIndexOf('/')) || '/'}
                            source={document.content}
                            theme={theme}
                            viewStateKey={viewStateKey}
                        />
                    );
                }
                return (
                    <MarkdownPreview
                        sessionId={session.id}
                        documentPath={tab.path}
                        projectRoot={project.rootPath}
                        source={document.content}
                        theme={theme}
                        viewStateKey={viewStateKey}
                    />
                );
            });
        }
        case 'mermaid': {
            return textSurface((document) => (
                <MermaidPreview source={document.content} theme={theme} />
            ));
        }
        case 'table': {
            return textSurface((document) => (
                <Suspense
                    fallback={<div className={emptyWorkClassName}>{PREVIEW_LOADING_LABEL}</div>}
                >
                    <CsvPreview
                        path={tab.path}
                        source={document.content}
                        viewStateKey={viewStateKey}
                    />
                </Suspense>
            ));
        }
        case 'pdf': {
            return (
                <Suspense
                    fallback={<div className={emptyWorkClassName}>{PREVIEW_LOADING_LABEL}</div>}
                >
                    <PdfPreview
                        path={tab.path}
                        sessionId={session.id}
                        viewStateKey={viewStateKey}
                        workbenchProjectId={session.workbenchProjectId}
                    />
                </Suspense>
            );
        }
    }
}
