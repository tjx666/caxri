import type { FileEntry } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import {
    DEFAULT_FILE,
    DEFAULT_FOLDER,
    DEFAULT_FOLDER_OPENED,
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
 * The Git logo, worn as a corner badge by a submodule or independently cloned directory. The folder underneath stays
 * the neutral one so the badge is the only thing that differs from an ordinary folder: `folder_type_git` bakes the logo
 * into a red folder that reads as just another themed folder beside `docs` or `e2e`, while a plain folder carrying the
 * universally known Git mark is unmistakably "a repository in here".
 */
export const GIT_REPOSITORY_BADGE: ResolvedFileIcon = toResolvedIcon('file_type_git.svg');

/**
 * A symlink is resolved by what it points at, so a linked folder reads as a folder instead of an untyped placeholder. A
 * broken link deliberately keeps the neutral default icon: guessing a type from a name whose target is gone would
 * present a confident answer the filesystem cannot back.
 *
 * Being a repository of its own outranks the folder's name: that `example` is a submodule matters more than that it is
 * called `example`, so a child repository takes the neutral folder and {@link GIT_REPOSITORY_BADGE} says the rest.
 *
 * @param entry The row this icon belongs to.
 * @param isExpanded Whether a directory row is open, which selects the matching `_opened` asset.
 * @param isChildRepo Whether this directory is a submodule or a nested clone.
 */
export function resolveFileIcon(
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>,
    isExpanded = false,
    isChildRepo = false,
): ResolvedFileIcon {
    if (entry.kind === 'directory' || entry.linkKind === 'directory') {
        if (isChildRepo) return toResolvedIcon(isExpanded ? DEFAULT_FOLDER_OPENED : DEFAULT_FOLDER);
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
