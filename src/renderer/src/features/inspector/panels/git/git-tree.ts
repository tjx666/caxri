import type { GitFileStatus } from '@shared/types';

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
    return nodes.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name);
    });
}

/** Builds directory nodes without changing the repository-relative path used by `git.diffDocument`. */
export function buildGitFileTree(files: GitFileStatus[]): GitFileTreeNode[] {
    const root: GitFileTreeDirectory = { children: [], kind: 'directory', name: '', path: '' };
    for (const file of files) {
        const parts = file.path.split('/').filter(Boolean);
        let directory = root;
        for (const [index, name] of parts.entries()) {
            const path = parts.slice(0, index + 1).join('/');
            if (index === parts.length - 1) {
                directory.children.push({ file, kind: 'file', name, path: file.path });
                continue;
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
    const sortRecursively = (directory: GitFileTreeDirectory): void => {
        sortNodes(directory.children);
        for (const child of directory.children) {
            if (child.kind === 'directory') sortRecursively(child);
        }
    };
    sortRecursively(root);
    return root.children;
}
