import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io';

interface RateLimits {
    limitId: string;
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number };
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number };
}

/**
 * What `account/rateLimits/read` answers: the windows the last used-up turn reported, until one did.
 */
const reads: { readable?: RateLimits } = {};

/**
 * A `usage exhausted` turn, as Codex fails one on a used-up plan: the general limit's 5-hour window reads 100% in
 * `account/rateLimits/updated`, then an `error` notification and the failed turn carry `usageLimitExceeded`. With
 * `reset moved` in the message, a later `account/rateLimits/read` still finds the window used up, resetting five hours
 * out instead of two, as when Codex reported the reset early.
 */
export function failOnUsageLimit(io: FakeCodexIo, turn: FakeTurn, text: string): void {
    const now = Math.floor(Date.now() / 1000);
    const rateLimits: RateLimits = {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now + 7_200 },
        secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: now + 172_800 },
    };
    reads.readable = text.includes('reset moved')
        ? { ...rateLimits, primary: { ...rateLimits.primary, resetsAt: now + 18_000 } }
        : rateLimits;
    io.send({ method: 'account/rateLimits/updated', params: { rateLimits } });
    const error = {
        message: "You've hit your usage limit. Try again later.",
        codexErrorInfo: 'usageLimitExceeded',
    };
    turn.status = 'failed';
    turn.error = error;
    io.notifyTurn(turn, 'error', { turnId: turn.id, willRetry: false, error });
}

function readResetCreditsMode(): string | undefined {
    const home = process.env.CODEX_HOME;
    if (!home) return undefined;
    try {
        return readFileSync(join(home, 'reset-credits-mode'), 'utf8').trim();
    } catch {
        return undefined;
    }
}

/**
 * `account/rateLimits/read`, in the multi-bucket shape codex-cli 0.165 answers with.
 */
export function rateLimitsReadResult() {
    const now = Math.floor(Date.now() / 1000);
    const rateLimits = reads.readable ?? {
        limitId: 'codex',
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now + 18_000 },
        secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: now + 604_800 },
    };
    // Banked resets (`RateLimitResetCreditsSummary` in the app-server schema): two cards, the soonest expiring in three
    // days. A `reset-credits-mode` file in `CODEX_HOME` holding `expiring` makes it expire in 12 hours and `none` holds
    // no card (the fake CLI's environment is not the launcher's, so a file is what a manual run can steer).
    const mode = readResetCreditsMode();
    const credit = (id: string, days: number) => ({
        id,
        status: 'available',
        resetType: 'codexRateLimits',
        grantedAt: now - 86_400,
        expiresAt: now + Math.round(days * 86_400),
    });
    return {
        rateLimits,
        rateLimitsByLimitId: { codex: rateLimits },
        rateLimitResetCredits:
            mode === 'none'
                ? { availableCount: 0, credits: [] }
                : {
                      availableCount: 2,
                      credits: [credit('a', mode === 'expiring' ? 0.5 : 3), credit('b', 20)],
                  },
        ordinaryUsageAllowed: true,
    };
}
