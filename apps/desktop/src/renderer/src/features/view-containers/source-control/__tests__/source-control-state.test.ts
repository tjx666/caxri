import { describe, expect, it } from 'vitest';

import {
    defaultSourceControlViewNavigation,
    sourceControlNavigationForScope,
    updateSourceControlViewNavigation,
} from '../source-control-state';

describe('Source Control scoped navigation', () => {
    it('starts with generic empty disclosure and provider-mode state', () => {
        expect(defaultSourceControlViewNavigation()).toEqual({
            expandedDirectories: {},
            expandedGroups: {},
            expandedProviders: {},
        });
    });

    it('retains provider-owned mode ids and disclosures independently per scope', () => {
        const first = updateSourceControlViewNavigation(
            {},
            'session-a:project-a',
            defaultSourceControlViewNavigation(),
            {
                expandedDirectories: { 'mode-a:provider-a:src': true },
                expandedGroups: { 'provider-a:group-a': false },
                expandedProviders: { 'provider-a': false },
                modeId: 'mode-a',
            },
        );
        const second = updateSourceControlViewNavigation(
            first,
            'session-b:project-b',
            defaultSourceControlViewNavigation(),
            { modeId: 'mode-b' },
        );

        expect(sourceControlNavigationForScope(second, 'session-a:project-a')).toMatchObject({
            modeId: 'mode-a',
            expandedGroups: { 'provider-a:group-a': false },
        });
        expect(sourceControlNavigationForScope(second, 'session-b:project-b').modeId).toBe(
            'mode-b',
        );
        expect(sourceControlNavigationForScope(second, undefined)).toEqual(
            defaultSourceControlViewNavigation(),
        );
    });
});
