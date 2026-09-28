import type { FileEntry } from '@caxri/protocol';

import type { GitChildRepoKind } from '../../lib/git-decorations';
import { getVscodeIconUrl } from './file-icon-assets';
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
 * A submodule or nested clone wears vscode-icons' Git folder, so it reads as a repository while staying in the same
 * colored folder family as its neighbors. The monochrome `archive`/`repo` codicons it wore before looked foreign beside
 * themed folders and did not say "repository". The row description and tooltip still name which kind it is.
 */
function ChildRepoIcon({ expanded, kind }: { expanded: boolean; kind: GitChildRepoKind }) {
    return (
        <img
            alt=""
            aria-hidden="true"
            className="file-type-icon h-4 w-4 flex-none object-contain"
            data-child-repo-icon={kind}
            draggable={false}
            src={getVscodeIconUrl(expanded ? 'folder_type_git_opened.svg' : 'folder_type_git.svg')}
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
     * Set when this directory is a submodule or a nested clone, which takes the Git folder icon.
     */
    childRepo?: GitChildRepoKind;
}) {
    if (childRepo && (entry.kind === 'directory' || entry.linkKind === 'directory'))
        return <ChildRepoIcon expanded={expanded} kind={childRepo} />;
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
