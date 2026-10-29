import { pullRequestUnavailableSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    pullRequestAriaLabel,
    pullRequestElsewhereBranch,
    pullRequestRecoveryCommand,
    pullRequestTooltip,
    pullRequestUnavailableHint,
    pullRequestUnavailableLabel,
} from '../pull-request-status-label';

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

describe('pull request checks', () => {
    const pullRequest = {
        number: 12,
        title: 'Add worktree hint',
        url: 'https://github.com/example/app/pull/12',
        source: 'branch' as const,
    };

    it('lists the rollup in the hover card with the sidebar wording', () => {
        expect(pullRequestTooltip({ ...pullRequest, checks: 'failure' }, 'main').rows).toEqual([
            { label: 'Checks', value: 'Checks failing' },
        ]);
        expect(pullRequestTooltip({ ...pullRequest, checks: 'success' }, 'main').rows).toEqual([
            { label: 'Checks', value: 'Checks passing' },
        ]);
    });

    it('draws no row for a missing or wordless rollup', () => {
        expect(pullRequestTooltip(pullRequest, 'main').rows).toBeUndefined();
        expect(
            pullRequestTooltip({ ...pullRequest, checks: 'neutral' }, 'main').rows,
        ).toBeUndefined();
    });

    it('says the verdict in the accessible name, since the dot is color alone', () => {
        expect(pullRequestAriaLabel({ number: 12, checks: 'pending' }, 'main')).toBe(
            'Open pull request #12, Checks running',
        );
        expect(pullRequestAriaLabel({ number: 12 }, 'main')).toBe('Open pull request #12');
    });
});

describe('pull request on another branch', () => {
    const pullRequest = { number: 12, headBranch: 'feat/hint' };

    it('reports the head branch only when it differs from the checked-out branch', () => {
        expect(pullRequestElsewhereBranch(pullRequest, 'main')).toBe('feat/hint');
        expect(pullRequestElsewhereBranch(pullRequest, 'feat/hint')).toBeUndefined();
        expect(pullRequestElsewhereBranch({ headBranch: undefined }, 'main')).toBeUndefined();
    });

    it('names the branch in the accessible name, since the mismatch dot is visual only', () => {
        expect(pullRequestAriaLabel(pullRequest, 'main')).toBe(
            'Open pull request #12 for branch feat/hint, not the checked-out branch',
        );
        expect(pullRequestAriaLabel(pullRequest, 'feat/hint')).toBe('Open pull request #12');
    });
});

describe('pull request unavailable recovery copy', () => {
    it('names the exact command for the reasons a terminal command fixes', () => {
        expect(pullRequestRecoveryCommand('not-found')).toBe('brew install gh');
        expect(pullRequestRecoveryCommand('not-logged-in')).toBe('gh auth login');
        expect(pullRequestRecoveryCommand('permission-denied')).toBe('gh auth refresh');
        expect(pullRequestRecoveryCommand('network')).toBeUndefined();
    });

    it('writes a sentence for every reason, embedding the command when there is one', () => {
        for (const reason of reasons) {
            const hint = pullRequestUnavailableHint({ reason });
            expect(hint, reason).not.toContain('{{');
            const command = pullRequestRecoveryCommand(reason);
            if (command) expect(hint, reason).toContain(command);
        }
        expect(pullRequestUnavailableHint({ reason: 'not-logged-in' })).toContain('GH_TOKEN');
    });

    it('states the retry time only while the deadline is still ahead', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0);
        expect(
            pullRequestUnavailableHint(
                { reason: 'rate-limited', retryAt: now + 60_000 },
                undefined,
                now,
            ),
        ).toMatch(/^GitHub API rate limit reached\. Caxri retries after .+\.$/);
        expect(
            pullRequestUnavailableHint(
                { reason: 'rate-limited', retryAt: now - 1 },
                undefined,
                now,
            ),
        ).toBe('GitHub API rate limit reached. Refresh after the limit resets.');
    });
});
