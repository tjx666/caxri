import type { GitFileStatus, GitSummary } from '@caxri/protocol';

import type { Translate } from '../i18n';
import { translate } from '../i18n';
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
 * to, but not including, the Workbench Root's own repository root. A submodule or nested-repository root in between is
 * decorated like any other folder.
 */
export type GitDecorationIndex = ReadonlyMap<string, GitDecoration>;

export const EMPTY_GIT_DECORATION_INDEX: GitDecorationIndex = new Map();

/**
 * A repository that lives inside the Project's own: a `.gitmodules`-declared submodule, or a directory someone cloned
 * in on their own. Linked worktrees and the Project's own repository are deliberately absent: a worktree is a peer
 * checkout rather than something nested in this tree, and the Project root is not a folder the tree draws.
 */
export type GitChildRepoKind = 'submodule' | 'nested';

/**
 * Absolute path of every child repository root to what kind of child it is.
 */
export type GitChildRepoIndex = ReadonlyMap<string, GitChildRepoKind>;

export const EMPTY_GIT_CHILD_REPO_INDEX: GitChildRepoIndex = new Map();

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
 * Reads a Source Control decoration's `identifier` back as a Git change kind, or `undefined` when it names something
 * else.
 *
 * The Extension API lets any provider label a resource, so the identifier is an open string on the wire; Caxri's Git
 * extension sets it to the change kind (`source-control-model.ts`), which is what lets the Source Control panel paint
 * the same `--git-*` roles the Files tree, tab strip, and diff headers already use. A provider that is not Git falls
 * back to the decoration's generic `tone`.
 */
export function asGitDecorationKind(identifier: string): GitDecorationKind | undefined {
    // `Object.hasOwn`, not `in`: the identifier arrives from an extension and `[a-z0-9-]+` admits `constructor`.
    return Object.hasOwn(KIND_CLASS_NAME, identifier)
        ? (identifier as GitDecorationKind)
        : undefined;
}

/**
 * What a screen reader hears in place of the color and the status letter, which are both invisible to it.
 *
 * Prefixed with `Git:` because a tab already describes an unsaved buffer as "Unsaved changes"; without the prefix a
 * modified-and-unsaved tab would announce two unqualified change states and leave the listener to guess which is
 * which.
 *
 * A component passes its own `t` so the description follows a language change; the `translate` default serves callers
 * outside React.
 */
export function gitDecorationDescription(
    kind: GitDecorationKind,
    t: Translate = translate,
): string {
    return t('core.gitDecoration.description', { kind: t(`core.gitDecoration.kind.${kind}`) });
}

/**
 * What the folder's repository icon means, for a screen reader and for the row's hover tooltip. Both read it, so the
 * wording a user sees on hover is the wording a user hears.
 */
export function gitChildRepoDescription(kind: GitChildRepoKind, t: Translate = translate): string {
    return t(`core.gitDecoration.childRepo.${kind}`);
}

/**
 * The decoration one changed file wears. `git status --porcelain=v2` reports two columns; the staged one wins when it
 * is set, so a file staged as added and then edited reads `A` here exactly as it does in Source Control.
 */
export function gitDecorationForFile(file: GitFileStatus): GitDecoration {
    return { kind: file.kind, letter: file.index === ' ' ? file.workingTree : file.index };
}

/**
 * Raises a directory row to `kind` when nothing louder is already there, and reports whether it moved.
 *
 * Directory decorations are order-independent by construction: the result is the maximum severity written to that path,
 * whatever sequence the writes arrive in. That matters because two unrelated writers reach a child repository's root
 * (the parent repository reports the child as one gitlink change, and the child's own contents climb to it), and which
 * one runs first is just the order `summary.repositories` happens to hold.
 *
 * Never carries a letter. A letter claims the entry itself changed, and every path this writes is a folder in the tree,
 * including a child repository root reported as a gitlink.
 */
function didRaiseDirectory(
    index: Map<string, GitDecoration>,
    absolutePath: string,
    kind: GitDecorationKind,
): boolean {
    const current = index.get(absolutePath);
    if (current && KIND_SEVERITY[current.kind] >= KIND_SEVERITY[kind]) return false;
    index.set(absolutePath, { kind });
    return true;
}

function recordAncestors(
    index: Map<string, GitDecoration>,
    boundaryPath: string,
    absolutePath: string,
    kind: GitDecorationKind,
): void {
    // Strictly below the boundary: the Workbench Root's own repository root is the one folder that stays undecorated.
    // The trailing separator is what makes "below" mean containment rather than a string prefix. Without it a boundary
    // of `/repo` also swallows `/repo-vendor`, a sibling directory that shares the prefix and none of the ancestors:
    // reachable whenever a symlinked child repository canonicalizes to such a sibling path.
    const boundaryPrefix = boundaryPath.endsWith('/') ? boundaryPath : `${boundaryPath}/`;
    let directory = absolutePath.slice(0, absolutePath.lastIndexOf('/'));
    while (directory.length > boundaryPath.length && directory.startsWith(boundaryPrefix)) {
        // Every shallower ancestor already holds at least this severity, so there is nothing left to raise.
        if (!didRaiseDirectory(index, directory, kind)) break;
        directory = directory.slice(0, directory.lastIndexOf('/'));
    }
}

function recordRepo(
    index: Map<string, GitDecoration>,
    repo: GitSummary['repositories'][number],
    boundaryPath: string,
    repoRoots: ReadonlySet<string>,
): void {
    for (const file of repo.files) {
        const absolutePath = resolveRepoFilePath(repo.rootPath, file.path);
        // A path that escapes its repository root is not a file the tree can show; drop it rather than guess.
        if (!absolutePath) continue;
        if (repoRoots.has(absolutePath)) didRaiseDirectory(index, absolutePath, file.kind);
        else index.set(absolutePath, gitDecorationForFile(file));
        recordAncestors(index, boundaryPath, absolutePath, file.kind);
    }
}

/**
 * Where ancestor propagation stops: the repository root of the selected Workbench Root itself.
 *
 * A change inside a submodule is still a change the user needs to see once its folder is collapsed, so a child
 * repository root is a destination rather than a wall, only the one root the tree never draws is excluded. A linked
 * worktree counts as that root too: it is a peer checkout of the Project's own repository, not something nested in it.
 *
 * The shallowest such root wins if a summary ever reports more than one, since propagation has to stop at the outermost
 * of them for the inner one's ancestors to be reachable at all. `undefined` means the summary named no root of that
 * kind; each repository then bounds its own climb at its own root, and a child root another repository reports as a
 * gitlink still loses its letter, because a folder row never carries one whichever repository named it.
 */
function propagationBoundary(summary: GitSummary): string | undefined {
    let boundary: string | undefined;
    for (const repo of summary.repositories) {
        if (repo.kind !== 'primary' && repo.kind !== 'worktree') continue;
        if (boundary === undefined || repo.rootPath.length < boundary.length)
            boundary = repo.rootPath;
    }
    return boundary;
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
    const boundary = propagationBoundary(summary);
    // The boundary is the one root the tree never draws, so it is not a child root a gitlink could decorate either.
    const repoRoots = new Set<string>();
    for (const repo of summary.repositories)
        if (repo.rootPath !== boundary) repoRoots.add(repo.rootPath);
    for (const repo of summary.repositories)
        recordRepo(index, repo, boundary ?? repo.rootPath, repoRoots);
    return withPreservedIdentity(previous, index);
}

function isSameChildRepoIndex(previous: GitChildRepoIndex, next: GitChildRepoIndex): boolean {
    if (previous.size !== next.size) return false;
    for (const [path, kind] of next) if (previous.get(path) !== kind) return false;
    return true;
}

/**
 * Which directories in the tree are repositories of their own.
 *
 * Returns `previous` whenever the set is unchanged, which is almost always: a submodule appears when someone adds one,
 * while the summary this reads from is rebuilt on every file an Agent writes. Holding the same object keeps the store
 * from waking every row's selector for a fact that did not move.
 *
 * @param summary The selected Session's Git status, or `undefined` before it has loaded.
 * @param previous The index this one replaces.
 */
export function buildGitChildRepoIndex(
    summary: GitSummary | undefined,
    previous: GitChildRepoIndex = EMPTY_GIT_CHILD_REPO_INDEX,
): GitChildRepoIndex {
    const index = new Map<string, GitChildRepoKind>();
    if (summary?.isRepository)
        for (const repo of summary.repositories)
            if (repo.kind === 'submodule' || repo.kind === 'nested')
                index.set(repo.rootPath, repo.kind);
    return isSameChildRepoIndex(previous, index) ? previous : index;
}
