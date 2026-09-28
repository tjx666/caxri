import { describe, expect, it } from 'vitest';

import { EXPECTED_PLATFORM_NEUTRAL_GATE_IDS } from '../../../../../scripts/__tests__/ci-platform-gates.fixture';
import {
    assertCanonicalPlatformNeutralGate,
    PLATFORM_NEUTRAL_CI_COMMANDS,
    PLATFORM_NEUTRAL_CI_GATES,
} from '../platform-neutral-gates';

describe('canonical platform-neutral gates', () => {
    it('keeps stable unique IDs paired with every exact fallback command', () => {
        expect(PLATFORM_NEUTRAL_CI_GATES.map(({ id }) => id)).toEqual(
            EXPECTED_PLATFORM_NEUTRAL_GATE_IDS,
        );
        expect(new Set(PLATFORM_NEUTRAL_CI_GATES.map(({ id }) => id)).size).toBe(
            PLATFORM_NEUTRAL_CI_GATES.length,
        );
        expect(PLATFORM_NEUTRAL_CI_GATES.map(({ receiptCommand }) => receiptCommand)).toEqual(
            PLATFORM_NEUTRAL_CI_COMMANDS,
        );
    });

    it('accepts one passed receipt per canonical command on the exact head', () => {
        expect(() =>
            assertCanonicalPlatformNeutralGate(
                {
                    validations: PLATFORM_NEUTRAL_CI_COMMANDS.map((command) => ({
                        command,
                        headSha: 'review-head',
                        kind: 'gates',
                        result: 'passed',
                    })),
                },
                'review-head',
            ),
        ).not.toThrow();
    });

    it('prefers complete local receipts and attributes missing commands to a valid CI run', () => {
        const local = {
            validations: PLATFORM_NEUTRAL_CI_COMMANDS.map((command) => ({
                command,
                headSha: 'review-head',
                kind: 'gates',
                result: 'passed',
            })),
        };
        const ciReceipt = {
            commands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            headSha: 'review-head',
            runId: 42,
            runUrl: 'https://github.com/tjx666/caxri/actions/runs/42',
        };
        expect(assertCanonicalPlatformNeutralGate(local, 'review-head', ciReceipt)).toMatchObject({
            source: 'local',
            ciCommands: [],
        });
        local.validations.pop();
        expect(assertCanonicalPlatformNeutralGate(local, 'review-head', ciReceipt)).toMatchObject({
            source: 'ci',
            ciCommands: [PLATFORM_NEUTRAL_CI_COMMANDS.at(-1)],
            ciRunId: 42,
        });
        expect(() =>
            assertCanonicalPlatformNeutralGate(local, 'review-head', {
                ...ciReceipt,
                headSha: 'old-head',
            }),
        ).toThrow('Wait for a successful exact-head full CI run');
    });

    it('rejects missing, failed, wrong-kind, and stale-head receipts', () => {
        const validations = PLATFORM_NEUTRAL_CI_COMMANDS.map((command) => ({
            command,
            headSha: 'review-head',
            kind: 'gates',
            result: 'passed',
        }));
        validations[0] = { ...validations[0], headSha: 'old-head' };
        validations[1] = { ...validations[1], result: 'failed' };
        validations[2] = { ...validations[2], kind: 'ci' };
        validations.pop();

        expect(() => assertCanonicalPlatformNeutralGate({ validations }, 'review-head')).toThrow(
            new RegExp(
                PLATFORM_NEUTRAL_CI_COMMANDS.slice(0, 3)
                    .map((command) => command.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
                    .join('.*'),
                'u',
            ),
        );
    });
});
