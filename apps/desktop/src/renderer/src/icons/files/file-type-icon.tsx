import type { FileEntry } from '@caxri/protocol';

import type { GitChildRepoKind } from '../../lib/git-decorations';
import { ArchiveIcon } from '../codicons/archive-icon';
import { RepoIcon } from '../codicons/repo-icon';
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

/**
 * A submodule or nested clone takes the glyph Source Control and Project Status already give that repository (`archive`
 * for a submodule, `repo` for a nested clone) in place of a folder. A neutral folder wearing a small Git badge still
 * read as one more folder among the themed ones, and did not say which kind of repository it was; the shared glyph
 * names the kind and ties this row to the same repository's rows in the other two panels.
 */
function ChildRepoIcon({ kind }: { kind: GitChildRepoKind }) {
    const Icon = kind === 'submodule' ? ArchiveIcon : RepoIcon;
    return (
        <Icon
            className="file-type-icon flex-none text-foreground"
            data-child-repo-icon={kind}
            size={16}
        />
    );
}

export function FileTypeIcon({
    entry,
    expanded = false,
    childRepo,
}: {
    entry: Pick<FileEntry, 'kind' | 'linkKind' | 'linkTarget' | 'name'>;
    expanded?: boolean;
    /**
     * Set when this directory is a submodule or a nested clone, which takes its repository glyph instead of a folder.
     */
    childRepo?: GitChildRepoKind;
}) {
    if (childRepo && (entry.kind === 'directory' || entry.linkKind === 'directory'))
        return <ChildRepoIcon kind={childRepo} />;
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
