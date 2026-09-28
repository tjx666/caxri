import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';
import { afterHotPaths } from './hot-paths';

async function settle(stop: Promise<unknown>): Promise<void> {
    try {
        await stop;
    } catch {
        // `send`'s caller records the failure; a reservation only needs the stop to be over.
    }
}

/**
 * Sends the background `terminal.stop` of a discarded launch and lets the next reservation of the same ID wait for it.
 * A retry reserves the next generation as soon as the failed launch unwinds, while this stop can still be waiting for
 * hot paths or, on Terminal Host, for managed Agent cancellation. The Host refuses a reservation until the sealed
 * generation's stop reaches its PTY, so reserving first would fail the retry instead of queueing it.
 */
export class DiscardStops {
    private readonly pending = new Map<string, Promise<void>>();

    constructor(private readonly supervisor: TerminalHostControl) {}

    private async forget(terminalId: string, settled: Promise<void>): Promise<void> {
        await settled;
        if (this.pending.get(terminalId) === settled) this.pending.delete(terminalId);
    }

    send(
        identity: RemoteTerminalIdentity,
        completions: ReadonlyArray<Promise<void>>,
    ): Promise<unknown> {
        const terminalId = identity.record.id;
        const stop = afterHotPaths(completions, () =>
            this.supervisor.request(
                { method: 'terminal.stop', params: { persistSnapshot: false } },
                terminalScope(identity, 'terminal.lifecycle'),
            ),
        );
        const settled = settle(stop);
        this.pending.set(terminalId, settled);
        // eslint-disable-next-line no-void -- The caller observes the stop's failure; this only forgets it once settled.
        void this.forget(terminalId, settled);
        return stop;
    }

    /**
     * The ID's latest discard stop, resolving once it settled whether or not Terminal Host accepted it. Undefined when
     * none is in flight, so a reservation without one still sends synchronously.
     */
    inFlight(terminalId: string): Promise<void> | undefined {
        return this.pending.get(terminalId);
    }
}
