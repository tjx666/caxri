import type { FakeCodexIo, FakeTurn } from './fake-codex-io';

/**
 * A `usage exhausted` turn, as Codex fails one on a used-up plan: the general limit's 5-hour window reads 100% in
 * `account/rateLimits/updated`, then an `error` notification and the failed turn carry `usageLimitExceeded`.
 */
export function failOnUsageLimit(io: FakeCodexIo, turn: FakeTurn): void {
    const now = Math.floor(Date.now() / 1000);
    io.send({
        method: 'account/rateLimits/updated',
        params: {
            rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 7_200 },
                secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: now + 172_800 },
            },
        },
    });
    const error = {
        message: "You've hit your usage limit. Try again later.",
        codexErrorInfo: 'usageLimitExceeded',
    };
    turn.status = 'failed';
    turn.error = error;
    io.notifyTurn(turn, 'error', { turnId: turn.id, willRetry: false, error });
}
