import { pullRequestUnavailableSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { pullRequestTooltip, pullRequestUnavailableLabel } from '../pull-request-status-label';

const reasons = pullRequestUnavailableSchema.shape.reason.options;

describe('pull request status bar label', () => {
    it('names the condition instead of falling back to unknown', () => {
        expect(pullRequestUnavailableLabel('rate-limited')).toBe('PR rate limited');
        expect(pullRequestUnavailableLabel('not-logged-in')).toBe('PR needs login');
        expect(pullRequestUnavailableLabel('not-found')).toBe('PR needs gh');
        expect(pullRequestUnavailableLabel('not-linked')).toBe('PR needs setup');
        expect(pullRequestUnavailableLabel('timeout')).toBe('PR timed out');
    });

    /**
     * Both mean GitHub is out of reach, but the hover cards send the user to different places, so the chips must too.
     */
    it('separates a lost connection from a refused certificate', () => {
        expect(pullRequestUnavailableLabel('network')).toBe('PR offline');
        expect(pullRequestUnavailableLabel('tls')).toBe('PR TLS error');
    });

    it('keeps unknown for the reason that genuinely is unknown', () => {
        expect(pullRequestUnavailableLabel('other')).toBe('PR unknown');
    });

    /**
     * The label map is keyed by the protocol enum, so a reason added upstream must not silently render `undefined`.
     */
    it('labels every reason the protocol can send', () => {
        for (const reason of reasons) {
            const label = pullRequestUnavailableLabel(reason);
            expect(label, reason).toMatch(/^PR \S/);
        }
        expect(new Set(reasons.map((reason) => pullRequestUnavailableLabel(reason))).size).toBe(
            reasons.length,
        );
    });
});

describe('pull request status bar tooltip', () => {
    const pullRequest = {
        number: 12,
        title: 'Add worktree hint',
        url: 'https://github.com/example/app/pull/12',
    };

    /**
     * The Agent delivered the pull request from a worktree the Workbench never checked out, so `main #12` would
     * otherwise read as main's own pull request.
     */
    it('names the pull request branch and its source when it is not the checked-out branch', () => {
        expect(
            pullRequestTooltip(
                { ...pullRequest, headBranch: 'feat/hint', source: 'conversation' },
                'main',
            ),
        ).toMatchObject({
            eyebrow: 'Pull request #12',
            rows: [{ label: 'Branch', value: 'feat/hint' }],
            notes: ['From this conversation', 'Not the checked-out branch (main)'],
        });
    });

    it('keeps a branch lookup on the checked-out branch free of provenance notes', () => {
        expect(
            pullRequestTooltip(
                { ...pullRequest, headBranch: 'feat/hint', source: 'branch' },
                'feat/hint',
            ).notes,
        ).toEqual([]);
    });
});
