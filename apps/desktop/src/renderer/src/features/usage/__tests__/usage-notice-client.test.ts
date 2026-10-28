import type { AgentUsageReadout } from '@caxri/protocol';
import { isPlanPaceDismissed } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../queries/client';
import { dismissUsageNotice } from '../usage-notice-client';

const readout: AgentUsageReadout = {
    provider: 'claude',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    costUsd: 0,
    models: [],
    unpricedModels: [],
    limit: { provider: 'claude', observedAt: 1, windows: [] },
};

afterEach(() => {
    queryClient.clear();
    mocks.request.mockReset();
});

describe('dismissUsageNotice', () => {
    it('hides the reminder in the cached readout at once and asks the Server to keep the dismissal', async () => {
        const key = caxriQueryKey('terminal.agentUsage', { terminalId: 'terminal-1' });
        queryClient.setQueryData(key, readout);
        mocks.request.mockResolvedValue(null);

        await dismissUsageNotice('terminal-1', 'claude', 'planPace');

        const cached = queryClient.getQueryData<AgentUsageReadout>(key);
        expect(isPlanPaceDismissed(cached?.limit, Date.now())).toBe(true);
        expect(mocks.request).toHaveBeenCalledWith('usage.dismissNotice', {
            provider: 'claude',
            notice: 'planPace',
        });
    });

    it('keeps the dismissal when a poll that started before it resolves afterwards', async () => {
        const key = caxriQueryKey('terminal.agentUsage', { terminalId: 'terminal-1' });
        queryClient.setQueryData(key, readout);
        mocks.request.mockResolvedValue(null);
        const pollResult = Promise.withResolvers<AgentUsageReadout>();
        const poll = queryClient.query({
            queryKey: key,
            staleTime: 0,
            queryFn: () => pollResult.promise,
        });

        await dismissUsageNotice('terminal-1', 'claude', 'planPace');
        pollResult.resolve(readout);
        await Promise.allSettled([poll]);

        const cached = queryClient.getQueryData<AgentUsageReadout>(key);
        expect(isPlanPaceDismissed(cached?.limit, Date.now())).toBe(true);
    });

    it('dismisses the credits notice through its own field', async () => {
        const key = caxriQueryKey('terminal.agentUsage', { terminalId: 'terminal-1' });
        queryClient.setQueryData(key, readout);
        mocks.request.mockResolvedValue(null);

        await dismissUsageNotice('terminal-1', 'codex', 'credits');

        const cached = queryClient.getQueryData<AgentUsageReadout>(key);
        expect(cached?.limit?.creditsNoticeDismissedAt).toBeGreaterThan(0);
        expect(cached?.limit).not.toHaveProperty('paceDismissedAt');
        expect(mocks.request).toHaveBeenCalledWith('usage.dismissNotice', {
            provider: 'codex',
            notice: 'credits',
        });
    });
});
