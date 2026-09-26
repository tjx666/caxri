import type { StructuredLogger } from '@caxri/system';

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

/**
 * Closed causes and lifetime totals explain transport failures without logging peer or payload data.
 */
export class MobileGatewayDiagnostics {
    readonly #counts = emptyCounts();
    #lastSummaryAt: number;
    #total = 0;

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
            this.logger?.write('warn', 'mobile_gateway.failure', { fields: { reason } });
        if (this.now() - this.#lastSummaryAt >= 60_000) this.flush();
    }

    flush(): void {
        if (this.#total === 0) return;
        this.logger?.write('info', 'mobile_gateway.failure_summary', {
            fields: { ...this.#counts, total: this.#total },
        });
        this.#lastSummaryAt = this.now();
    }
}
