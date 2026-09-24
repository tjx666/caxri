import { describe, expect, it } from 'vitest';

import { describeSessionHomeEmptyState } from '../session-home-empty-state';

describe('Session home empty state', () => {
    it('keeps the loaded Project empty state actionable', () => {
        expect(
            describeSessionHomeEmptyState({
                activeProjectId: 'project-one',
                error: null,
                hasLoaded: true,
                status: 'connected',
            }),
        ).toMatchObject({
            action: 'new',
            testID: 'session-list-empty',
            title: 'No Sessions in this Project',
        });
    });

    it.each([
        ['version-mismatch', 'session-list-version-mismatch', 'Update required'],
        ['unverified', 'session-list-unverified', 'Sessions unavailable'],
    ] as const)('keeps %s more important than a stale fetch error', (status, testID, title) => {
        expect(
            describeSessionHomeEmptyState({
                activeProjectId: null,
                error: 'Unable to load Sessions.',
                hasLoaded: false,
                status,
            }),
        ).toMatchObject({ action: null, testID, title });
    });

    it('offers retry for a fetch failure and a spinner only while loading', () => {
        const input = { activeProjectId: null, hasLoaded: false, status: 'connected' as const };
        expect(describeSessionHomeEmptyState({ ...input, error: 'failed' })).toMatchObject({
            action: 'retry',
            testID: 'session-list-error',
            titleRole: 'alert',
        });
        expect(describeSessionHomeEmptyState({ ...input, error: null })).toMatchObject({
            action: null,
            showSpinner: true,
            testID: 'session-list-loading',
        });
    });
});
