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

function navigablePickerEntries(entries: readonly PickerEntry[]): readonly PickerEntry[] {
    return entries.filter((entry) => entry.kind !== 'symlink');
}

export function adjacentBreadcrumbPickerPath(
    entries: readonly PickerEntry[],
    activePath: string | undefined,
    destination: 'first' | 'last' | 'next' | 'previous',
): string | undefined {
    const navigable = navigablePickerEntries(entries);
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
    const navigable = navigablePickerEntries(entries);
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
