import { resolve } from 'node:path';
import process from 'node:process';

import { inspectDesktopLease } from './desktop-lease';
import { CommandError, isProcessIdentityAlive, runCapture } from './process';
import type { RepoContext, WorktreeRecord } from './repo';
import { worktreeIdentity } from './repo';
import type { DevelopmentProcessRecord } from './worktree-development-process';
import { readDevelopmentProcess } from './worktree-development-process';
import { inspectWorktreeProcesses } from './worktree-processes';

/**
 * True when merging HEAD into `origin/main` would leave main's tree unchanged. This covers squash merges without
 * treating a later revert as preservation of the content.
 */
async function isHeadContentInMain(path: string): Promise<boolean> {
    try {
        const [mergedTree, mainTree] = await Promise.all([
            runCapture('git', ['merge-tree', '--write-tree', 'origin/main', 'HEAD'], path),
            runCapture('git', ['rev-parse', 'origin/main^{tree}'], path),
        ]);
        return mergedTree.trim().split('\n', 1)[0] === mainTree.trim();
    } catch {
        return false;
    }
}

/**
 * A worktree is removable when its exact HEAD is on origin, or when its content is already in `origin/main`. A stale
 * remote-tracking ref is acceptable because removal preserves the local branch and its commits.
 */
export async function isWorktreeHeadPreserved(worktree: WorktreeRecord): Promise<boolean> {
    if (!worktree.branch) return false;
    try {
        const remoteReferences = await runCapture(
            'git',
            ['for-each-ref', '--format=%(refname)', '--contains', 'HEAD', 'refs/remotes/origin/'],
            worktree.path,
        );
        if (remoteReferences.trim()) return true;
    } catch {
        // Fall through to the content-preservation check and fail closed if that also fails.
    }
    return isHeadContentInMain(worktree.path);
}

/**
 * Stricter than `isWorktreeHeadPreserved`: a branch pushed to origin but never merged still holds an unfinished
 * delivery, so reusing its checkout requires the HEAD content to be in `origin/main` itself.
 */
export async function isWorktreeHeadMerged(path: string): Promise<boolean> {
    try {
        await runCapture('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], path);
        return true;
    } catch {
        return isHeadContentInMain(path);
    }
}

/**
 * Refuses a worktree that someone may still be using: uncommitted or untracked files, a live dev launcher, any other
 * process running out of it, or the repository desktop lease. `remove` and `reuse` share these checks; `action` names
 * the refused command in each message.
 */
export async function assertWorktreeIdle(
    context: RepoContext,
    worktree: WorktreeRecord,
    action: 'remove' | 'reuse',
): Promise<{ identity: string | undefined; processRecord: DevelopmentProcessRecord | undefined }> {
    if (
        (
            await runCapture(
                'git',
                ['status', '--porcelain', '--untracked-files=all'],
                worktree.path,
            )
        ).trim()
    ) {
        throw new CommandError(`Refusing to ${action} dirty worktree: ${worktree.path}`);
    }
    const identity = await worktreeIdentity(worktree.path, false);
    const processRecord = await readDevelopmentProcess(context, identity);
    if (
        processRecord &&
        (await isProcessIdentityAlive(processRecord.pid, processRecord.identity))
    ) {
        throw new CommandError(
            `Refusing to ${action} worktree with active dev PID ${processRecord.pid}`,
        );
    }
    const live = await inspectWorktreeProcesses({
        selfPid: process.pid,
        worktreePath: worktree.path,
    });
    const active = [...live.owned, ...live.unresolved];
    if (active.length > 0)
        throw new CommandError(
            `Refusing to ${action} worktree with active processes: PIDs ${active.map(({ pid }) => pid).join(', ')}`,
        );
    const desktop = await inspectDesktopLease(context.root);
    if (
        desktop.state === 'active' &&
        resolve(desktop.lease.worktreePath) === resolve(worktree.path)
    ) {
        throw new CommandError(
            `Refusing to ${action} worktree holding desktop lease ${desktop.lease.label}`,
        );
    }
    return { identity, processRecord };
}
