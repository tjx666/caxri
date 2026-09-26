import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

const emptyCounts = () => ({
    admissionAddress: 0,
    admissionCapacity: 0,
    admissionRate: 0,
    upgradeRequest: 0,
    upgradeCapacity: 0,
    handshakeTimeout: 0,
    authenticationFailed: 0,
    invalidHandshake: 0,
    invalidFrame: 0,
    binaryFrame: 0,
    inboundCapacity: 0,
    transportError: 0,
    applicationClosed: 0,
    versionMismatch: 0,
});

export type MobileGatewayFailureReason = keyof ReturnType<typeof emptyCounts>;
export type MobileTerminalResyncReason =
    'capacity' | 'generation-changed' | 'source-gap' | 'resize';

const resyncCountKey: Record<
    MobileTerminalResyncReason,
    keyof ReturnType<typeof emptyResyncCounts>
> = {
    'capacity': 'capacity',
    'generation-changed': 'generationChanged',
    'source-gap': 'sourceGap',
    'resize': 'resize',
};

const emptyResyncCounts = () => ({
    capacity: 0,
    generationChanged: 0,
    sourceGap: 0,
    resize: 0,
});

/**
 * Closed causes and lifetime totals explain transport failures without logging peer or payload data.
 */
export class MobileGatewayDiagnostics {
    readonly #counts = emptyCounts();
    readonly #resyncCounts = emptyResyncCounts();
    #lastSummaryAt: number;
    #total = 0;
    #resyncTotal = 0;
    #dashboardReads = 0;
    #sessionReads = 0;

    constructor(
        private readonly logger: Pick<StructuredLogger, 'write'> | undefined,
        private readonly now: () => number,
    ) {
        this.#lastSummaryAt = now();
    }

    failure(reason: MobileGatewayFailureReason): void {
        this.#counts[reason] += 1;
        this.#total += 1;
        if (this.#counts[reason] === 1)
            this.logger?.write('warn', logEventCatalog.mobileGateway.failure, {
                fields: { reason },
            });
        if (this.now() - this.#lastSummaryAt >= 60_000) this.flush();
    }

    terminalResync(reason: MobileTerminalResyncReason): void {
        this.#resyncCounts[resyncCountKey[reason]] += 1;
        this.#resyncTotal += 1;
        if (this.now() - this.#lastSummaryAt >= 60_000) this.flush();
    }

    /**
     * Counts public read methods before domain fan-out, without identifiers or payloads.
     */
    request(method: string): void {
        if (method === 'mobile.dashboard') this.#dashboardReads += 1;
        else if (method === 'mobile.session.show') this.#sessionReads += 1;
        else return;
        const count = method === 'mobile.dashboard' ? this.#dashboardReads : this.#sessionReads;
        if (count === 1) this.flush();
        else this.flushIfDue();
    }

    /**
     * Heartbeats preserve idle-window measurements with at most one periodic record per minute.
     */
    flushIfDue(): void {
        if (this.now() - this.#lastSummaryAt >= 60_000) this.flush();
    }

    flush(): void {
        if (this.#dashboardReads + this.#sessionReads > 0)
            this.logger?.write('info', logEventCatalog.mobileGateway.sessionReadSummary, {
                fields: { dashboardReads: this.#dashboardReads, sessionReads: this.#sessionReads },
            });
        if (this.#total > 0)
            this.logger?.write('info', logEventCatalog.mobileGateway.failureSummary, {
                fields: { ...this.#counts, total: this.#total },
            });
        if (this.#resyncTotal > 0)
            this.logger?.write('info', logEventCatalog.mobileGateway.terminalResyncSummary, {
                fields: { ...this.#resyncCounts, total: this.#resyncTotal },
            });
        this.#lastSummaryAt = this.now();
    }
}
