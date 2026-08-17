import type { FileEntry } from '@shared/types';
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

export function resolveFileIcon(
    entry: Pick<FileEntry, 'kind' | 'name'>,
    isExpanded = false,
): ResolvedFileIcon {
    if (entry.kind === 'directory') {
        const lowerName = entry.name.toLowerCase();
        const filename = isExpanded ? getIconForOpenFolder(lowerName) : getIconForFolder(lowerName);
        return toResolvedIcon(filename);
    }
    return toResolvedIcon(resolveFileIconFilename(entry.name));
}
