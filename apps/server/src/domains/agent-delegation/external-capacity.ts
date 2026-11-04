import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DelegationAuthority } from './admission';
import { isSamePrincipal } from './admission';

/**
 * How many tasks one delegation client may have running or being admitted at once.
 */
const EXTERNAL_ACTIVE_TASK_LIMIT = 4;

/**
 * Bounds the fan-out of one external delegation client. The count belongs to the exact principal (client and
 * generation), across every Session and Project it delegates into: the shared anchor Session and the target Session are
 * the wrong buckets, because many clients share an anchor and one client spreads over many targets.
 */
export class ExternalCapacity {
    /**
     * Admissions in flight per principal, keyed by request ID: callers repeating one request share one entry, because
     * they join one admission and must not count as several tasks.
     */
    private readonly pending = new Map<string, Map<string, number>>();

    constructor(private readonly database: CaxriDatabase) {}

    /**
     * Refuses a client that already holds the limit of active records plus admissions still in flight. Any other caller
     * is unbounded here.
     */
    assertRoom(authority: DelegationAuthority): void {
        const { principal } = authority;
        if (principal.kind !== 'delegation-client') return;
        const active = this.database.agentDelegations
            .active()
            .filter((record) => isSamePrincipal(record.principal, principal)).length;
        const inFlight = this.pending.get(JSON.stringify(principal))?.size ?? 0;
        if (active + inFlight >= EXTERNAL_ACTIVE_TASK_LIMIT)
            throw new CaxriError(
                'CAPACITY',
                'This external delegation client already has four active or pending tasks',
            );
    }

    /**
     * Counts one admission in flight for the caller under its request ID; the returned function ends it.
     */
    reserve(authority: DelegationAuthority, requestId: string): () => void {
        if (authority.principal.kind !== 'delegation-client') return () => {};
        const key = JSON.stringify(authority.principal);
        const requests = this.pending.get(key) ?? new Map<string, number>();
        this.pending.set(key, requests);
        requests.set(requestId, (requests.get(requestId) ?? 0) + 1);
        return () => {
            const remaining = (requests.get(requestId) ?? 1) - 1;
            if (remaining <= 0) requests.delete(requestId);
            else requests.set(requestId, remaining);
            if (requests.size === 0 && this.pending.get(key) === requests) this.pending.delete(key);
        };
    }
}
