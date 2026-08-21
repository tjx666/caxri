import { describe, expect, it } from 'vitest';

import {
    assertCanonicalPlatformNeutralGate,
    PLATFORM_NEUTRAL_CI_COMMANDS,
} from '../platform-neutral-gates';

describe('canonical platform-neutral gates', () => {
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
