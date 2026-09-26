import { describe, expect, it } from 'vitest';

import { terminalResyncPlan } from '../resync-policy';

describe('Terminal resync policy', () => {
    it('refreshes a reshaped grid without an offline warning or retry delay', () => {
        expect(terminalResyncPlan('resize')).toEqual({
            showStale: false,
            useBackoff: false,
        });
    });

    it.each(['capacity', 'generation-changed', 'source-gap', 'local'] as const)(
        'treats %s as a disrupted stream',
        (reason) => {
            expect(terminalResyncPlan(reason)).toEqual({
                showStale: true,
                useBackoff: true,
            });
        },
    );
});
