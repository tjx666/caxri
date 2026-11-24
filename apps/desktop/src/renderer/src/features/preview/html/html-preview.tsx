import { parseExternalEditorTab } from '@caxri/protocol';

import { LoadingSkeleton } from '../../../components/loading-skeleton';
import { useTranslation } from '../../../i18n';
import { describeDocumentReadFailure } from '../../../lib/document-read-failure';
import { useCaxriQuery } from '../../../queries/client';
import {
    documentLoadRecoveryAction,
    documentReadRecovery,
} from '../../editor/document-load-recovery';
import { EditorLoadFailure } from '../../editor/editor-load-failure';
import { usePreviewSourceRevision } from '../hooks/use-preview-source-revision';
import { PREVIEW_LOADING_LABEL_KEY } from '../preview-registry';

/**
 * What a page frame may do. Scripts, forms, dialogs, and downloads work as they would in a browser tab. Same-origin is
 * safe to grant because the page's origin is its own `caxri-html://<grant>` host, never the Workbench's, so it keeps
 * `localStorage` without reaching the Workbench document. Top-level navigation is withheld, so a page cannot replace
 * the Workbench; a popup reaches Main's window-open policy, which denies it like any other page content's.
 */
const FRAME_SANDBOX =
    'allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts';

/**
 * A page with no background of its own is drawn on white in a browser. The Workbench theme would otherwise leave its
 * default black text on a dark surface, and no theme role means "browser canvas", so the literal lives here.
 */
const HTML_CANVAS_STYLE = { backgroundColor: 'white', colorScheme: 'light' } as const;

/**
 * Renders an HTML page as a browser would, in a frame Main serves from the page's own folder, so its relative
 * stylesheets, scripts, and images load and its inline scripts run. A Project page is authorized against its Session's
 * Project; an external page by the document ID Main issued when it read the file.
 *
 * The frame reloads when the page is rewritten on disk, so a report an Agent regenerates shows its current state. The
 * page keeps its own colors in every theme, the way a PDF keeps its paper.
 */
export function HtmlPreview({
    sessionId,
    path,
    workbenchRootProjectId,
}: {
    sessionId: string;
    /**
     * The tab's source path: a Project file's absolute path, or an external document's tab path.
     */
    path: string;
    workbenchRootProjectId: string | undefined;
}) {
    const { t } = useTranslation();
    // An external page is named by the document ID Main issued when it read the file, never by its path.
    const external = parseExternalEditorTab(path);
    const externalDocumentId = external?.documentId;
    const name = external?.name ?? path.slice(path.lastIndexOf('/') + 1);
    const revision = usePreviewSourceRevision(workbenchRootProjectId, path, externalDocumentId);
    const query = useCaxriQuery(
        'htmlPreview.url',
        externalDocumentId === undefined ? { sessionId, path } : { documentId: externalDocumentId },
        { retry: false, staleTime: Infinity },
    );
    if (query.isError)
        return (
            <EditorLoadFailure
                {...describeDocumentReadFailure(query.error, t)}
                {...documentLoadRecoveryAction(
                    documentReadRecovery(query.error),
                    path,
                    () => {
                        void query.refetch();
                    },
                    t,
                )}
            />
        );
    if (!query.data)
        return <LoadingSkeleton variant="document" label={t(PREVIEW_LOADING_LABEL_KEY)} />;
    return (
        <iframe
            // A new key on every rewrite reloads the page from disk; `no-store` keeps Chromium from answering it from cache.
            key={revision}
            className="block h-full w-full border-0"
            style={HTML_CANVAS_STYLE}
            sandbox={FRAME_SANDBOX}
            src={query.data.url}
            title={t('preview.html.frameLabel', { name })}
        />
    );
}
