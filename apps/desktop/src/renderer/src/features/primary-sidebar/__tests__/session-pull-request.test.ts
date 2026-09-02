import type { SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionPullRequestPresentation } from '../session-pull-request';

function pullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
    return {
        number: 42,
        title: 'feat: session PR status',
        url: 'https://github.com/yutengjing/caxri/pull/42',
        state: 'open',
        source: 'agent',
        ...overrides,
    };
}

describe('Session pull request presentation', () => {
    it('encodes merged and closed in the glyph with success and danger tones', () => {
        expect(sessionPullRequestPresentation(pullRequest({ state: 'merged' }))).toEqual({
            ariaLabel: 'Pull request #42 merged.',
            icon: 'merged',
            label: 'Merged',
            tone: 'success',
        });
        expect(sessionPullRequestPresentation(pullRequest({ state: 'closed' }))).toEqual({
            ariaLabel: 'Pull request #42 closed.',
            icon: 'closed',
            label: 'Closed',
            tone: 'danger',
        });
    });

    it('lets CI tone override only while the PR is open', () => {
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'failure' }))).toMatchObject({
            ariaLabel: 'Pull request #42 open, checks failing.',
            icon: 'open',
            tone: 'danger',
        });
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'pending' }))).toMatchObject({
            icon: 'open',
            tone: 'warning',
        });
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'success' }))).toMatchObject({
            icon: 'open',
            tone: 'success',
        });
        expect(sessionPullRequestPresentation(pullRequest())).toMatchObject({
            icon: 'open',
            tone: 'neutral',
        });
        expect(
            sessionPullRequestPresentation(pullRequest({ state: 'merged', checks: 'failure' })),
        ).toMatchObject({ icon: 'merged', tone: 'success' });
    });

    it('keeps drafts neutral regardless of checks', () => {
        expect(
            sessionPullRequestPresentation(pullRequest({ state: 'draft', checks: 'failure' })),
        ).toEqual({
            ariaLabel: 'Pull request #42 draft.',
            icon: 'draft',
            label: 'Draft',
            tone: 'neutral',
        });
    });
});
