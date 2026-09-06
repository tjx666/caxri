import type { SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    sessionPullRequestPresentation,
    sessionPullRequestToneClassName,
} from '../session-pull-request';

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
    it('encodes merged and closed in the glyph with merged and danger tones', () => {
        expect(sessionPullRequestPresentation(pullRequest({ state: 'merged' }))).toEqual({
            ariaLabel: 'Pull request #42 merged.',
            icon: 'merged',
            label: 'Merged',
            tone: 'merged',
        });
        expect(sessionPullRequestPresentation(pullRequest({ state: 'closed' }))).toEqual({
            ariaLabel: 'Pull request #42 closed.',
            icon: 'closed',
            label: 'Closed',
            tone: 'danger',
        });
    });

    it('keeps open PRs green and reports checks separately from lifecycle state', () => {
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'failure' }))).toMatchObject({
            ariaLabel: 'Pull request #42 open, checks failing.',
            icon: 'open',
            tone: 'success',
            checksLabel: 'Checks failing',
            checksTone: 'danger',
        });
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'pending' }))).toMatchObject({
            icon: 'open',
            tone: 'success',
            checksLabel: 'Checks running',
            checksTone: 'warning',
        });
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'success' }))).toMatchObject({
            icon: 'open',
            tone: 'success',
        });
        expect(sessionPullRequestPresentation(pullRequest())).toMatchObject({
            icon: 'open',
            tone: 'success',
        });
        expect(
            sessionPullRequestPresentation(pullRequest({ state: 'merged', checks: 'failure' })),
        ).toMatchObject({ icon: 'merged', tone: 'merged' });
    });

    it.each(['merged', 'closed', 'draft'] as const)(
        'omits stale check badges for %s PRs',
        (state) => {
            const presentation = sessionPullRequestPresentation(
                pullRequest({ state, checks: 'failure' }),
            );
            expect(presentation.checksLabel).toBeUndefined();
            expect(presentation.checksTone).toBeUndefined();
        },
    );

    /**
     * The bug this tone exists for: merged and "open, checks passed" both rendered `text-success`, so a landed PR was
     * indistinguishable from a green CI run at glyph size.
     */
    it('separates merged from a passing open PR by color, not only shape', () => {
        const merged = sessionPullRequestPresentation(pullRequest({ state: 'merged' }));
        const passing = sessionPullRequestPresentation(pullRequest({ checks: 'success' }));
        expect(sessionPullRequestToneClassName(merged.tone)).toBe('text-merged');
        expect(sessionPullRequestToneClassName(passing.tone)).toBe('text-success');
        expect(sessionPullRequestToneClassName(merged.tone)).not.toBe(
            sessionPullRequestToneClassName(passing.tone),
        );
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
