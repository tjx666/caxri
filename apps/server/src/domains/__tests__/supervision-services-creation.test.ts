import { describe, expect, it, vi } from 'vitest';

import { createTerminalSupervision } from '../supervision-services-creation';

const lifecycle = vi.hoisted(() => ({ events: [] as string[] }));

/**
 * Both pollers stand in as recorders: the slice only owns their order, not their behavior.
 */
vi.mock('../terminal', () => {
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
    }
    return {
        createTerminalHandlers: () => ({}),
        TerminalResourceMonitor: recorder('monitor'),
        TerminalSuspensionService: recorder('suspension'),
    };
});

function compose() {
    lifecycle.events.length = 0;
    const suspensionState: { service?: unknown } = {};
    const supervision = createTerminalSupervision({
        agentChat: {} as never,
        configuration: {} as never,
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

    it('starts both pollers and fully closes suspension before the resource monitor', async () => {
        const { supervision } = compose();

        supervision.start();
        await supervision.close();

        // The order the composition root closed them in before this slice owned them.
        expect(lifecycle.events).toEqual([
            'suspension.start',
            'monitor.start',
            'suspension.close:begin',
            'suspension.close:end',
            'monitor.close:begin',
            'monitor.close:end',
        ]);
    });
});
