import type { GitCommitDetails, GitFileStatus } from 'caxri';

/**
 * Projects a commit's changed files onto the working-tree status shape the Source Control rows render.
 */
export function commitFilesToStatuses(details: GitCommitDetails | undefined): GitFileStatus[] {
    const status = {
        'modified': { kind: 'modified', letter: 'M' },
        'added': { kind: 'added', letter: 'A' },
        'deleted': { kind: 'deleted', letter: 'D' },
        'renamed': { kind: 'renamed', letter: 'R' },
        'copied': { kind: 'added', letter: 'C' },
        'type-changed': { kind: 'modified', letter: 'T' },
        'unknown': { kind: 'modified', letter: '?' },
    } as const;
    return (details?.files ?? []).map((file) => ({
        path: file.path,
        ...(file.previousPath && { originalPath: file.previousPath }),
        index: status[file.status].letter,
        workingTree: ' ',
        kind: status[file.status].kind,
        ...(file.additions !== undefined && { additions: file.additions }),
        ...(file.deletions !== undefined && { deletions: file.deletions }),
    }));
}
