import { afterEach, describe, expect, it } from 'vitest';

import { useGitDiffViewStore } from '../diff-view-store';

afterEach(() => useGitDiffViewStore.setState(useGitDiffViewStore.getInitialState(), true));

describe('Git diff view preferences', () => {
    it('keeps independent options when a user changes the shared view', () => {
        useGitDiffViewStore.setState({ collapseUnchanged: true, showWhitespaceDifferences: true });
        useGitDiffViewStore.setState({ inlineView: true });
        expect(useGitDiffViewStore.getState()).toEqual({
            inlineView: true,
            collapseUnchanged: true,
            showWhitespaceDifferences: true,
        });
        useGitDiffViewStore.setState({ collapseUnchanged: false });
        expect(useGitDiffViewStore.getState().collapseUnchanged).toBe(false);
        expect(useGitDiffViewStore.getState().showWhitespaceDifferences).toBe(true);
    });
});
