import type { GitSummary } from '@caxri/protocol';
import { create } from 'zustand';

import type { GitDecoration, GitDecorationIndex } from '../lib/git-decorations';
import { buildGitDecorationIndex, EMPTY_GIT_DECORATION_INDEX } from '../lib/git-decorations';

/**
 * The selected Session's working-tree decorations, keyed by absolute path.
 *
 * A store rather than a context or a prop because both consumers — the file tree and the tab strip — render one
 * component per path and only a handful of those paths are decorated. A context would re-render every row whenever Git
 * reported anything at all; here each row subscribes to its own path and re-renders only when its own decoration
 * changes, the same reason `resource-explorer-scope-store` holds expansion and selection.
 */
interface GitDecorationState {
    index: GitDecorationIndex;
}

const useGitDecorationStore = create<GitDecorationState>(() => ({
    index: EMPTY_GIT_DECORATION_INDEX,
}));

export function useGitDecoration(path: string | undefined): GitDecoration | undefined {
    return useGitDecorationStore((state) =>
        path === undefined ? undefined : state.index.get(path),
    );
}

/**
 * Replaces the index from a fresh `git.summary`. Called only by `useGitDecorationSync`, which owns the single
 * subscription behind it.
 */
export function setGitDecorationSummary(summary: GitSummary | undefined): void {
    useGitDecorationStore.setState((state) => {
        const index = buildGitDecorationIndex(summary, state.index);
        return index === state.index ? state : { index };
    });
}
