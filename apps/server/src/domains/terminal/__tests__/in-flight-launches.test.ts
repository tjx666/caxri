import { describe, expect, it } from 'vitest';

import { InFlightLaunches } from '../in-flight-launches';

async function isPending(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol('pending');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(pending), 10));
    return (await Promise.race([promise, timeout])) === pending;
}

describe('InFlightLaunches', () => {
    it("waits for a launch its Session is still preparing, but not for another Session's", async () => {
        const launches = new InFlightLaunches();
        const prepared = launches.begin('session-1');
        launches.begin('session-2');
        const settled = launches.settled(() => false, 'session-1');

        expect(await isPending(settled)).toBe(true);
        prepared();
        await expect(settled).resolves.toBeUndefined();
    });

    it('keeps waiting for the launch a preparation hands off to before it is released', async () => {
        const launches = new InFlightLaunches();
        const prepared = launches.begin('session-1');
        const settled = launches.settled((terminalId) => terminalId === 'terminal-1', 'session-1');
        const start = Promise.withResolvers<void>();
        const launch = launches.track('terminal-1', start.promise);
        prepared();

        expect(await isPending(settled)).toBe(true);
        start.resolve();
        await launch;
        await expect(settled).resolves.toBeUndefined();
    });

    it('waits for the preparations of every Session when none is named', async () => {
        const launches = new InFlightLaunches();
        const prepared = launches.begin('session-2');
        const settled = launches.settled(() => true);

        expect(await isPending(settled)).toBe(true);
        prepared();
        await expect(settled).resolves.toBeUndefined();
    });
});
