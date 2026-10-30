import { createStore } from '../../../lib/store';

interface GitDiffViewState {
    inlineView: boolean;
    /**
     * Preserve each surface's default until the user explicitly chooses a shared preference.
     */
    collapseUnchanged: boolean | null;
    showWhitespaceDifferences: boolean;
}

/**
 * Window-lifetime preferences shared by mounted and virtualized Git diff surfaces.
 */
export const useGitDiffViewStore = createStore<GitDiffViewState>('git-diff-view', () => ({
    inlineView: false,
    collapseUnchanged: null,
    showWhitespaceDifferences: false,
}));
