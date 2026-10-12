import './host-api.fixture';

import type { GitRepositorySummary } from 'caxri';
import { describe, expect, it } from 'vitest';

import type { RegisterSourceControlAction } from '../source-control-model';
import { buildSourceControlViewModel } from '../source-control-model';

const repo: GitRepositorySummary = {
    id: 'repo-1',
    kind: 'primary',
    name: 'project',
    rootPath: '/authorized/project',
    branch: 'feature/sync',
    head: '0123456789abcdef0123456789abcdef01234567',
    ahead: 1,
    behind: 2,
    additions: 0,
    deletions: 0,
    generation: 1,
    changedFileCount: 0,
    truncated: false,
    files: [],
};

function providerFor(
    overrides: Partial<GitRepositorySummary>,
    mode: 'commit' | 'working' = 'working',
) {
    let sequence = 0;
    /**
     * Opaque ids like the provider's action registry, so the badge cannot be resolved by command id.
     */
    const registerAction: RegisterSourceControlAction = (action) => ({
        id: `action-${++sequence}`,
        ...action,
    });
    return buildSourceControlViewModel({
        mode,
        registerAction,
        summary: { isRepository: true, repositories: [{ ...repo, ...overrides }] },
    }).providers[0];
}

describe('branch row sync badge', () => {
    it('names the registered Sync action as the action of the unsynced-commit badge', () => {
        const provider = providerFor({});
        const sync = provider.actions.find(({ command }) => command.id === 'caxri.git.sync');

        expect(provider.descriptionBadge).toBe('↑1 ↓2');
        expect(sync?.command.arguments).toEqual(['repo-1', 1, 2]);
        expect(provider.descriptionBadgeActionId).toBe(sync?.id);
    });

    it('leaves status-only and missing badges without an action', () => {
        // Level with the upstream: no badge to click.
        expect(providerFor({ ahead: 0, behind: 0 })).not.toHaveProperty('descriptionBadgeActionId');
        // `detached` describes the checkout; it is not a sync count.
        const detached = providerFor({ branch: '(detached)' });
        expect(detached.descriptionBadge).toBe('detached');
        expect(detached).not.toHaveProperty('descriptionBadgeActionId');
        // Sync is a Working Tree action only.
        expect(providerFor({}, 'commit')).not.toHaveProperty('descriptionBadgeActionId');
    });
});
