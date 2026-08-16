import { createHash } from 'node:crypto';

import { captureCommand } from './command-runner';

export interface WorktreeIntegrity {
    clean: boolean;
    headSha: string;
    sourceFingerprint: string;
}

export interface WorktreeDelta {
    commitCount: number;
    fileCount: number;
    headSha: string;
}

/**
 * Fingerprints only Git-visible source state. Ignored build, log, and `.records/` artifacts are excluded by Git itself,
 * while tracked edits and non-ignored untracked files remain observable.
 */
export async function inspectWorktreeIntegrity(worktreePath: string): Promise<WorktreeIntegrity> {
    const [headSha, status] = await Promise.all([
        captureCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath }),
        captureCommand(
            'git',
            ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'],
            { cwd: worktreePath },
        ),
    ]);
    return {
        clean: status.length === 0,
        headSha,
        sourceFingerprint: createHash('sha256').update(`${headSha}\0${status}`).digest('hex'),
    };
}

export function assertCleanValidationStart(
    integrity: WorktreeIntegrity,
    expectedHeadSha?: string,
): void {
    if (expectedHeadSha && expectedHeadSha !== integrity.headSha) {
        throw new Error(
            `Expected validation head ${expectedHeadSha}, but recorded worktree is ${integrity.headSha}`,
        );
    }
    if (!integrity.clean) {
        throw new Error('Validation requires a clean recorded worktree source fingerprint');
    }
}

/**
 * Measures the committed source delta between two durable issue boundaries.
 */
export async function inspectWorktreeDelta(
    worktreePath: string,
    baseSha: string,
): Promise<WorktreeDelta> {
    const [headSha, commitCount, changedFiles] = await Promise.all([
        captureCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: worktreePath }),
        captureCommand('git', ['rev-list', '--count', `${baseSha}..HEAD`], {
            cwd: worktreePath,
        }),
        captureCommand('git', ['diff', '--name-only', '-z', `${baseSha}..HEAD`], {
            cwd: worktreePath,
        }),
    ]);
    return {
        commitCount: Number(commitCount),
        fileCount: changedFiles ? changedFiles.split('\0').filter(Boolean).length : 0,
        headSha,
    };
}
