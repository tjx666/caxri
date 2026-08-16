import { describe, expect, it } from 'vitest';

import { decideCrashRecovery } from '../crash-policy';

describe('decideCrashRecovery', () => {
    it('reloads the first crash after a 250ms delay', () => {
        const result = decideCrashRecovery([], 1_000);

        expect(result.decision).toEqual({ action: 'reload', delayMs: 250, crashCount: 1 });
        expect(result.crashTimestampsMs).toEqual([1_000]);
    });

    it('backs off to 1s then 4s for the second and third crash within the window', () => {
        const second = decideCrashRecovery([1_000], 1_100);
        expect(second.decision).toEqual({ action: 'reload', delayMs: 1_000, crashCount: 2 });

        const third = decideCrashRecovery(second.crashTimestampsMs, 1_300);
        expect(third.decision).toEqual({ action: 'reload', delayMs: 4_000, crashCount: 3 });
    });

    it('stops auto-reloading on the fourth crash within a 60s window', () => {
        const history = [1_000, 1_100, 1_300];
        const fourth = decideCrashRecovery(history, 5_000);

        expect(fourth.decision).toEqual({ action: 'stop', crashCount: 4 });
        expect(fourth.crashTimestampsMs).toEqual([1_000, 1_100, 1_300, 5_000]);
    });

    it('drops crashes older than the 60s window before counting', () => {
        const history = [0, 59_000];
        const result = decideCrashRecovery(history, 61_000);

        /**
         * 61_000 - 0 = 61_000ms (outside the window, dropped); 61_000 - 59_000 = 2_000ms (kept).
         */
        expect(result.decision).toEqual({ action: 'reload', delayMs: 1_000, crashCount: 2 });
        expect(result.crashTimestampsMs).toEqual([59_000, 61_000]);
    });

    it('resets the loop once crashes are far enough apart to fall out of the window entirely', () => {
        const history = [1_000, 1_100, 1_300];
        const stopped = decideCrashRecovery(history, 5_000);
        expect(stopped.decision.action).toBe('stop');

        const muchLater = decideCrashRecovery(stopped.crashTimestampsMs, 200_000);
        expect(muchLater.decision).toEqual({ action: 'reload', delayMs: 250, crashCount: 1 });
    });
});
