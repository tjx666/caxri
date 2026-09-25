import { describe, expect, it } from 'vitest';

import { createMobileAcceptanceReadbackReceipt } from '../mobile-acceptance-readback';

const headSha = 'a'.repeat(40);
const checkpointId = 'verify-round-1';
const history = [
    {
        acceptanceId: 'acceptance-1',
        checkIds: ['MOB-PAIR-01', 'MOB-COMPOSER-01'],
        headSha,
        roundIndex: 1,
        verdict: 'partial' as const,
        verifyRunId: checkpointId,
    },
];
const plan = [
    { id: 'MOB-PAIR-01', surface: 'desktop' as const },
    {
        id: 'MOB-COMPOSER-01',
        mobileDevice: {
            appId: 'com.caxri.mobile' as const,
            deviceId: 'emulator-5554',
            platform: 'android' as const,
        },
        surface: 'mobile' as const,
    },
];
const view = {
    acceptance: { id: 'acceptance-1' },
    checks: [
        {
            id: 'MOB-PAIR-01',
            planItem: { verifierConfig: { surface: 'desktop' as const } },
            resultRound: 1,
            surface: 'desktop' as const,
        },
        {
            id: 'MOB-COMPOSER-01',
            planItem: { verifierConfig: { surface: 'mobile' as const } },
            resultRound: 1,
            surface: 'mobile' as const,
        },
    ],
    rounds: [
        {
            report: { verdict: 'uncertain' as const },
            run: {
                acceptanceId: 'acceptance-1',
                context: { commit: headSha },
                id: checkpointId,
                roundIndex: 1,
            },
        },
    ],
};

describe('mobile Acceptance publication readback', () => {
    it('binds exact head, run, check ids, surfaces, and frozen mobile targets', () => {
        expect(
            createMobileAcceptanceReadbackReceipt({
                checkpointPlan: plan,
                checkpointId,
                headSha,
                history,
                readbackPlan: [{ id: 'MOB-ACC-03', surface: 'desktop' }],
                view,
            }),
        ).toMatchObject({
            checkpointId,
            checkIds: ['MOB-COMPOSER-01', 'MOB-PAIR-01'],
            exactHead: headSha,
            mobileDevices: [
                {
                    appId: 'com.caxri.mobile',
                    caseId: 'MOB-COMPOSER-01',
                    deviceId: 'emulator-5554',
                    platform: 'android',
                },
            ],
            surfaces: ['desktop', 'mobile'],
        });
    });

    it('rejects a remote surface mismatch', () => {
        expect(() =>
            createMobileAcceptanceReadbackReceipt({
                checkpointPlan: plan,
                checkpointId,
                headSha,
                history,
                readbackPlan: [{ id: 'MOB-ACC-03', surface: 'desktop' }],
                view: {
                    ...view,
                    checks: view.checks.map((check) => ({
                        ...check,
                        surface: 'desktop' as const,
                    })),
                },
            }),
        ).toThrow('remote surface');
    });

    it('rejects a repair plan that omits the readback case', () => {
        expect(() =>
            createMobileAcceptanceReadbackReceipt({
                checkpointPlan: plan,
                checkpointId,
                headSha,
                history,
                readbackPlan: [{ id: 'MOB-PAIR-01', surface: 'desktop' }],
                view,
            }),
        ).toThrow('does not contain the publication readback case');
    });
});
