import type { FileEntry } from '@caxri/protocol';

import { parentDirectoryPath, projectRelativePath } from '../../lib/file-path';

export interface EditorBreadcrumbSegment {
    kind: 'directory' | 'file';
    label: string;
    path: string;
    relativePath: string;
}

/**
 * Builds the Project-relative filesystem chain shown above an ordinary file editor. Returning no segments for an
 * out-of-Project path keeps virtual and externally authorized documents from implying Project authority in the UI.
 */
export function editorBreadcrumbSegments(
    path: string,
    projectRoot: string,
): EditorBreadcrumbSegment[] {
    const relativePath = projectRelativePath(path, projectRoot);
    if (!relativePath || relativePath === '.') return [];
    const labels = relativePath.split('/').filter(Boolean);
    return labels.map((label, index) => {
        const segmentRelativePath = labels.slice(0, index + 1).join('/');
        return {
            kind: index === labels.length - 1 ? 'file' : 'directory',
            label,
            path:
                projectRoot === '/'
                    ? `/${segmentRelativePath}`
                    : `${projectRoot}/${segmentRelativePath}`,
            relativePath: segmentRelativePath,
        };
    });
}

export interface ReadOnlyBreadcrumbSegment {
    label: string;
    /**
     * The trail down to and including this segment. A name can repeat inside one path (`src/app/src`), so the label
     * alone is not a stable React key; the prefix is unique by construction.
     */
    trail: string;
}

/**
 * Segments for a document the Project cannot browse: a file opened from outside every Project root, or one side of a
 * Git diff. The trail is display-only for exactly that reason: there is no authorized directory listing behind a
 * segment, so offering a picker would promise navigation the Renderer cannot perform.
 *
 * An absolute path keeps every ancestor (VS Code shows the same full trail for a file outside the workspace); a
 * repository-relative diff path keeps the segments it already is.
 */
export function readOnlyBreadcrumbSegments(path: string): ReadOnlyBreadcrumbSegment[] {
    const labels = path.split('/').filter(Boolean);
    return labels.map((label, index) => ({
        label,
        trail: labels.slice(0, index + 1).join('/'),
    }));
}

/**
 * VS Code opens a file breadcrumb on its containing directory, showing the selected segment among its siblings.
 */
export function editorBreadcrumbPickerDirectory(segment: EditorBreadcrumbSegment): string {
    return parentDirectoryPath(segment.path);
}

export function editorBreadcrumbDirectoryLabel(directory: string, projectRoot: string): string {
    const relativePath = projectRelativePath(directory, projectRoot);
    return relativePath === '.' ? 'Project root' : (relativePath ?? directory);
}

type PickerEntry = Pick<FileEntry, 'kind' | 'name' | 'path'>;

export function adjacentBreadcrumbPickerPath(
    entries: readonly PickerEntry[],
    activePath: string | undefined,
    destination: 'first' | 'last' | 'next' | 'previous',
): string | undefined {
    const navigable = entries;
    if (navigable.length === 0) return undefined;
    if (destination === 'first') return navigable[0].path;
    if (destination === 'last') return navigable.at(-1)?.path;
    const currentIndex = navigable.findIndex((entry) => entry.path === activePath);
    if (currentIndex === -1)
        return destination === 'next' ? navigable[0].path : navigable.at(-1)?.path;
    const nextIndex = currentIndex + (destination === 'next' ? 1 : -1);
    return navigable.at(Math.max(0, Math.min(navigable.length - 1, nextIndex)))?.path;
}

export function typeaheadBreadcrumbPickerPath(
    entries: readonly PickerEntry[],
    activePath: string | undefined,
    prefix: string,
): string | undefined {
    const navigable = entries;
    if (!prefix || navigable.length === 0) return undefined;
    const currentIndex = navigable.findIndex((entry) => entry.path === activePath);
    const startingIndex = currentIndex === -1 ? -1 : currentIndex;
    const normalizedPrefix = prefix.toLocaleLowerCase();
    for (let offset = 1; offset <= navigable.length; offset += 1) {
        const index = (startingIndex + offset) % navigable.length;
        const entry = navigable[index];
        if (entry.name.toLocaleLowerCase().startsWith(normalizedPrefix)) return entry.path;
    }
    return undefined;
}
