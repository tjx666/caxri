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
    private readonly pending = new Map<string, number>();

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
        const inFlight = this.pending.get(JSON.stringify(principal)) ?? 0;
        if (active + inFlight >= EXTERNAL_ACTIVE_TASK_LIMIT)
            throw new CaxriError(
                'CAPACITY',
                'This external delegation client already has four active or pending tasks',
            );
    }

    /**
     * Counts one admission in flight for the caller; the returned function ends it.
     */
    reserve(authority: DelegationAuthority): () => void {
        if (authority.principal.kind !== 'delegation-client') return () => {};
        const key = JSON.stringify(authority.principal);
        this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
        return () => {
            const remaining = (this.pending.get(key) ?? 1) - 1;
            if (remaining <= 0) this.pending.delete(key);
            else this.pending.set(key, remaining);
        };
    }
}
