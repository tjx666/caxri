import type { AgentProvider } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedProcessList } from '../process-list';
import { ShellProcessProbe } from '../shell-process-probe';
import type { ShellPromotionCandidate } from '../shell-promotion';

afterEach(() => {
    vi.useRealTimers();
});

function candidate(): ShellPromotionCandidate {
    return {
        attempts: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
        nextProcessProbeAt: 0,
        origin: 'input',
        processProbes: 0,
        provider: 'claude',
        startedAt: Date.now(),
    };
}

/**
 * A probe whose exit watches stay current until `current` turns false, recording every `agent.process_watch_ended`.
 */
function watchingProbe(detect: (shellPid: number) => Promise<AgentProvider | undefined>) {
    const ended: Array<Record<string, unknown>> = [];
    const state = { current: true };
    const inactive = vi.fn();
    const probe = new ShellProcessProbe({
        detect,
        intervalMs: 1_000,
        isCurrent: () => true,
        isWatchCurrent: () => state.current,
        logger: {
            write: (_level, event, options) => {
                if (event === 'agent.process_watch_ended')
                    ended.push({ ...options?.fields, durationMs: options?.durationMs });
            },
        },
        onConfirmed: () => true,
        onExhausted: vi.fn(),
        onInactive: inactive,
    });
    return { ended, inactive, probe, state };
}

describe('ShellProcessProbe exit watch', () => {
    it('reads the machine process table once a second however many Terminals it watches', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const read = vi.fn(() => Promise.resolve('table'));
        const table = new SharedProcessList({ now: () => Date.now(), read });
        const { probe } = watchingProbe(async () => {
            await table.read();
            return 'claude';
        });
        try {
            for (const terminalId of ['t1', 't2', 't3', 't4', 't5', 't6'])
                probe.observe(terminalId, 42, candidate());
            await vi.advanceTimersByTimeAsync(0);
            read.mockClear();

            await vi.advanceTimersByTimeAsync(5_000);
            expect(read).toHaveBeenCalledTimes(5);
        } finally {
            probe.close();
        }
    });

    it('records one summary per watch with a closed reason', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const running = new Map([
            ['exits', true],
            ['cancelled', true],
            ['closing', true],
        ]);
        let shellOf: string[] = [];
        const { ended, inactive, probe } = watchingProbe((shellPid) =>
            Promise.resolve(running.get(shellOf[shellPid]) ? 'claude' : undefined),
        );
        shellOf = ['exits', 'cancelled', 'closing'];
        probe.observe('exits', 0, candidate());
        probe.observe('cancelled', 1, candidate());
        probe.observe('closing', 2, candidate());
        await vi.advanceTimersByTimeAsync(3_000);

        running.set('exits', false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(inactive).toHaveBeenCalledWith('exits', 'claude');
        probe.cancel('cancelled');
        probe.close();

        expect(ended).toEqual([
            expect.objectContaining({
                terminalId: 'exits',
                provider: 'claude',
                reason: 'agent_exited',
                probes: 5,
                failures: 0,
                durationMs: 5_000,
            }),
            expect.objectContaining({ terminalId: 'cancelled', reason: 'terminal_ended' }),
            expect.objectContaining({ terminalId: 'closing', reason: 'server_closing' }),
        ]);
        for (const record of ended)
            expect(
                Object.keys(record).toSorted((left, right) => left.localeCompare(right)),
            ).toEqual([
                'durationMs',
                'failures',
                'probeMaxMs',
                'probeP95Ms',
                'probes',
                'provider',
                'reason',
                'terminalId',
            ]);

        // A watch that loses its running availability, and one replaced by a newer confirmation.
        const second = watchingProbe(() => Promise.resolve('claude'));
        second.probe.observe('availability', 0, candidate());
        second.probe.observe('replaced', 1, candidate());
        await vi.advanceTimersByTimeAsync(0);
        second.probe.observe('replaced', 1, candidate());
        await vi.advanceTimersByTimeAsync(0);
        second.state.current = false;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(second.ended.map(({ terminalId, reason }) => [terminalId, reason])).toEqual([
            ['replaced', 'replaced'],
            ['availability', 'availability_changed'],
            ['replaced', 'availability_changed'],
        ]);
    });

    it('counts a failed probe and keeps watching', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const detect = vi
            .fn<() => Promise<AgentProvider | undefined>>()
            .mockResolvedValueOnce('claude')
            .mockRejectedValueOnce(new Error('ps timed out'))
            .mockResolvedValue('claude');
        const { ended, probe } = watchingProbe(detect);
        probe.observe('terminal', 42, candidate());
        await vi.advanceTimersByTimeAsync(2_000);
        probe.cancel('terminal');

        expect(ended).toEqual([
            expect.objectContaining({ reason: 'terminal_ended', probes: 2, failures: 1 }),
        ]);
    });
});
