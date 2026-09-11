import type { GitFileStatus, GitSummary } from '@caxri/protocol';

import { resolveRepositoryFilePath as resolveRepoFilePath } from './repository-file-path';

export type GitDecorationKind = GitFileStatus['kind'];

export interface GitDecoration {
    kind: GitDecorationKind;
    /**
     * The single status letter VS Code puts at the end of a changed row (`M`, `A`, `U`…), or `undefined` for a
     * directory, which inherits only the color of the strongest change beneath it.
     */
    letter?: string;
}

/**
 * Absolute filesystem path to the decoration that path carries, covering changed files and every ancestor directory up
 * to the owning repository root.
 */
export type GitDecorationIndex = ReadonlyMap<string, GitDecoration>;

export const EMPTY_GIT_DECORATION_INDEX: GitDecorationIndex = new Map();

/**
 * Which change wins when a directory contains several. A conflict is the one a user must act on before anything else,
 * and a deletion is structurally louder than an edit; untracked loses to everything because an unopened folder full of
 * new files should not outrank a real edit beside it.
 */
const KIND_SEVERITY: Record<GitDecorationKind, number> = {
    conflicted: 5,
    deleted: 4,
    modified: 3,
    renamed: 2,
    added: 1,
    untracked: 0,
};

/**
 * Tailwind text color for a change kind. `renamed` shares the untracked color because that is what VS Code's two
 * decoration defaults resolve to, and both themes that override them keep the pair together.
 */
const KIND_CLASS_NAME: Record<GitDecorationKind, string> = {
    added: 'text-git-added',
    conflicted: 'text-git-conflicting',
    deleted: 'text-git-deleted',
    modified: 'text-git-modified',
    renamed: 'text-git-untracked',
    untracked: 'text-git-untracked',
};

export function gitDecorationClassName(kind: GitDecorationKind): string {
    return KIND_CLASS_NAME[kind];
}

/**
 * The decoration one changed file wears. `git status --porcelain=v2` reports two columns; the staged one wins when it
 * is set, so a file staged as added and then edited reads `A` here exactly as it does in Source Control.
 */
export function gitDecorationForFile(file: GitFileStatus): GitDecoration {
    return { kind: file.kind, letter: file.index === ' ' ? file.workingTree : file.index };
}

function recordAncestors(
    index: Map<string, GitDecoration>,
    repoRootPath: string,
    absolutePath: string,
    kind: GitDecorationKind,
): void {
    // Strictly below the repository root: VS Code decorates the folders inside a repository, never the root itself.
    let directory = absolutePath.slice(0, absolutePath.lastIndexOf('/'));
    while (directory.length > repoRootPath.length && directory.startsWith(repoRootPath)) {
        const current = index.get(directory);
        // Every shallower ancestor already holds at least this severity, so there is nothing left to raise.
        if (current && KIND_SEVERITY[current.kind] >= KIND_SEVERITY[kind]) break;
        index.set(directory, { kind });
        directory = directory.slice(0, directory.lastIndexOf('/'));
    }
}

function recordRepo(
    index: Map<string, GitDecoration>,
    repo: GitSummary['repositories'][number],
): void {
    for (const file of repo.files) {
        const absolutePath = resolveRepoFilePath(repo.rootPath, file.path);
        // A path that escapes its repository root is not a file the tree can show; drop it rather than guess.
        if (!absolutePath) continue;
        index.set(absolutePath, gitDecorationForFile(file));
        recordAncestors(index, repo.rootPath, absolutePath, file.kind);
    }
}

/**
 * Carries every unchanged entry's previous object over into `next`, and hands back `previous` untouched when nothing
 * moved at all.
 *
 * Rows subscribe to their own path (`stores/git-decorations.ts`), so identity is what decides how much of the tree
 * re-renders: a fresh object for a file Git still reports as modified would repaint a row whose decoration did not
 * change. Git re-reports its whole working tree on every write an Agent makes, so without this each save would
 * re-render every decorated row in the Workbench.
 */
function withPreservedIdentity(
    previous: GitDecorationIndex,
    next: Map<string, GitDecoration>,
): GitDecorationIndex {
    let reused = 0;
    for (const [path, decoration] of next) {
        const before = previous.get(path);
        if (!before || before.kind !== decoration.kind || before.letter !== decoration.letter)
            continue;
        next.set(path, before);
        reused += 1;
    }
    return reused === next.size && reused === previous.size ? previous : next;
}

/**
 * Flattens every repository in a Git summary into one path-keyed lookup the file tree and tab strip can read without
 * knowing which repository a path belongs to.
 *
 * Ancestor directories are folded in during the same pass rather than resolved per row: a row-time walk would rescan
 * the change list once per visible directory, and the tree renders hundreds of rows against a list that only changes
 * when Git does.
 *
 * @param summary The selected Session's Git status, or `undefined` before it has loaded.
 * @param previous The index this one replaces; its entries are reused wherever the decoration is unchanged.
 */
export function buildGitDecorationIndex(
    summary: GitSummary | undefined,
    previous: GitDecorationIndex = EMPTY_GIT_DECORATION_INDEX,
): GitDecorationIndex {
    if (!summary?.isRepository) return previous.size === 0 ? previous : EMPTY_GIT_DECORATION_INDEX;
    const index = new Map<string, GitDecoration>();
    for (const repo of summary.repositories) recordRepo(index, repo);
    return withPreservedIdentity(previous, index);
}
