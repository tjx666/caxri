import { afterEach, describe, expect, it, vi } from 'vitest';

interface Request {
    attemptId: string;
    terminalId: string;
}
interface Confirm {
    message: string;
}

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters: Request) => Promise<unknown>>(),
    showConfirm: vi.fn<(request: Confirm) => Promise<boolean>>(),
    pushToast: vi.fn<(kind: string, message: string) => void>(),
}));
vi.mock('../../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../../stores/toasts', () => ({ pushToast: mocks.pushToast }));

import { queryClient } from '../../../../queries/client';
import { spendResetCredit } from '../reset-credit-client';

const CREDITS = { availableCount: 2 };

afterEach(() => {
    queryClient.clear();
    mocks.request.mockReset();
    mocks.showConfirm.mockReset();
    mocks.pushToast.mockReset();
});

describe('spendResetCredit', () => {
    it('sends nothing when the user cancels the confirmation', async () => {
        mocks.showConfirm.mockResolvedValue(false);

        await spendResetCredit('terminal-1', CREDITS);

        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('asks once, then reports the spent credit', async () => {
        mocks.showConfirm.mockResolvedValue(true);
        mocks.request.mockResolvedValue({ outcome: 'reset' });

        await spendResetCredit('terminal-1', CREDITS);

        expect(mocks.showConfirm.mock.calls[0]?.[0].message).toContain('2');
        expect(mocks.request).toHaveBeenCalledOnce();
        expect(mocks.request.mock.calls[0]?.[0]).toBe('usage.redeemResetCredit');
        expect(mocks.request.mock.calls[0]?.[1].terminalId).toBe('terminal-1');
        expect(mocks.pushToast.mock.calls[0]?.[0]).toBe('success');
    });

    it('retries an unconfirmed attempt with the same id so the credit is never spent twice', async () => {
        mocks.showConfirm.mockResolvedValue(true);
        mocks.request
            .mockResolvedValueOnce({ outcome: 'unconfirmed' })
            .mockRejectedValueOnce(new Error('server unreachable'))
            .mockResolvedValueOnce({ outcome: 'alreadyRedeemed' });

        await spendResetCredit('terminal-1', CREDITS);
        await spendResetCredit('terminal-1', CREDITS);
        await spendResetCredit('terminal-1', CREDITS);

        const ids = mocks.request.mock.calls.map(([, parameters]) => parameters.attemptId);
        expect(new Set(ids).size).toBe(1);
        expect(mocks.pushToast.mock.lastCall?.[0]).toBe('success');

        // A settled attempt is over: the next confirmation starts a new one.
        mocks.request.mockResolvedValueOnce({ outcome: 'reset' });
        await spendResetCredit('terminal-1', CREDITS);
        expect(mocks.request.mock.calls.at(-1)?.[1].attemptId).not.toBe(ids[0]);
    });
});
