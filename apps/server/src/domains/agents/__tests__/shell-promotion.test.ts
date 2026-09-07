import { describe, expect, it } from 'vitest';

import { decideInputPromotionCandidate } from '../shell-promotion';

describe('decideInputPromotionCandidate', () => {
    it('clears the candidate for a command that cannot be inspected', () => {
        expect(decideInputPromotionCandidate({ provider: undefined }, 'cat a | grep b', 1)).toBe(
            'clear',
        );
    });

    it('ignores a direct same-provider launch while that Agent is already live', () => {
        expect(
            decideInputPromotionCandidate(
                { lastAgentProcessState: 'running', provider: 'claude' },
                'claude',
                1,
            ),
        ).toBe('ignore');
    });

    it('opens an input candidate for a bound Terminal whose Agent exited and for a Shell', () => {
        expect(
            decideInputPromotionCandidate(
                { lastAgentProcessState: 'stopped', provider: 'claude' },
                'codex',
                5,
            ),
        ).toMatchObject({ origin: 'input', provider: 'codex', startedAt: 5, expiresAt: 30_005 });
        expect(decideInputPromotionCandidate({ provider: undefined }, 'ls', 5)).toMatchObject({
            origin: 'input',
            provider: undefined,
            startedAt: 5,
        });
    });
});
