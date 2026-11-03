import { agentDelegationFailureSchema, isRetryableDelegationFailure } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { delegationCopy } from '../delegation-copy';
import { delegationNextSteps } from '../delegation-next-step';

const NOW = 1_700_000_000_000;

describe('every delegation failure', () => {
    it.each(agentDelegationFailureSchema.options)('%s has copy and a next step', (failure) => {
        const copy = delegationCopy(
            { status: 'failed', failure, provider: 'codex' },
            NOW,
            translate,
        );
        expect(copy.headline).not.toBe('');
        expect(copy.headline).not.toContain('delegation.');
        expect(delegationNextSteps(failure).length).toBeGreaterThan(0);
    });

    it('offers Retry exactly for the failures the Server accepts a retry for', () => {
        for (const failure of agentDelegationFailureSchema.options)
            expect(delegationNextSteps(failure).includes('retry'), failure).toBe(
                isRetryableDelegationFailure({ status: 'failed', failure }),
            );
    });

    it('adds Sign in for a signed-out Agent and Enable hooks for missing hooks, keeping Retry', () => {
        expect(delegationNextSteps('authentication_failed')).toEqual(['signIn', 'retry']);
        expect(delegationNextSteps('hooks_required')).toEqual(['enableHooks', 'retry']);
    });

    it('never retries a submission whose effects are unknown', () => {
        expect(delegationNextSteps('submission_unconfirmed')).toEqual(['openSession']);
    });
});
