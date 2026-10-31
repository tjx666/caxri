import type { QueryClient } from '@tanstack/react-query';

/**
 * Re-reads a Session's extension tree, then the header's pull request. The order matters: a Status row's `Merge` hints
 * a change before its forced status refresh lands, and only the tree's read waits for that refresh, so a pull request
 * read sent alongside it would get the cached open pull request and no later hint would correct it.
 */
export async function refreshTreeThenPullRequest(
    queryClient: Pick<QueryClient, 'invalidateQueries'>,
    treeKey: readonly unknown[],
    pullRequestKey: readonly unknown[],
): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: treeKey });
    await queryClient.invalidateQueries({ exact: true, queryKey: pullRequestKey });
}
