import { compareTreeNodesDirectoriesFirst } from '@caxri/utils';
import type { GitCommitDetails, GitFileStatus, GitRepositorySummary } from '@shared/types';

interface GitFileTreeDirectory {
    children: GitFileTreeNode[];
    kind: 'directory';
    name: string;
    path: string;
}

interface GitFileTreeFile {
    file: GitFileStatus;
    kind: 'file';
    name: string;
    path: string;
}

export type GitFileTreeNode = GitFileTreeDirectory | GitFileTreeFile;

function sortNodes(nodes: GitFileTreeNode[]): GitFileTreeNode[] {
    return nodes.toSorted(compareTreeNodesDirectoriesFirst);
}

/**
 * Places one file's path segments into the tree rooted at `directory`, creating intermediate directory nodes as needed.
 * Split out of `buildGitFileTree`'s outer loop so the last-segment short-circuit can `return` instead of using
 * `continue` inside a nested loop.
 */
function placeFile(root: GitFileTreeDirectory, file: GitFileStatus): void {
    const parts = file.path.split('/').filter(Boolean);
    let directory = root;
    for (const [index, name] of parts.entries()) {
        const path = parts.slice(0, index + 1).join('/');
        if (index === parts.length - 1) {
            directory.children.push({ file, kind: 'file', name, path: file.path });
            return;
        }
        let child = directory.children.find(
            (candidate): candidate is GitFileTreeDirectory =>
                candidate.kind === 'directory' && candidate.name === name,
        );
        if (!child) {
            child = { children: [], kind: 'directory', name, path };
            directory.children.push(child);
        }
        directory = child;
    }
}

/**
 * Maps a repository's changed-file paths to the sibling submodule repositories they point at. A submodule bump shows up
 * in the parent's status as a modified entry at the submodule's mount path; that entry has no meaningful file diff, so
 * the panel renders it as a jump target to the submodule's own repository section instead.
 */
export function submoduleRepositoriesByPath(
    repo: Pick<GitRepositorySummary, 'id' | 'rootPath'>,
    repositories: readonly GitRepositorySummary[],
): Map<string, GitRepositorySummary> {
    const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '');
    const parentRoot = normalize(repo.rootPath);
    const byPath = new Map<string, GitRepositorySummary>();
    for (const candidate of repositories) {
        if (candidate.kind !== 'submodule' || candidate.id === repo.id) continue;
        const candidateRoot = normalize(candidate.rootPath);
        if (!candidateRoot.startsWith(`${parentRoot}/`)) continue;
        byPath.set(candidateRoot.slice(parentRoot.length + 1), candidate);
    }
    return byPath;
}

const commitStatusToTreeStatus: Record<
    GitCommitDetails['files'][number]['status'],
    { kind: GitFileStatus['kind']; letter: string }
> = {
    'modified': { kind: 'modified', letter: 'M' },
    'added': { kind: 'added', letter: 'A' },
    'deleted': { kind: 'deleted', letter: 'D' },
    'renamed': { kind: 'renamed', letter: 'R' },
    'copied': { kind: 'added', letter: 'C' },
    'type-changed': { kind: 'modified', letter: 'T' },
    'unknown': { kind: 'modified', letter: '?' },
};

/**
 * Projects a commit's file list into the working-tree status shape so the panel's file tree and status letters render
 * commit-mode changes through the same components.
 */
export function commitFilesToStatuses(files: GitCommitDetails['files']): GitFileStatus[] {
    return files.map((file) => {
        const status = commitStatusToTreeStatus[file.status];
        return {
            path: file.path,
            ...(file.previousPath && { originalPath: file.previousPath }),
            index: status.letter,
            workingTree: ' ',
            kind: status.kind,
        };
    });
}

/**
 * Builds directory nodes without changing the repository-relative path used by `git.diffDocument`.
 */
export function buildGitFileTree(files: GitFileStatus[]): GitFileTreeNode[] {
    const root: GitFileTreeDirectory = { children: [], kind: 'directory', name: '', path: '' };
    for (const file of files) placeFile(root, file);
    const sortRecursively = (directory: GitFileTreeDirectory): void => {
        directory.children = sortNodes(directory.children);
        for (const child of directory.children) {
            if (child.kind === 'directory') sortRecursively(child);
        }
    };
    sortRecursively(root);
    return root.children;
}
