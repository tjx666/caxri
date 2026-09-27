import { Buffer } from 'node:buffer';

import { PAIRING_SECRET_BYTES } from '@caxri/mobile-transport';
import { CaxriError } from '@caxri/protocol';

const PAIRING_TTL_MS = 2 * 60_000;
const MAXIMUM_PENDING_PAIRINGS = 8;

export interface PendingPairing {
    expiresAt: number;
    pairingId: string;
    projectIds: string[];
    secret: string;
}

/**
 * Tracks pending mobile pairing offers between `createPairing` and the client's confirming handshake, and prunes
 * expired offers so the table cannot grow for the lifetime of a Server process.
 */
export class MobilePairingLedger {
    readonly #pairings = new Map<string, PendingPairing>();
    readonly #now: () => number;
    readonly #random: (bytes: number) => Uint8Array;

    constructor(now: () => number, random: (bytes: number) => Uint8Array) {
        this.#now = now;
        this.#random = random;
    }

    get size(): number {
        return this.#pairings.size;
    }

    create(projectIds: string[]): PendingPairing {
        this.removeExpired();
        if (this.#pairings.size >= MAXIMUM_PENDING_PAIRINGS)
            throw new CaxriError('CAPACITY', 'Too many mobile pairings are pending');
        const pairing: PendingPairing = {
            pairingId: Buffer.from(this.#random(16)).toString('hex'),
            secret: Buffer.from(this.#random(PAIRING_SECRET_BYTES)).toString('hex'),
            projectIds: [...projectIds],
            expiresAt: this.#now() + PAIRING_TTL_MS,
        };
        this.#pairings.set(pairing.pairingId, pairing);
        return pairing;
    }

    /**
     * Removes `pairingId` before the general expiry sweep so an already-expired pairing is still distinguishable from
     * one the Server never issued.
     */
    take(pairingId: string): { pairing?: PendingPairing; isValid: boolean } {
        const pairing = this.#pairings.get(pairingId);
        if (pairing) this.#pairings.delete(pairingId);
        const isValid = Boolean(pairing && pairing.expiresAt > this.#now());
        this.removeExpired();
        return { pairing, isValid };
    }

    removeExpired(): void {
        const now = this.#now();
        for (const [pairingId, pairing] of this.#pairings)
            if (pairing.expiresAt <= now) this.#pairings.delete(pairingId);
    }

    clear(): void {
        this.#pairings.clear();
    }
}
