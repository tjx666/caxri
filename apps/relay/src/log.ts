/**
 * Why a Relay socket was refused or ended. Closed enums keep the log aggregatable: a summary can count each reason
 * without parsing free text, and no reason ever carries an address, key, ticket, or payload.
 */
export type RelayRejection =
    | 'capacity'
    | 'host-offline'
    | 'host-timeout'
    | 'invalid-request'
    | 'not-found'
    | 'rate-limited'
    | 'source-pending'
    | 'unauthorized';

export type RelayEndCause =
    | 'capacity'
    | 'heartbeat-timeout'
    | 'host-closed'
    | 'client-closed'
    | 'replaced'
    | 'revoked'
    | 'shutting-down';

export interface RelayLogEvent {
    event: string;
    [field: string]: unknown;
}

export type RelayLogSink = (line: string) => void;

/**
 * Host IDs are not secret, but a short prefix is enough to follow one host through the log.
 */
export const shortHostId = (hostId: string): string => hostId.slice(0, 8);

/**
 * One JSON object per line on stdout, plus per-lifetime counters flushed by the periodic summary. Counters are never
 * deduplicated away: the summary reports totals since the previous summary and since start.
 */
export class RelayLogger {
    readonly #sink: RelayLogSink;
    readonly #now: () => number;
    readonly #total = new Map<string, number>();
    #window = new Map<string, number>();
    readonly #startedAt: number;

    constructor(sink: RelayLogSink, now: () => number = Date.now) {
        this.#sink = sink;
        this.#now = now;
        this.#startedAt = now();
    }

    write(event: RelayLogEvent): void {
        const fields = Object.fromEntries(
            Object.entries(event).filter(([, value]) => value !== undefined),
        );
        const time = new Date(this.#now()).toISOString();
        this.#sink(JSON.stringify({ time, ...fields }));
    }

    count(counter: string, amount = 1): void {
        this.#total.set(counter, (this.#total.get(counter) ?? 0) + amount);
        this.#window.set(counter, (this.#window.get(counter) ?? 0) + amount);
    }

    summary(gauges: Record<string, number>): void {
        const window = Object.fromEntries(this.#window);
        this.#window = new Map();
        this.write({
            event: 'relay.summary',
            uptimeMs: this.#now() - this.#startedAt,
            ...gauges,
            window,
            total: Object.fromEntries(this.#total),
        });
    }

    totals(): Record<string, number> {
        return Object.fromEntries(this.#total);
    }
}
