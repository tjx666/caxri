import type { GitCommitFile } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

function commitFileStatus(code: string): GitCommitFile['status'] {
    if (code.startsWith('A')) return 'added';
    if (code.startsWith('D')) return 'deleted';
    if (code.startsWith('R')) return 'renamed';
    if (code.startsWith('C')) return 'copied';
    if (code.startsWith('T')) return 'type-changed';
    if (code.startsWith('M')) return 'modified';
    return 'unknown';
}

export function parseCommitFiles(output: string): GitCommitFile[] {
    const fields = output.split('\0').filter(Boolean);
    const files: GitCommitFile[] = [];
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) break;
        if (code.startsWith('R') || code.startsWith('C')) {
            const previousPath = fields[index++];
            const path = fields[index++];
            if (!path || !previousPath)
                throw new CaxriError('GIT', 'Git returned malformed commit files');
            files.push({ path, previousPath, status: commitFileStatus(code) });
            continue;
        }
        const path = fields[index++];
        if (!path) throw new CaxriError('GIT', 'Git returned malformed commit files');
        files.push({ path, status: commitFileStatus(code) });
    }
    return files;
}

/**
 * Sums `git diff-tree --numstat -z` output, including rename/copy records and binary-file placeholders.
 */
export function sumCommitNumstat(output: string): { additions: number; deletions: number } {
    const fields = output.split('\0');
    let additions = 0;
    let deletions = 0;
    for (let index = 0; index < fields.length; index += 1) {
        // `[^]` (rather than `.`) includes legal newlines embedded in a NUL-delimited Git filename.
        const record = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
        if (!record) continue;
        if (record[1] !== '-') additions += Number(record[1]);
        if (record[2] !== '-') deletions += Number(record[2]);
        if (record[3] === '') index += 2;
    }
    return { additions, deletions };
}
