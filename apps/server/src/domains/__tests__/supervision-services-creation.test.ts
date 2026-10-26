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
            'suspension.close:begin',
            'suspension.close:end',
            'idleCompaction.close:begin',
            'idleCompaction.close:end',
            'usageLimitWaits.close:begin',
            'usageLimitWaits.close:end',
            'monitor.close:begin',
            'monitor.close:end',
        ]);
    });
});
