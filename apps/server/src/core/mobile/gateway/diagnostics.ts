import type { MobileClientCloseReason } from '@caxri/mobile-transport';
import { mobileClientCloseReasonOf, relayCloseCodes } from '@caxri/mobile-transport';
import type { MobilePairingOutcomeReason } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { MobileUpdateRecoveryOutcome } from './update-recovery';

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
    replayRejected: 0,
    binaryFrame: 0,
    inboundCapacity: 0,
    transportError: 0,
    heartbeatIdle: 0,
    sendFailed: 0,
    outboundCapacity: 0,
    applicationClosed: 0,
    versionMismatch: 0,
});

export type MobileGatewayFailureReason = keyof ReturnType<typeof emptyCounts>;

/**
 * Failures that are a normal end of a connection rather than a fault: a phone in the background stops its heartbeat and
 * the Server closes the idle socket. They are still counted, but never raise the first-occurrence warning.
 */
const expectedFailures: ReadonlySet<MobileGatewayFailureReason> = new Set(['heartbeatIdle']);

/**
 * Who ended an established connection. Close codes alone cannot tell a Server `terminate()` from a lost network (both
 * read 1006 on the Server), so the Server records its own decision before the socket closes and the close code only
 * classifies endings the peer started.
 */
type MobileConnectionEndCause =
    | 'gateway-disabled'
    | 'heartbeat-idle'
    | 'peer-closed'
    | 'peer-dropped'
    | 'revoked'
    | 'server-terminated';

export interface MobileConnectionEnd {
    cause: MobileConnectionEndCause;
    /**
     * The WebSocket close code, written only when the peer ended the connection.
     */
    closeCode?: number;
    /**
     * The phone's own reason, decoded from a private-range close code it sent.
     */
    clientReason?: MobileClientCloseReason;
    /**
     * The Server's failure reason when it terminated the connection.
     */
    failureReason?: MobileGatewayFailureReason;
}
export type MobileConnectionRoute = 'lan' | 'relay';

/**
 * Server decisions win over the close code: a `terminate()` reaches the close handler as 1006, the same code a lost
 * network produces. 1006 without a Server decision means no close frame arrived from the phone. The Relay reports a
 * vanished phone as `peer-gone` because it can only mirror real close frames.
 */
export function mobileConnectionEnd(input: {
    closeCode: number;
    isDisabled: boolean;
    isRevoking: boolean;
    serverEnd: MobileConnectionEnd | undefined;
}): MobileConnectionEnd {
    if (input.isRevoking) return { cause: 'revoked' };
    if (input.isDisabled) return { cause: 'gateway-disabled' };
    if (input.serverEnd) return input.serverEnd;
    const { closeCode } = input;
    if (closeCode === 1_006 || closeCode === relayCloseCodes['peer-gone'])
        return { cause: 'peer-dropped' };
    const clientReason = mobileClientCloseReasonOf(closeCode);
    return {
        cause: 'peer-closed',
        closeCode,
        ...(clientReason !== undefined && { clientReason }),
    };
}

export type MobileTerminalResyncReason =
    'capacity' | 'generation-changed' | 'source-gap' | 'resize';

/**
 * Why a Host observer or lease release failed: closed causes, no identifiers. The `*-observe-failed` reasons mean an
 * observe rejected and the follow-up unobserve itself failed too, so an orphan Host observer may remain.
 */
export type MobileTerminalTeardownReason =
    'close-lease-release' | 'close-unobserve' | 'refresh-observe-failed' | 'start-observe-failed';

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

const pairingCountKey: Record<
    MobilePairingOutcomeReason,
    keyof ReturnType<typeof emptyPairingCounts>
> = {
    'started': 'started',
    'succeeded': 'succeeded',
    'expired': 'expired',
    'not-found': 'notFound',
};

const emptyPairingCounts = () => ({
    started: 0,
    succeeded: 0,
    expired: 0,
    notFound: 0,
});

/**
 * Closed causes and lifetime totals explain transport failures without logging peer or payload data.
 */
export class MobileGatewayDiagnostics {
    readonly #counts = emptyCounts();
    readonly #resyncCounts = emptyResyncCounts();
    readonly #pairingCounts = emptyPairingCounts();
    #lastSummaryAt: number;
    #total = 0;
    #resyncTotal = 0;
    #pairingTotal = 0;
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
        if (this.#counts[reason] === 1 && !expectedFailures.has(reason))
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
     * Rare and each one may mean an orphan Host observer, so every occurrence logs immediately with its closed reason.
     */
    terminalTeardownFailure(reason: MobileTerminalTeardownReason): void {
        this.logger?.write('warn', logEventCatalog.mobileGateway.terminalTeardownFailed, {
            fields: { reason },
        });
    }

    /**
     * Pairing attempts are human-paced (a QR scan), not attacker-repeatable like a transport failure, so every outcome
     * logs immediately instead of warning only on the first occurrence of its reason.
     */
    pairingOutcome(reason: MobilePairingOutcomeReason): void {
        this.#pairingCounts[pairingCountKey[reason]] += 1;
        this.#pairingTotal += 1;
        this.logger?.write('info', logEventCatalog.mobileGateway.pairingOutcome, {
            fields: { reason },
        });
        if (this.now() - this.#lastSummaryAt >= 60_000) this.flush();
    }

    /**
     * Recovery is human-paced (a phone stuck on an old transport) and each attempt is already bounded by TCP admission,
     * so every outcome logs immediately, like pairing.
     */
    updateRecovery(outcome: MobileUpdateRecoveryOutcome): void {
        this.logger?.write(
            outcome === 'accepted' || outcome === 'no-bundle' ? 'info' : 'warn',
            logEventCatalog.mobileGateway.updateRecovery,
            { fields: { outcome } },
        );
    }

    gatewayEnabled(): void {
        this.logger?.write('info', logEventCatalog.mobileGateway.enabled, { fields: {} });
    }

    gatewayDisabled(): void {
        this.logger?.write('info', logEventCatalog.mobileGateway.disabled, { fields: {} });
    }

    /**
     * `timing` holds the flat handshake durations from `handshakeTimingFields`, so a slow reconnect names its slow leg.
     */
    connectionEstablished(
        deviceId: string,
        route: MobileConnectionRoute,
        timing: Record<string, number> = {},
    ): void {
        this.logger?.write('info', logEventCatalog.mobileGateway.connectionEstablished, {
            fields: { deviceId, route, ...timing },
        });
    }

    /**
     * A `durationMs` on the close record is what makes a session's lifetime knowable without logging its content, and
     * the closed `cause` is what tells a phone in the background from one that hit an error.
     */
    connectionEnded(
        deviceId: string,
        durationMs: number,
        end: MobileConnectionEnd,
        route: MobileConnectionRoute,
    ): void {
        this.logger?.write('info', logEventCatalog.mobileGateway.connectionEnded, {
            fields: {
                deviceId,
                durationMs,
                route,
                cause: end.cause,
                ...(end.failureReason !== undefined && { failureReason: end.failureReason }),
                ...(end.closeCode !== undefined && { closeCode: end.closeCode }),
                ...(end.clientReason !== undefined && { clientReason: end.clientReason }),
            },
        });
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
        if (this.#pairingTotal > 0)
            this.logger?.write('info', logEventCatalog.mobileGateway.pairingSummary, {
                fields: { ...this.#pairingCounts, total: this.#pairingTotal },
            });
        this.#lastSummaryAt = this.now();
    }
}
