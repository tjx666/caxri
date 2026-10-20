import { useEffect, useState } from 'react';

import { subscribePreviewSourceChanges } from '../preview-source-changes';

/**
 * A counter that grows each time the file behind a binary preview (a PDF, an SVG) is rewritten on disk, by the user's
 * own save or by an Agent. A view keys its read on it, so it shows the current file instead of the bytes it read when
 * the tab opened. Text previews need none of this: they render the editor buffer, which external sync already keeps
 * current. An external document (`externalDocumentId`) follows Main's watcher for that document instead of the
 * Project's.
 */
export function usePreviewSourceRevision(
    workbenchProjectId: string | undefined,
    path: string,
    externalDocumentId?: string,
): number {
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        const bump = (): void => setRevision((value) => value + 1);
        if (externalDocumentId !== undefined)
            return subscribePreviewSourceChanges({ externalDocumentId }, bump);
        if (!workbenchProjectId) return;
        return subscribePreviewSourceChanges({ workbenchProjectId, path }, bump);
    }, [externalDocumentId, path, workbenchProjectId]);
    return revision;
}
