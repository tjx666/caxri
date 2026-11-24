import type { PaneLayout } from '@caxri/protocol';
import { filePreviewExtension, filePreviewTabPath, findResourceTabs } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import { isLocalOnlyAvailable } from '../../stores/environment';

/**
 * The one loading sentence every preview shows, from the lazy view chunk through the source or asset read. Naming the
 * stage ("Loading file…", then "Loading PDF…") made one wait read as two different steps flickering past.
 */
export const PREVIEW_LOADING_LABEL_KEY = 'preview.loading' satisfies TranslationKey;

/**
 * Which rendered view a preview tab shows. One entry per registered format family.
 */
type PreviewViewId = 'html' | 'image' | 'markdown' | 'mermaid' | 'pdf' | 'table';

export interface PreviewerRegistration {
    id: PreviewViewId;
    /**
     * Lowercased extensions without the leading dot.
     */
    extensions: readonly string[];
    /**
     * What double-clicking the file in the explorer opens.
     *
     * A format that is also readable as text keeps source as the default and the preview as an explicit command; VS
     * Code makes the same call with `priority.textEditor: 'option'`. A format with no useful text form (a PDF)
     * registers `preview`, and every open path (Files, Quick Open, a Terminal link) lands on the preview tab instead of
     * failing a text read.
     */
    defaultView: 'preview' | 'source';
    /**
     * The view is served by this Mac's Main (a `local-only` method), so an SSH Host window, whose files live on the SSH
     * Host, offers no preview of the format at all instead of a preview that can only fail to load.
     */
    localOnly?: true;
}

const PREVIEWERS: readonly PreviewerRegistration[] = [
    { id: 'markdown', extensions: ['markdown', 'md', 'mdx'], defaultView: 'source' },
    { id: 'image', extensions: ['svg'], defaultView: 'source' },
    // Raster images have no text form, so every open path lands on the preview. The list matches the image media types
    // `files.readAsset` serves (`previewAssetMediaType`).
    {
        id: 'image',
        extensions: ['apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp'],
        defaultView: 'preview',
    },
    { id: 'table', extensions: ['csv', 'tsv'], defaultView: 'source' },
    { id: 'mermaid', extensions: ['mermaid', 'mmd'], defaultView: 'source' },
    { id: 'pdf', extensions: ['pdf'], defaultView: 'preview' },
    // Source stays the default because Agents edit pages; a Chat or Terminal link opens the preview instead
    // (`desktop.openFile`'s `showPreview`), since clicking a generated report means reading it.
    { id: 'html', extensions: ['htm', 'html'], defaultView: 'source', localOnly: true },
];

export function previewerForPath(path: string): PreviewerRegistration | undefined {
    const extension = filePreviewExtension(path);
    if (!extension) return undefined;
    return PREVIEWERS.find((previewer) => previewer.extensions.includes(extension));
}

/**
 * Whether this window can show a preview of `path`. Every preview entry point (the commands, the tab rail, the context
 * menus, a link's `showPreview`) asks this, so a format this window cannot serve disappears from all of them at once.
 */
export function canPreviewPath(path: string): boolean {
    const previewer = previewerForPath(path);
    return previewer !== undefined && (!previewer.localOnly || isLocalOnlyAvailable());
}

/**
 * Whether opening `path` should show its preview rather than its source: true only for a format with no text form.
 */
export function shouldOpenAsPreview(path: string): boolean {
    return previewerForPath(path)?.defaultView === 'preview';
}

/**
 * The preview tab opening `path` lands on without a text read, if any: the preview of a format with no text form (a
 * PDF), or the no-preview tab already open for a file an earlier read found binary, so opening it again only activates
 * that tab instead of re-reading the bytes (https://github.com/tjx666/caxri/issues/1921).
 */
export function previewOnlyTabPath(
    path: string,
    paneLayout: PaneLayout | undefined,
): string | undefined {
    const tabPath = filePreviewTabPath(path);
    if (shouldOpenAsPreview(path)) return tabPath;
    if (!paneLayout || previewerForPath(path)) return undefined;
    return findResourceTabs(paneLayout, { kind: 'file', path: tabPath }).length > 0
        ? tabPath
        : undefined;
}
