import { describe, expect, it } from 'vitest';

import type { CaxriDatabase } from '../../db';
import type { DelegationAuthority } from '../admission';
import { ExternalCapacity } from '../external-capacity';

const client = (id: string): DelegationAuthority =>
    ({
        principal: { kind: 'delegation-client', id, generation: 1 },
    }) as unknown as DelegationAuthority;

function capacity() {
    return new ExternalCapacity({
        agentDelegations: { active: () => [] },
    } as unknown as CaxriDatabase);
}

describe('ExternalCapacity reservations', () => {
    it('counts callers repeating one request ID as one admission', () => {
        const limits = capacity();
        const authority = client('c1');
        limits.reserve(authority, 'request-1');
        limits.reserve(authority, 'request-1');
        limits.reserve(authority, 'request-2');
        limits.reserve(authority, 'request-3');

        // Three distinct requests are in flight: a fourth still fits.
        expect(() => limits.assertRoom(authority)).not.toThrow();

        limits.reserve(authority, 'request-4');
        expect(() => limits.assertRoom(authority)).toThrow(/four active or pending/u);
    });

    it('releases a request only after every caller of it settled', () => {
        const limits = capacity();
        const authority = client('c1');
        const first = limits.reserve(authority, 'request-1');
        const duplicate = limits.reserve(authority, 'request-1');
        for (const id of ['request-2', 'request-3', 'request-4']) limits.reserve(authority, id);
        first();
        expect(() => limits.assertRoom(authority)).toThrow();
        duplicate();
        expect(() => limits.assertRoom(authority)).not.toThrow();
    });
});
