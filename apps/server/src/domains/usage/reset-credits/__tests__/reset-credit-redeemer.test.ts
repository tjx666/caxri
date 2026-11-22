import type { UsageLimit } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { ResetCreditRedeemer } from '../reset-credit-redeemer';

const NOW = 1_800_000_000_000;
type Reading = Omit<UsageLimit, 'provider'>;
type Consume = ConstructorParameters<typeof ResetCreditRedeemer>[0]['consume'];

function reading(usedPercent: number, credits = 2): Reading {
    return {
        observedAt: NOW,
        windows: [
            { windowMinutes: 300, usedPercent, resetsAt: NOW + 3_600_000, scope: 'session' },
            { windowMinutes: 10_080, usedPercent: 20, resetsAt: NOW + 86_400_000 },
        ],
        ...(credits > 0 && { resetCredits: { availableCount: credits } }),
    };
}

/**
 * A redeemer over a stubbed Codex transport: `consume` stands for `account/rateLimitResetCredit/consume`, which no test
 * may ever send to a real account.
 */
function setup(options: {
    reads: Array<Reading | undefined>;
    consume?: Consume;
    isCodex?: boolean;
}) {
    const reads = [...options.reads];
    const readLimits = vi.fn(() => Promise.resolve(reads.length > 1 ? reads.shift() : reads[0]));
    const consume = vi.fn<Consume>(options.consume ?? (() => Promise.resolve('reset')));
    const observer = { observeLimits: vi.fn(), observeResetCredits: vi.fn() };
    const write = vi.fn();
    const redeemer = new ResetCreditRedeemer({
        logger: { write } as unknown as StructuredLogger,
        now: () => NOW,
        readLimits,
        consume,
        canConsume: () => options.isCodex ?? true,
        observer,
    });
    return { redeemer, readLimits, consume, observer, write };
}

describe('ResetCreditRedeemer', () => {
    it('rechecks a fresh reading, spends once with the attempt as idempotency key, and refreshes', async () => {
        const { redeemer, consume, readLimits, observer, write } = setup({
            reads: [reading(95), reading(0, 1)],
        });

        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('reset');

        expect(consume).toHaveBeenCalledExactlyOnceWith('chat', 'attempt-0001');
        expect(readLimits).toHaveBeenCalledTimes(2);
        expect(observer.observeResetCredits).toHaveBeenLastCalledWith('codex', {
            availableCount: 1,
        });
        // The log carries a closed outcome and no ids.
        expect(write).toHaveBeenCalledWith('info', 'usage.reset_credit_redeem', {
            fields: { provider: 'codex', outcome: 'reset', isRetry: false, durationMs: 0 },
        });
        expect(JSON.stringify(write.mock.calls)).not.toContain('attempt-0001');
    });

    it('sends nothing when the windows no longer qualify, no credit is held, or no Chat answers', async () => {
        const roomy = setup({ reads: [reading(50)] });
        await expect(roomy.redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('notEligible');
        const noCredit = setup({ reads: [reading(99, 0)] });
        await expect(noCredit.redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('notEligible');
        const noChat = setup({ reads: [undefined] });
        await expect(noChat.redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unavailable');
        const noSender = setup({ reads: [reading(95)], consume: () => {} });
        await expect(noSender.redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unavailable');

        expect(roomy.consume).not.toHaveBeenCalled();
        expect(noCredit.consume).not.toHaveBeenCalled();
        expect(noChat.consume).not.toHaveBeenCalled();
    });

    it.each(['nothingToReset', 'noCredit', 'alreadyRedeemed'] as const)(
        'passes Codex answer %s through',
        async (answer) => {
            const { redeemer } = setup({
                reads: [reading(95)],
                consume: () => Promise.resolve(answer),
            });
            await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe(answer);
        },
    );

    it('retries an unconfirmed attempt that still qualifies with the same key', async () => {
        const consume = vi
            .fn<Consume>()
            .mockRejectedValueOnce(new Error('timed out'))
            .mockResolvedValueOnce('reset');
        const { redeemer, write } = setup({
            reads: [reading(95), reading(95), reading(0, 1)],
            consume,
        });

        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unconfirmed');
        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('reset');

        expect(consume).toHaveBeenNthCalledWith(1, 'chat', 'attempt-0001');
        expect(consume).toHaveBeenNthCalledWith(2, 'chat', 'attempt-0001');
        expect(write.mock.lastCall?.[2]).toMatchObject({
            fields: { outcome: 'reset', isRetry: true },
        });
    });

    it('never sends a retry whose windows no longer qualify', async () => {
        // The windows reset since the unconfirmed request, by that request or on their own: spending again could
        // waste a credit, so the retry answers from the fresh reading instead.
        const consume = vi.fn<Consume>().mockRejectedValueOnce(new Error('timed out'));
        const { redeemer } = setup({ reads: [reading(95), reading(0, 1)], consume });

        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unconfirmed');
        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('notEligible');
        expect(consume).toHaveBeenCalledTimes(1);
    });

    it('neither reads nor sends for a Terminal without a Codex Chat', async () => {
        const { redeemer, readLimits, consume, observer } = setup({
            reads: [reading(95)],
            isCodex: false,
        });

        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unavailable');
        expect(readLimits).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
        expect(observer.observeLimits).not.toHaveBeenCalled();
    });

    it('treats a different attempt after an unconfirmed one as a new spend that is checked again', async () => {
        const consume = vi.fn<Consume>().mockRejectedValueOnce(new Error('dropped'));
        const { redeemer } = setup({ reads: [reading(95), reading(10, 1)], consume });

        await expect(redeemer.redeem('chat', 'attempt-0001')).resolves.toBe('unconfirmed');
        await expect(redeemer.redeem('chat', 'attempt-0002')).resolves.toBe('notEligible');
        expect(consume).toHaveBeenCalledTimes(1);
    });

    it('runs one attempt at a time', async () => {
        let finish: (() => void) | undefined;
        const { redeemer, consume } = setup({
            reads: [reading(95)],
            consume: () =>
                new Promise((resolve) => {
                    finish = () => resolve('reset');
                }),
        });

        const first = redeemer.redeem('chat', 'attempt-0001');
        await vi.waitFor(() => expect(finish).toBeDefined());
        await expect(redeemer.redeem('chat', 'attempt-0002')).resolves.toBe('unavailable');
        finish?.();
        await expect(first).resolves.toBe('reset');
        expect(consume).toHaveBeenCalledTimes(1);
    });
});
