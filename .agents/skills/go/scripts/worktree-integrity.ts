import { spawn } from 'node:child_process';
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

function probeGit(worktreePath: string, arguments_: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', arguments_, {
            cwd: worktreePath,
            stdio: 'ignore',
        });
        let isTimedOut = false;
        const timeout = setTimeout(() => {
            isTimedOut = true;
            child.kill('SIGKILL');
        }, 10_000);
        timeout.unref();
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to start Git commit probe: ${error.message}`));
        });
        child.once('close', (code) => {
            clearTimeout(timeout);
            if (isTimedOut) reject(new Error('Git commit probe timed out'));
            else if (code === null)
                reject(new Error('Git commit probe did not report an exit code'));
            else resolve(code);
        });
    });
}

export async function assertGitCommitMissing(
    worktreePath: string,
    revision: string,
): Promise<void> {
    const exitCode = await probeGit(worktreePath, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        [revision, '^{commit}'].join(''),
    ]);
    if (exitCode === 0) throw new Error('Review head reconciliation cannot amend a valid commit');
    if (exitCode !== 1) {
        throw new Error(`Git commit existence probe failed with exit code ${exitCode}`);
    }
}

export async function resolveGitCommit(worktreePath: string, revision: string): Promise<string> {
    return captureCommand(
        'git',
        ['rev-parse', '--verify', '--end-of-options', [revision, '^{commit}'].join('')],
        { cwd: worktreePath },
    );
}

export async function assertGitAncestor(
    worktreePath: string,
    ancestor: string,
    descendant: string,
): Promise<void> {
    const exitCode = await probeGit(worktreePath, [
        'merge-base',
        '--is-ancestor',
        ancestor,
        descendant,
    ]);
    if (exitCode === 1) throw new Error('Review parent is not an ancestor of the current HEAD');
    if (exitCode !== 0) throw new Error(`Git ancestry probe failed with exit code ${exitCode}`);
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
