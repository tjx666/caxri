import { describe, expect, it, vi } from 'vitest';

import { createTerminalSupervision } from '../supervision-services-creation';

const lifecycle = vi.hoisted(() => ({ events: [] as string[] }));

/**
 * The pollers stand in as recorders: the slice only owns their order, not their behavior.
 */
const recorder = vi.hoisted(
    () =>
        function recorder(name: string) {
            return class {
                constructor(readonly options?: Record<string, unknown>) {}

                isPending(terminalId: string): boolean {
                    lifecycle.events.push(`${name}.isPending:${terminalId}`);
                    return true;
                }

                start(): void {
                    lifecycle.events.push(`${name}.start`);
                }

                async close(): Promise<void> {
                    lifecycle.events.push(`${name}.close:begin`);
                    await Promise.resolve();
                    lifecycle.events.push(`${name}.close:end`);
                }
            };
        },
);

vi.mock('../terminal', () => ({
    createTerminalHandlers: () => ({}),
    PtyUsageMonitor: recorder('ptyUsage'),
    TerminalResourceMonitor: recorder('monitor'),
    TerminalSuspensionService: recorder('suspension'),
}));

vi.mock('../session', () => ({ ChatIdleCompaction: recorder('idleCompaction') }));

function compose() {
    lifecycle.events.length = 0;
    const suspensionState: { service?: unknown } = {};
    const UsageLimitWaits = recorder('usageLimitWaits');
    const supervision = createTerminalSupervision({
        agentChat: { states: { usageLimitWaits: new UsageLimitWaits() } } as never,
        configuration: {} as never,
        coordinator: { maintenanceTurns: {} } as never,
        database: {} as never,
        dependencies: { logger: { write: vi.fn() }, send: vi.fn() } as never,
        presence: { isSettled: () => true, visibleSessionIds: () => new Set() } as never,
        settlementWiring: { pullRequest: () => {} },
        suspensionState: suspensionState as never,
        terminals: {} as never,
        transcripts: {} as never,
        watchHub: {} as never,
    });
    return { supervision, suspensionState };
}

describe('createTerminalSupervision', () => {
    it('publishes the suspension service for launch hooks wired before it exists', () => {
        const { supervision, suspensionState } = compose();

        expect(suspensionState.service).toBe(supervision.terminalSuspension);
    });

    it('holds idle suspension for a Chat whose idle compaction is pending', () => {
        const { supervision } = compose();
        const { isChatCompactionPending } = (
            supervision.terminalSuspension as unknown as {
                options: { isChatCompactionPending: (terminalId: string) => boolean };
            }
        ).options;

        expect(isChatCompactionPending('chat-1')).toBe(true);
        expect(lifecycle.events).toEqual(['idleCompaction.isPending:chat-1']);
    });

    it('starts every poller and fully closes each one before the next', async () => {
        const { supervision } = compose();

        supervision.start();
        await supervision.close();

        // Suspension and the resource monitor keep the order the composition root closed them in before this slice owned
        // them; idle compaction and the usage-limit waits sit between.
        expect(lifecycle.events).toEqual([
            'suspension.start',
            'idleCompaction.start',
            'usageLimitWaits.start',
            'monitor.start',
            'ptyUsage.start',
            'suspension.close:begin',
            'suspension.close:end',
            'idleCompaction.close:begin',
            'idleCompaction.close:end',
            'usageLimitWaits.close:begin',
            'usageLimitWaits.close:end',
            'monitor.close:begin',
            'monitor.close:end',
            'ptyUsage.close:begin',
            'ptyUsage.close:end',
        ]);
    });
});
