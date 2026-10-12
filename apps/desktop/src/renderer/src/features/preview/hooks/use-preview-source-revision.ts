import { useEffect, useState } from 'react';

import { subscribePreviewSourceChanges } from '../preview-source-changes';

/**
 * A counter that grows each time the file behind a binary preview (a PDF, an SVG) is rewritten on disk, by the user's
 * own save or by an Agent. A view keys its read on it, so it shows the current file instead of the bytes it read when
 * the tab opened. Text previews need none of this: they render the editor buffer, which external sync already keeps
 * current.
 */
export function usePreviewSourceRevision(
    workbenchProjectId: string | undefined,
    path: string,
): number {
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        if (!workbenchProjectId) return;
        return subscribePreviewSourceChanges({ workbenchProjectId, path }, () =>
            setRevision((value) => value + 1),
        );
    }, [path, workbenchProjectId]);
    return revision;
}
