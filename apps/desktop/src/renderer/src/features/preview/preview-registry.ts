import { filePreviewExtension } from '@caxri/protocol';

/**
 * Which rendered view a preview tab shows. One entry per registered format family.
 */
type PreviewViewId = 'image' | 'markdown';

export interface PreviewerRegistration {
    id: PreviewViewId;
    /**
     * Lowercased extensions without the leading dot.
     */
    extensions: readonly string[];
    /**
     * What double-clicking the file in the explorer opens.
     *
     * Every format registered today is also readable as text, so source stays the default and the preview is an
     * explicit command; VS Code makes the same call with `priority.textEditor: 'option'`. A format with no useful text
     * form (a spreadsheet, say) registers `preview` instead, and nothing else about the surface changes.
     */
    defaultView: 'preview' | 'source';
}

const PREVIEWERS: readonly PreviewerRegistration[] = [
    { id: 'markdown', extensions: ['markdown', 'md', 'mdx'], defaultView: 'source' },
    { id: 'image', extensions: ['svg'], defaultView: 'source' },
];

export function previewerForPath(path: string): PreviewerRegistration | undefined {
    const extension = filePreviewExtension(path);
    if (!extension) return undefined;
    return PREVIEWERS.find((previewer) => previewer.extensions.includes(extension));
}

export function canPreviewPath(path: string): boolean {
    return previewerForPath(path) !== undefined;
}
