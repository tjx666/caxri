import { runCapture } from './process';
import type { WorktreeRecord } from './repo';

/**
 * A worktree is removable when its exact HEAD is on origin, or when merging it into `origin/main` would leave main's
 * tree unchanged. The tree check covers squash merges without treating a later revert as preservation of the removed
 * content. A stale remote-tracking ref is acceptable because removal preserves the local branch and its commits.
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
    try {
        const [mergedTree, mainTree] = await Promise.all([
            runCapture('git', ['merge-tree', '--write-tree', 'origin/main', 'HEAD'], worktree.path),
            runCapture('git', ['rev-parse', 'origin/main^{tree}'], worktree.path),
        ]);
        return mergedTree.trim().split('\n', 1)[0] === mainTree.trim();
    } catch {
        return false;
    }
}
