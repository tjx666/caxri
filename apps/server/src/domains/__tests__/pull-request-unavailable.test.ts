import { describe, expect, it } from 'vitest';

import { ExternalStatusCliError, pullRequestUnavailable } from '../external-status';

describe('pull request lookup failures', () => {
    // CLI stderr can hold private repository data, so only the closed reason crosses to the Renderer, which owns the
    // recovery copy (and its translation).
    it.each(['not-found', 'not-logged-in', 'not-linked', 'permission-denied', 'timeout'] as const)(
        'maps %s to its reason alone',
        (kind) => {
            expect(
                pullRequestUnavailable(new ExternalStatusCliError('gh', kind, 'private output')),
            ).toEqual({ reason: kind });
        },
    );

    it('collapses unclassified failures into other', () => {
        expect(
            pullRequestUnavailable(new ExternalStatusCliError('gh', 'other', 'private output')),
        ).toEqual({ reason: 'other' });
        expect(pullRequestUnavailable(new Error('boom'))).toEqual({ reason: 'other' });
    });

    it('carries the deadline of a paused GitHub budget', () => {
        const error = new ExternalStatusCliError('gh', 'rate-limited', 'private output');
        const retryAt = Date.now() + 30 * 60_000;
        error.retryAt = retryAt;
        expect(pullRequestUnavailable(error)).toEqual({ reason: 'rate-limited', retryAt });
    });

    it('omits the deadline when none is recorded', () => {
        expect(
            pullRequestUnavailable(new ExternalStatusCliError('gh', 'rate-limited', 'x')),
        ).toEqual({ reason: 'rate-limited' });
    });

    it('never attaches a deadline to a reason that does not pause', () => {
        const error = new ExternalStatusCliError('gh', 'network', 'x');
        error.retryAt = Date.now() + 1000;
        expect(pullRequestUnavailable(error)).toEqual({ reason: 'network' });
    });
});
