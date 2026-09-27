import type { FileEntry } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import {
    DEFAULT_FILE,
    getIconForFile,
    getIconForFolder,
    getIconForOpenFolder,
} from '@yutengjing/vscode-icons';

import { getVscodeIconUrl } from './file-icon-assets';

export interface ResolvedFileIcon {
    id: string;
    src: string;
}

function toIconId(filename: string): string {
    return filename.replace(/\.svg$/, '');
}

function toResolvedIcon(filename: string): ResolvedFileIcon {
    return { id: toIconId(filename), src: getVscodeIconUrl(filename) };
}

/**
 * `@yutengjing/vscode-icons`'s lookup tables are already case-insensitive, so a single call is enough.
 */
function resolveFileIconFilename(name: string): string {
    return getIconForFile(name) ?? DEFAULT_FILE;
}

/**
 * A symlink is resolved by what it points at, so a linked folder reads as a folder instead of an untyped placeholder. A
 * broken link deliberately keeps the neutral default icon: guessing a type from a name whose target is gone would
 * present a confident answer the filesystem cannot back.
 *
 * @param entry The row this icon belongs to.
 * @param isExpanded Whether a directory row is open, which selects the matching `_opened` asset.
 */
export function resolveFileIcon(
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>,
    isExpanded = false,
): ResolvedFileIcon {
    if (entry.kind === 'directory' || entry.linkKind === 'directory') {
        const lowerName = entry.name.toLowerCase();
        const filename = isExpanded ? getIconForOpenFolder(lowerName) : getIconForFolder(lowerName);
        return toResolvedIcon(filename);
    }
    if (entry.linkKind === 'broken') return toResolvedIcon(DEFAULT_FILE);
    const filename = resolveFileIconFilename(entry.name);
    /**
     * A link's own name usually carries no extension (`current -> app-2026.log`), so fall back to the target's name
     * rather than showing the neutral placeholder the user cannot tell apart from an empty file.
     */
    if (filename === DEFAULT_FILE && entry.linkKind === 'file' && entry.linkTarget !== undefined)
        return toResolvedIcon(resolveFileIconFilename(pathBasename(entry.linkTarget)));
    return toResolvedIcon(filename);
}
