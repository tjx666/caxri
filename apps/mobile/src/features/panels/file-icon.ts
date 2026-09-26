import type { FileEntry } from '@caxri/protocol';

import {
    FILE_ICON_DEFAULTS,
    FILE_ICON_EXTENSIONS,
    FILE_ICON_NAMES,
    FILE_ICON_SVGS,
    FOLDER_ICON_NAMES,
} from './file-icons.generated';

type IconEntry = Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Mirrors the order of `@yutengjing/vscode-icons`' `getIconForFile` over the embedded subset: an exact file name wins,
 * then the longest extension suffix, so `app.test.ts` takes the test icon before the TypeScript one.
 */
const iconForFileName = (name: string): string | undefined => {
    const lowercased = name.toLowerCase();
    const exact = FILE_ICON_NAMES[lowercased];
    if (exact) return exact;
    const segments = lowercased.split('.');
    for (let start = 1; start < segments.length; start += 1) {
        const icon = FILE_ICON_EXTENSIONS[segments.slice(start).join('.')];
        if (icon) return icon;
    }
    return undefined;
};

/**
 * Resolves the same icon Desktop's Files explorer shows, restricted to the subset embedded in the mobile bundle.
 * Symlinks resolve by their target's kind; a broken link keeps the neutral default instead of guessing from its name.
 *
 * @returns An id that always has an entry in `FILE_ICON_SVGS`.
 */
export const resolveFileIconId = (entry: IconEntry): string => {
    if (entry.kind === 'directory' || entry.linkKind === 'directory')
        return FOLDER_ICON_NAMES[entry.name.toLowerCase()] ?? FILE_ICON_DEFAULTS.folder;
    if (entry.linkKind === 'broken') return FILE_ICON_DEFAULTS.file;
    const icon =
        iconForFileName(entry.name) ??
        (entry.linkKind === 'file' && entry.linkTarget !== undefined
            ? iconForFileName(basename(entry.linkTarget))
            : undefined);
    return icon ?? FILE_ICON_DEFAULTS.file;
};

export const fileIconSvg = (id: string): string =>
    FILE_ICON_SVGS[id] ?? FILE_ICON_SVGS[FILE_ICON_DEFAULTS.file];
