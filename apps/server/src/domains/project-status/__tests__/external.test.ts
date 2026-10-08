import { describe, expect, it } from 'vitest';

import type { CliFailureKind } from '../../external-status';
import { projectStatusCliError } from '../external';

const NON_LOG_FAILURE_KINDS: Array<Exclude<CliFailureKind, 'other'>> = [
    'not-found',
    'not-logged-in',
    'not-linked',
    'permission-denied',
    'rate-limited',
    'timeout',
    'network',
    'tls',
];

describe('projectStatusCliError', () => {
    it.each(NON_LOG_FAILURE_KINDS)('keeps %s errors non-actionable', (kind) => {
        expect(projectStatusCliError('linear', kind)).not.toHaveProperty('logs');
    });

    it('routes generic CLI failure details to Logs already filtered to the failing event', () => {
        expect(projectStatusCliError('linear', 'other')).toHaveProperty('logs', {
            filter: 'project_status.cli',
            levels: ['warn', 'error'],
        });
    });

    it('tells a signed-in GitHub user how to regain access instead of pointing at Logs', () => {
        expect(projectStatusCliError('gh', 'permission-denied')).toMatchObject({
            kind: 'prerequisite',
            message: 'GitHub CLI access denied',
            hint: 'Run gh auth refresh, authorize SSO for the organization if it requires it, then recheck.',
        });
    });

    it('gives missing Vercel prerequisites complete guidance', () => {
        expect(projectStatusCliError('vc', 'not-found')).toMatchObject({
            kind: 'prerequisite',
            message: 'Vercel CLI not installed',
            hint: 'Deployments for this repository need the Vercel CLI. Install it with npm i -g vercel, then recheck.',
        });
        // Issue #1345: a VERCEL_TOKEN-only user is genuinely signed in in their own shell, but Caxri's external
        // commands never forward it, so the hint must say why instead of implying they were never signed in.
        expect(projectStatusCliError('vc', 'not-logged-in')).toMatchObject({
            kind: 'prerequisite',
            message: 'Vercel CLI not signed in',
            hint: 'Run vc login in a Terminal, then recheck. A VERCEL_TOKEN environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
        });
        expect(projectStatusCliError('vc', 'not-linked')).toMatchObject({
            kind: 'prerequisite',
            message: 'Repository not linked to Vercel',
            hint: 'Run vc link in this repository, then recheck.',
        });
    });

    // Issue #1345: same gap as GitHub and Vercel above, for a LINEAR_API_KEY-only user.
    it('names the unforwarded LINEAR_API_KEY variable in the Linear not-logged-in hint', () => {
        expect(projectStatusCliError('linear', 'not-logged-in')).toMatchObject({
            kind: 'prerequisite',
            message: 'Linear CLI not signed in',
            hint: 'Run linear auth login in a Terminal, then recheck. A LINEAR_API_KEY environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
        });
    });

    it('marks connectivity errors for a single shared fallback', () => {
        expect(projectStatusCliError('gh', 'network')).toMatchObject({
            kind: 'failure',
            reason: 'network',
        });
        expect(projectStatusCliError('vc', 'rate-limited')).toMatchObject({
            kind: 'failure',
            reason: 'rate-limited',
            message: 'Vercel API limit reached',
        });
    });

    it('states when a paused provider resumes, and falls back without a deadline', () => {
        const retryAt = Date.now() + 30 * 60_000;
        const paused = projectStatusCliError('gh', 'rate-limited', { retryAt });
        expect(paused.retryAt).toBe(retryAt);
        expect(paused.hint).toBe(
            `Caxri paused GitHub checks to protect the shared API budget. Retries after ${new Date(
                retryAt,
            ).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`,
        );
        expect(projectStatusCliError('gh', 'rate-limited').hint).toBe(
            'Caxri paused GitHub checks to protect the shared API budget. Refresh after the limit resets.',
        );
        // A snapshot can outlive its own pause; a promise about a time that has passed is worse than the generic copy.
        expect(projectStatusCliError('gh', 'rate-limited', { retryAt: Date.now() - 1 }).hint).toBe(
            'Caxri paused GitHub checks to protect the shared API budget. Refresh after the limit resets.',
        );
    });

    it('names the failing subject and directs users to Logs without internal jargon', () => {
        const error = projectStatusCliError('linear', 'other', { subject: 'TASK-24682' });
        expect(error.message).toBe('Linear CLI: TASK-24682 failed');
        expect(error.hint).toBe(
            'Something went wrong while loading linked issues. Open Logs for details.',
        );
        expect(error.logs?.filter).toBe('project_status.cli');
    });
});
