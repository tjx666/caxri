import type { SessionPullRequest, SessionPullRequests } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    NO_SESSION_PULL_REQUEST,
    selectSessionPullRequest,
    sessionPullRequestPresentation,
    sessionPullRequestToneClassName,
} from '../session-pull-request';

function pullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
    return {
        number: 42,
        title: 'feat: session PR status',
        url: 'https://github.com/example/caxri/pull/42',
        state: 'open',
        source: 'agent',
        ...overrides,
    };
}

describe('Session pull request presentation', () => {
    it('describes cancelled checks with a neutral tone', () => {
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'cancelled' }))).toMatchObject({
            ariaLabel: 'Pull request #42 open, checks cancelled.',
            checksLabel: 'Checks cancelled',
            checksTone: 'neutral',
        });
    });
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

    /**
     * "Merged" is where GitHub stops and where the maintainer's question starts, so a merge production is already
     * serving trades the merge glyph for the rocket. A build still running or failed keeps the shape and moves only the
     * color; a canceled one has nothing to report and stays merged.
     */
    it('promotes a merged PR to the deployment glyph once production serves it', () => {
        expect(
            sessionPullRequestPresentation(
                pullRequest({ state: 'merged', deployment: { state: 'success' } }),
            ),
        ).toEqual({
            ariaLabel: 'Pull request #42 merged and deployed to production.',
            icon: 'deployed',
            label: 'Deployed',
            tone: 'merged',
            checksLabel: 'Deployed to production',
            checksTone: 'success',
        });
        expect(
            sessionPullRequestPresentation(
                pullRequest({ state: 'merged', deployment: { state: 'pending' } }),
            ),
        ).toMatchObject({ icon: 'deployed', label: 'Deploying', tone: 'warning' });
        expect(
            sessionPullRequestPresentation(
                pullRequest({ state: 'merged', deployment: { state: 'failure' } }),
            ),
        ).toMatchObject({ icon: 'deployed', label: 'Deploy failed', tone: 'danger' });
        expect(
            sessionPullRequestPresentation(
                pullRequest({ state: 'merged', deployment: { state: 'neutral' } }),
            ),
        ).toMatchObject({ icon: 'merged', tone: 'merged' });
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

    /**
     * A repository whose CI reports through commit statuses rather than check runs stays `queued` for the whole run, so
     * a badge that only knows `pending` showed such a PR no CI state at all until it concluded.
     */
    it('keeps a badge on a run that has not started yet', () => {
        expect(sessionPullRequestPresentation(pullRequest({ checks: 'queued' }))).toMatchObject({
            ariaLabel: 'Pull request #42 open, checks queued.',
            icon: 'open',
            tone: 'success',
            checksLabel: 'Checks queued',
            checksTone: 'warning',
        });
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

describe('Session pull request row selection', () => {
    function snapshot(overrides: Partial<SessionPullRequests> = {}): SessionPullRequests {
        return {
            pullRequests: { 'session-a': pullRequest() },
            unavailable: {
                'session-b': { reason: 'not-logged-in' },
            },
            refreshedAt: 1_700_000_000_000,
            ...overrides,
        };
    }

    it('gives a Session only its own pull request', () => {
        expect(selectSessionPullRequest(snapshot(), 'session-a')).toEqual({
            pullRequest: pullRequest(),
        });
    });

    it('gives a Session only its own failed lookup', () => {
        expect(selectSessionPullRequest(snapshot(), 'session-b')).toEqual({
            unavailable: { reason: 'not-logged-in' },
        });
    });

    it('answers a Session with neither, and an absent snapshot, with the same shared empty slice', () => {
        expect(selectSessionPullRequest(snapshot(), 'session-c')).toBe(NO_SESSION_PULL_REQUEST);
        expect(selectSessionPullRequest(undefined, 'session-a')).toBe(NO_SESSION_PULL_REQUEST);
    });

    /**
     * The reason this selector exists. `refreshedAt` moves on every poll, so the snapshot itself is never deeply equal
     * to the previous one and structural sharing cannot reuse its reference, but a row's slice has to stay equal, or
     * the sidebar repaints once a minute for data nobody changed.
     */
    it('leaves a row equal across a refresh that only moved the timestamp', () => {
        const before = selectSessionPullRequest(snapshot(), 'session-a');
        const after = selectSessionPullRequest(
            snapshot({ refreshedAt: 1_700_000_060_000 }),
            'session-a',
        );

        expect(after).toEqual(before);
    });

    it('changes a row whose own pull request moved', () => {
        const before = selectSessionPullRequest(snapshot(), 'session-a');
        const after = selectSessionPullRequest(
            snapshot({ pullRequests: { 'session-a': pullRequest({ state: 'merged' }) } }),
            'session-a',
        );

        expect(after).not.toEqual(before);
    });

    it('leaves a row equal when a different Session got a new pull request', () => {
        const before = selectSessionPullRequest(snapshot(), 'session-a');
        const after = selectSessionPullRequest(
            snapshot({
                pullRequests: {
                    'session-a': pullRequest(),
                    'session-d': pullRequest({ number: 7 }),
                },
            }),
            'session-a',
        );

        expect(after).toEqual(before);
    });
});
