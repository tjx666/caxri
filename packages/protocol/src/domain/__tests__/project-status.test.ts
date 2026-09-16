import { describe, expect, it } from 'vitest';

import type { AcceptanceStatus } from '../project-status.js';
import { acceptanceProjectStatusState } from '../project-status.js';

describe('acceptance report state reduction', () => {
    it('lets the round verdict override the lifecycle, because it is the newer fact', () => {
        // A report repairing after a failed round is failing right now, whatever happens next.
        expect(acceptanceProjectStatusState({ status: 'repairing', verdict: 'failed' })).toBe(
            'failure',
        );
        expect(acceptanceProjectStatusState({ status: 'verifying', verdict: 'failed' })).toBe(
            'failure',
        );
    });

    it('treats an inconclusive round as pending rather than settled', () => {
        expect(acceptanceProjectStatusState({ status: 'delivered', verdict: 'uncertain' })).toBe(
            'pending',
        );
    });

    it('does not call a passing round good news while it still awaits a person', () => {
        expect(acceptanceProjectStatusState({ status: 'delivered', verdict: 'passed' })).toBe(
            'pending',
        );
        expect(acceptanceProjectStatusState({ status: 'accepted', verdict: 'passed' })).toBe(
            'success',
        );
        // A person can reject work whose checks passed; their decision is the answer.
        expect(acceptanceProjectStatusState({ status: 'rejected', verdict: 'passed' })).toBe(
            'failure',
        );
    });

    it('reads a lifecycle with no round yet', () => {
        const expected: Record<AcceptanceStatus, string> = {
            pending: 'neutral',
            planned: 'neutral',
            verifying: 'pending',
            repairing: 'pending',
            delivered: 'pending',
            accepted: 'success',
            closed: 'cancelled',
            rejected: 'failure',
            errored: 'failure',
        };
        for (const [status, state] of Object.entries(expected))
            expect(acceptanceProjectStatusState({ status: status as AcceptanceStatus })).toBe(
                state,
            );
    });

    it('reads a verdict with no lifecycle, and an empty report as unknown', () => {
        expect(acceptanceProjectStatusState({ verdict: 'passed' })).toBe('success');
        expect(acceptanceProjectStatusState({})).toBe('unknown');
    });
});
