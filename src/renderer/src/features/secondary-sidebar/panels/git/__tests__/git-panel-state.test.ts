import { describe, expect, it } from 'vitest';

import {
    defaultGitPanelNavigation,
    gitPanelNavigationForScope,
    updateGitPanelNavigation,
} from '../git-panel-state';

describe('Git panel navigation state', () => {
    it('defaults a new Session scope to the working tree with expanded sections', () => {
        expect(gitPanelNavigationForScope({}, 'session-a:project-a')).toEqual({
            expandedDirectories: {},
            expandedRepositories: {},
            mode: 'working',
        });
        expect(gitPanelNavigationForScope({}, undefined)).toEqual(defaultGitPanelNavigation());
    });

    it('updates one Session scope without changing another', () => {
        const initial = {
            'session-a:project-a': {
                expandedDirectories: { 'working:repo-a:src': true },
                expandedRepositories: { 'repo-a': true },
                mode: 'working' as const,
            },
            'session-b:project-b': {
                expandedDirectories: {},
                expandedRepositories: { 'repo-b': false },
                mode: 'commit' as const,
            },
        };
        const navigation = gitPanelNavigationForScope(initial, 'session-a:project-a');
        const updated = updateGitPanelNavigation(initial, 'session-a:project-a', navigation, {
            mode: 'pull-request',
        });

        expect(updated['session-a:project-a']).toEqual({
            ...initial['session-a:project-a'],
            mode: 'pull-request',
        });
        expect(updated['session-b:project-b']).toBe(initial['session-b:project-b']);
        expect(initial['session-a:project-a'].mode).toBe('working');
    });
});
