import type { UsageLimit } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { PlanLimitRefresh } from '../plan-limit-refresh';

const reading = (observedAt: number) =>
    ({
        observedAt,
        windows: [{ windowMinutes: 300, usedPercent: 38 }],
    }) satisfies Omit<UsageLimit, 'provider'>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PlanLimitRefresh', () => {
    it('asks a running Claude Chat once at a time and reports only a newer reading', async () => {
        let current = reading(1);
        const read = vi.fn(() => Promise.resolve(current));
        const observe = vi.fn();
        const refresh = new PlanLimitRefresh(read, observe);
        refresh.request('claude', 't1');
        refresh.request('claude', 't1');
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenCalledWith([{ provider: 'claude', ...current }]);
        refresh.request('claude', 't1');
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
        expect(observe).toHaveBeenCalledTimes(1);
        current = reading(2);
        refresh.request('claude', 't1');
        await settle();
        expect(observe).toHaveBeenLastCalledWith([{ provider: 'claude', ...current }]);
    });

    it('asks again on the next poll when no Chat answered, and never asks for Codex', async () => {
        const read = vi.fn<NonNullable<ConstructorParameters<typeof PlanLimitRefresh>[0]>>();
        read.mockResolvedValue(undefined);
        const observe = vi.fn();
        const refresh = new PlanLimitRefresh(read, observe);
        refresh.request('claude', 'pty');
        await settle();
        refresh.request('claude', 'chat');
        await settle();
        refresh.request('codex', 'chat');
        await settle();
        expect(read.mock.calls).toEqual([['pty'], ['chat']]);
        expect(observe).not.toHaveBeenCalled();
    });

    it('survives a failed read', async () => {
        const read = vi.fn(() => Promise.reject(new Error('closed')));
        const refresh = new PlanLimitRefresh(read, vi.fn());
        refresh.request('claude', 't1');
        await settle();
        refresh.request('claude', 't1');
        await settle();
        expect(read).toHaveBeenCalledTimes(2);
    });
});
