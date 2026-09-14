import { describe, expect, it } from 'vitest';

import type { CliFailureKind } from '../external-status';
import { projectStatusCliError } from '../project-status-external';

const NON_LOG_FAILURE_KINDS: Array<Exclude<CliFailureKind, 'other'>> = [
    'not-found',
    'not-logged-in',
    'not-linked',
    'rate-limited',
    'timeout',
    'network',
    'tls',
];

describe('projectStatusCliError', () => {
    it.each(NON_LOG_FAILURE_KINDS)('keeps %s errors non-actionable', (kind) => {
        expect(projectStatusCliError('linear', kind)).not.toHaveProperty('detailsView');
    });

    it('routes generic CLI failure details to Logs', () => {
        expect(projectStatusCliError('linear', 'other')).toHaveProperty('detailsView', 'logs');
    });

    it('gives missing Vercel prerequisites complete guidance', () => {
        expect(projectStatusCliError('vc', 'not-found')).toMatchObject({
            kind: 'prerequisite',
            message: 'Vercel CLI not installed',
            hint: 'Deployments for this repository need the Vercel CLI. Install it with npm i -g vercel, then recheck.',
        });
        expect(projectStatusCliError('vc', 'not-logged-in')).toMatchObject({
            kind: 'prerequisite',
            message: 'Vercel CLI not signed in',
            hint: 'Run vc login in a Terminal, then recheck.',
        });
        expect(projectStatusCliError('vc', 'not-linked')).toMatchObject({
            kind: 'prerequisite',
            message: 'Repository not linked to Vercel',
            hint: 'Run vc link in this repository, then recheck.',
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
        const error = projectStatusCliError('linear', 'other', { subject: 'LOBE-14029' });
        expect(error.message).toBe('Linear CLI: LOBE-14029 failed');
        expect(error.hint).toBe(
            'Something went wrong while loading linked issues. Open Logs for details.',
        );
        expect(error.detailsView).toBe('logs');
    });
});
