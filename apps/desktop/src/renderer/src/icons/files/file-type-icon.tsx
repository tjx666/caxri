import type { FileEntry } from '@caxri/protocol';

import { GIT_REPOSITORY_BADGE, resolveFileIcon } from './file-icon-resolver';

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

/**
 * Marks a submodule or nested clone with the Git logo in the folder's lower-right corner. The stacked `drop-shadow`s
 * trace a `--surface` outline around the diamond itself rather than a box behind it, the same separation the symlink
 * arrow gets from its double stroke.
 */
function ChildRepoBadge() {
    return (
        <img
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 [filter:drop-shadow(1px_0_0_var(--surface))_drop-shadow(-1px_0_0_var(--surface))_drop-shadow(0_1px_0_var(--surface))_drop-shadow(0_-1px_0_var(--surface))]"
            data-file-icon-badge={GIT_REPOSITORY_BADGE.id}
            draggable={false}
            src={GIT_REPOSITORY_BADGE.src}
        />
    );
}

export function FileTypeIcon({
    entry,
    expanded = false,
    childRepo: childRepo = false,
}: {
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>;
    expanded?: boolean;
    /**
     * Whether this directory is a submodule or a nested clone, which takes a neutral folder wearing the Git badge.
     */
    childRepo?: boolean;
}) {
    const icon = resolveFileIcon(entry, expanded, childRepo);
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
    if (childRepo && (entry.kind === 'directory' || entry.linkKind === 'directory'))
        return (
            <span className="relative flex h-4 w-4 flex-none" data-child-repo-icon="">
                {image}
                <ChildRepoBadge />
            </span>
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
