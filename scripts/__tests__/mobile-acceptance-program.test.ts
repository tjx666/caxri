import { describe, expect, it } from 'vitest';

import {
    createMobileAcceptanceProgramReceipt,
    mobileAcceptanceProgramCase,
    parseMobileAcceptanceProgramArguments,
} from '../mobile-acceptance-program';

describe('mobile Acceptance program cases', () => {
    it('routes every non-visual matrix to its focused executable contract', () => {
        expect(mobileAcceptanceProgramCase('MOB-SEC-01').scenarios).toEqual(
            expect.arrayContaining([
                'tampered-frame-rejected',
                'replayed-frame-rejected',
                'project-scope-enforced',
            ]) as string[],
        );
        expect(mobileAcceptanceProgramCase('MOB-SEC-02')).toMatchObject({
            scenarios: ['active-connection-revoked', 'old-generation-rejected'],
        });
        expect(mobileAcceptanceProgramCase('MOB-SEC-03').scenarios).toEqual(
            expect.arrayContaining([
                'loopback-control-preserved',
                'origin-policy-preserved',
            ]) as string[],
        );
        expect(mobileAcceptanceProgramCase('MOB-SESSION-04').scenarios).toEqual(
            expect.arrayContaining([
                'non-waiting-reply-rejected',
                'stale-attention-rejected',
            ]) as string[],
        );
        expect(mobileAcceptanceProgramCase('MOB-ACC-01').scenarios).toEqual(
            expect.arrayContaining([
                'wrong-device-rejected',
                'wrong-media-hash-rejected',
                'cross-surface-evidence-rejected',
            ]) as string[],
        );
    });

    it('rejects unowned case ids and incomplete report arguments', () => {
        expect(() => mobileAcceptanceProgramCase('MOB-PAIR-01')).toThrow(
            'Unsupported program Acceptance case',
        );
        expect(() => parseMobileAcceptanceProgramArguments([])).toThrow('--report-dir is required');
        expect(() =>
            parseMobileAcceptanceProgramArguments([
                '--report-dir',
                '/tmp/report',
                '--case-id',
                'MOB-PAIR-01',
            ]),
        ).toThrow('Unsupported program Acceptance case');
    });

    it('produces a content-free exact-head receipt', () => {
        expect(
            createMobileAcceptanceProgramReceipt({
                caseId: 'MOB-SEC-02',
                completedAt: '2026-09-01T00:00:02.000Z',
                durationMs: 1_000,
                sourceCommit: 'a'.repeat(40),
                startedAt: '2026-09-01T00:00:01.000Z',
            }),
        ).toEqual({
            caseId: 'MOB-SEC-02',
            completedAt: '2026-09-01T00:00:02.000Z',
            durationMs: 1_000,
            result: 'passed',
            scenarios: ['active-connection-revoked', 'old-generation-rejected'],
            schemaVersion: 1,
            sourceCommit: 'a'.repeat(40),
            startedAt: '2026-09-01T00:00:01.000Z',
        });
    });
});
