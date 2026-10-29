import type { UsageLimit, UsageResetCredits } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ResetCreditRefresh } from '../reset-credit-refresh';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const reading = (extra: Partial<UsageLimit>): Omit<UsageLimit, 'provider'> => ({
    observedAt: 1,
    windows: [],
    ...extra,
});
const CREDITS: UsageResetCredits = { availableCount: 2, nextExpiresAt: 1_800_000_000_000 };

describe('ResetCreditRefresh', () => {
    it('asks a running Codex Chat once, then reuses the reading until it goes stale', async () => {
        let now = 0;
        const read = vi.fn(() => Promise.resolve(reading({ resetCredits: CREDITS })));
        const observeResetCredits = vi.fn();
        const observe = { observeResetCredits };
        const refresh = new ResetCreditRefresh(read, observe, () => now);
        refresh.request('codex', 'chat');
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
        expect(observeResetCredits).toHaveBeenCalledWith('codex', CREDITS);
        now = 60_000;
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
        now = 5 * 60_000;
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('clears the reading when the account no longer holds any', async () => {
        const observeResetCredits = vi.fn();
        const observe = { observeResetCredits };
        new ResetCreditRefresh(
            () => Promise.resolve(reading({})),
            observe,
            () => 0,
        ).request('codex', 'chat');
        await settle();
        expect(observeResetCredits).toHaveBeenCalledWith('codex', undefined);
    });

    it('asks again on the next poll when no Chat answered, retries a failure later, and skips other providers', async () => {
        let now = 0;
        const read = vi.fn<NonNullable<ConstructorParameters<typeof ResetCreditRefresh>[0]>>();
        read.mockResolvedValueOnce(undefined);
        read.mockRejectedValueOnce(new Error('closed'));
        read.mockResolvedValue(reading({ resetCredits: CREDITS }));
        const observeResetCredits = vi.fn();
        const observe = { observeResetCredits };
        const refresh = new ResetCreditRefresh(read, observe, () => now);
        refresh.request('codex', 'pty');
        await settle();
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
        now = 60_000;
        refresh.request('codex', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(3);
        refresh.request('claude', 'chat');
        await settle();
        expect(read).toHaveBeenCalledTimes(3);
        expect(observeResetCredits).toHaveBeenCalledTimes(1);
    });
});
