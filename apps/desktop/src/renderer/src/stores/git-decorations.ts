import type { GitSummary } from '@caxri/protocol';

import type {
    GitChildRepoIndex,
    GitChildRepoKind,
    GitDecoration,
    GitDecorationIndex,
} from '../lib/git-decorations';
import {
    buildGitChildRepoIndex,
    buildGitDecorationIndex,
    EMPTY_GIT_CHILD_REPO_INDEX,
    EMPTY_GIT_DECORATION_INDEX,
} from '../lib/git-decorations';
import { createStore } from '../lib/store';

/**
 * What the selected Session's Git status says about individual paths: how each changed path differs from HEAD, and
 * which directories are repositories of their own.
 *
 * A store rather than a context or a prop because the consumers, the file tree and the tab strip, render one component
 * per path and only a handful of those paths carry anything. A context would re-render every row whenever Git reported
 * anything at all; here each row subscribes to its own path and re-renders only when its own entry changes, the same
 * reason `resource-explorer-scope-store` holds expansion and selection.
 */
interface GitDecorationState {
    childRepositories: GitChildRepoIndex;
    index: GitDecorationIndex;
}

const useGitDecorationStore = createStore<GitDecorationState>('git-decorations', () => ({
    childRepositories: EMPTY_GIT_CHILD_REPO_INDEX,
    index: EMPTY_GIT_DECORATION_INDEX,
}));

export function useGitDecoration(path: string | undefined): GitDecoration | undefined {
    return useGitDecorationStore((state) =>
        path === undefined ? undefined : state.index.get(path),
    );
}

/**
 * What kind of child repository this directory is, or `undefined` for an ordinary directory. Held apart from the change
 * decoration because the two are independent: a submodule's own edits never decorate its root, while the parent
 * repository can report that same root as modified when the recorded commit moves.
 */
export function useGitChildRepo(path: string | undefined): GitChildRepoKind | undefined {
    return useGitDecorationStore((state) =>
        path === undefined ? undefined : state.childRepositories.get(path),
    );
}

/**
 * Replaces both indexes from a fresh `git.summary`. Called only by `useGitDecorationSync`, which owns the single
 * subscription behind them.
 */
export function setGitDecorationSummary(summary: GitSummary | undefined): void {
    useGitDecorationStore.setState((state) => {
        const index = buildGitDecorationIndex(summary, state.index);
        const childRepositories = buildGitChildRepoIndex(summary, state.childRepositories);
        if (index === state.index && childRepositories === state.childRepositories) return state;
        return { childRepositories, index };
    });
}
