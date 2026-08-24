import { describe, expect, it, vi } from 'vitest';

import { refreshGitPanel } from '../use-git-panel-controller';

function refreshActions() {
    return {
        invalidateCommitDetails: vi.fn(),
        refreshPullRequest: vi.fn(),
        refreshWorkingTree: vi.fn(),
    };
}

describe('Git panel controller workflows', () => {
    it('refreshes only pull request data in pull request mode', () => {
        const actions = refreshActions();

        refreshGitPanel('pull-request', actions);

        expect(actions.refreshPullRequest).toHaveBeenCalledOnce();
        expect(actions.invalidateCommitDetails).not.toHaveBeenCalled();
        expect(actions.refreshWorkingTree).not.toHaveBeenCalled();
    });

    it('refreshes commit details and the summary in last commit mode', () => {
        const actions = refreshActions();

        refreshGitPanel('commit', actions);

        expect(actions.invalidateCommitDetails).toHaveBeenCalledOnce();
        expect(actions.refreshWorkingTree).toHaveBeenCalledOnce();
        expect(actions.refreshPullRequest).not.toHaveBeenCalled();
    });

    it('refreshes only the summary in working tree mode', () => {
        const actions = refreshActions();

        refreshGitPanel('working', actions);

        expect(actions.refreshWorkingTree).toHaveBeenCalledOnce();
        expect(actions.invalidateCommitDetails).not.toHaveBeenCalled();
        expect(actions.refreshPullRequest).not.toHaveBeenCalled();
    });
});
