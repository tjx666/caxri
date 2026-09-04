import type { FileEntry } from '@caxri/protocol';

import { resolveFileIcon } from './file-icon-resolver';

const SYMLINK_ARROW_PATH = 'M2.6 7.4 7.4 2.6M7.4 2.6H4.7M7.4 2.6V5.3';

/**
 * Marks a symlink on top of whichever icon its target resolved to. The arrow is stroked twice — a thick `--surface`
 * outline beneath a `--foreground` stroke — so it stays legible over both the light and dark artwork in the
 * vscode-icons set without covering the icon with an opaque chip.
 */
function SymlinkBadge() {
    return (
        <svg
            aria-hidden="true"
            className="pointer-events-none absolute right-0 bottom-0 h-2.5 w-2.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            viewBox="0 0 10 10"
        >
            <path className="stroke-surface" d={SYMLINK_ARROW_PATH} strokeWidth={3.4} />
            <path className="stroke-foreground" d={SYMLINK_ARROW_PATH} strokeWidth={1.5} />
        </svg>
    );
}

export function FileTypeIcon({
    entry,
    expanded = false,
}: {
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>;
    expanded?: boolean;
}) {
    const icon = resolveFileIcon(entry, expanded);
    const image = (
        <img
            alt=""
            aria-hidden="true"
            className="file-type-icon h-4 w-4 flex-none object-contain"
            data-file-icon={icon.id}
            draggable={false}
            src={icon.src}
        />
    );
    if (entry.kind !== 'symlink') return image;
    return (
        <span
            className="relative flex h-4 w-4 flex-none"
            data-symlink-icon={entry.linkKind ?? 'unknown'}
        >
            {image}
            <SymlinkBadge />
        </span>
    );
}
