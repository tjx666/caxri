import { clearScheduledTimer, SingleFlight } from '@caxri/system';

/**
 * How long shutdown waits for running probes; a probe normally settles in well under 100ms, and a provider read that
 * hangs must not hold the Server open.
 */
const CLOSE_WAIT_MS = 1000;

/**
 * Serializes Agent metadata probes per Terminal. A probe requested while one runs joins it and queues one trailing
 * probe, so output that arrived mid-probe is still observed.
 *
 * Probes read the database, so {@link close} refuses new ones and waits (up to {@link CLOSE_WAIT_MS}) for running ones
 * before the composition root closes it; a probe that outlived shutdown used to log `agent.probe_failed` ("The database
 * connection is not open") after the logger's final flush.
 */
export class ProbeQueue {
    private readonly probes = new SingleFlight<string, void>();
    private readonly trailingRequests = new Set<string>();
    private readonly running = new Set<Promise<void>>();
    private isClosed = false;

    constructor(private readonly probeOnce: (terminalId: string) => Promise<void>) {}

    private async serialize(terminalId: string): Promise<void> {
        const isJoining = this.probes.has(terminalId);
        if (isJoining) this.trailingRequests.add(terminalId);
        await this.probes.run(terminalId, () => this.probeOnce(terminalId));
        if (isJoining) return;
        if (this.trailingRequests.delete(terminalId)) await this.probe(terminalId);
    }

    async probe(terminalId: string): Promise<void> {
        if (this.isClosed) return;
        const running = this.serialize(terminalId);
        this.running.add(running);
        try {
            await running;
        } finally {
            this.running.delete(running);
        }
    }

    async close(): Promise<void> {
        this.isClosed = true;
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CLOSE_WAIT_MS);
        });
        await Promise.race([Promise.allSettled(this.running), deadline]);
        clearScheduledTimer(timer);
    }
}
