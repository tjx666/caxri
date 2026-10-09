import type { PaneLayout } from '@caxri/protocol';
import { isExternalEditorTabPath, listPaneTabs, parseFilePreviewTab } from '@caxri/protocol';

/**
 * Every document path currently occupying a tab in the given layout, in tree order. Repeated because the same document
 * may be open in several panes.
 */
export function layoutDocumentPaths(layout: PaneLayout): string[] {
    return listPaneTabs(layout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' ? [tab.resource.path] : [],
    );
}

/**
 * External documents a preview tab in this layout still renders. An external buffer cannot be read back once evicted,
 * so closing its source tab must not release it while a preview of it stays open.
 */
function layoutExternalPreviewSources(layout: PaneLayout): string[] {
    return layoutDocumentPaths(layout).flatMap((path) => {
        const source = parseFilePreviewTab(path)?.path;
        return source && isExternalEditorTabPath(source) ? [source] : [];
    });
}

/**
 * Every cached buffer the layout keeps alive: its document tabs plus the external sources of its previews.
 */
export function layoutCachedDocumentPaths(layout: PaneLayout): string[] {
    return [...layoutDocumentPaths(layout), ...layoutExternalPreviewSources(layout)];
}

/**
 * Cached buffers that stay alive after a close leaves `layout` behind: its document tabs, plus each clean external
 * buffer a preview still shows. A dirty one reaching this point was just discarded in the close confirmation, so the
 * preview must not keep rendering those dropped edits.
 */
export function survivingCachedDocumentPaths(
    layout: PaneLayout,
    isDirty: (path: string) => boolean,
): Set<string> {
    const surviving = new Set(layoutDocumentPaths(layout));
    for (const source of layoutExternalPreviewSources(layout))
        if (!isDirty(source)) surviving.add(source);
    return surviving;
}
