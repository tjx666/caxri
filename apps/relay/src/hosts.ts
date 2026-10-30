import type { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import type { RelayGrant } from '@caxri/mobile-transport';
import { RELAY_MAX_GRANTS } from '@caxri/mobile-transport';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import type { Splice } from './splice';

/**
 * A frame the phone sent after `relay-connect` but before its splice existed.
 */
export interface EarlyFrame {
    data: RawData;
    isBinary: boolean;
}

/**
 * A phone admitted by key hash, waiting for its host to dial back with the ticket.
 */
export interface PendingClient {
    client: WebSocket;
    connectionId: string;
    hostId: string;
    keyHash: string;
    startedAt: number;
    /**
     * Stops holding early frames and returns them in arrival order, for the splice to forward first.
     */
    takeEarlyFrames(): EarlyFrame[];
    ticket: Buffer;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * An idle host-data socket the Server parked for the next phone.
 */
export interface ParkedStandby {
    socket: WebSocket;
    /**
     * Detaches the parked-state listeners before the socket joins a splice.
     */
    release(): void;
}

export interface RegisteredHost {
    control: WebSocket;
    hostId: string;
    registeredAt: number;
    /**
     * Key hash to optional expiry. Device grants have none; pairing grants expire with their QR link.
     */
    grants: Map<string, number | undefined>;
    /**
     * Present when the host asked for `standby`; admits one parked host-data socket at a time.
     */
    standbyTicket?: Buffer;
    standby?: ParkedStandby;
}

/**
 * In-memory routing state; nothing here survives a restart and nothing needs to. A restarted Relay is repopulated when
 * each Server's control socket reconnects and re-sends its full grant list, and phones simply reconnect.
 */
export class HostRegistry {
    readonly #hosts = new Map<string, RegisteredHost>();
    readonly #pending = new Map<string, PendingClient>();
    /**
     * Kept by host ID rather than inside `RegisteredHost`: a spliced connection outlives its host's control socket, and
     * a later registration's revocation must still be able to cut it. `register()` does not end these on
     * re-registration; an old connection ends when its Server closes it, and the Server's revocation cuts it.
     */
    readonly #splices = new Map<string, Set<Splice>>();
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    #pruneExpired(grants: Map<string, number | undefined>): void {
        const now = this.#now();
        for (const [keyHash, expiresAt] of grants)
            if (expiresAt !== undefined && expiresAt <= now) grants.delete(keyHash);
    }

    get hostCount(): number {
        return this.#hosts.size;
    }

    get standbyCount(): number {
        let total = 0;
        for (const host of this.#hosts.values()) if (host.standby) total += 1;
        return total;
    }

    get connectionCount(): number {
        let total = this.#pending.size;
        for (const splices of this.#splices.values()) total += splices.size;
        return total;
    }

    host(hostId: string): RegisteredHost | undefined {
        return this.#hosts.get(hostId);
    }

    hosts(): IterableIterator<RegisteredHost> {
        return this.#hosts.values();
    }

    /**
     * Installs a verified registration and returns the control socket it replaced, if any.
     */
    register(hostId: string, control: WebSocket, grants: RelayGrant[]): WebSocket | undefined {
        const previous = this.#hosts.get(hostId);
        const host: RegisteredHost = {
            control,
            hostId,
            registeredAt: this.#now(),
            grants: new Map(),
        };
        this.#hosts.set(hostId, host);
        this.applyGrants(host, grants, []);
        return previous?.control;
    }

    /**
     * Drops the registration only when `control` is still the current one, so a replaced socket's late close cannot
     * unregister its successor. Pending phones of a host that went away are returned for the caller to close.
     */
    unregister(hostId: string, control: WebSocket): PendingClient[] {
        const current = this.#hosts.get(hostId);
        if (current?.control !== control) return [];
        this.#hosts.delete(hostId);
        const dropped = this.#pending
            .values()
            .filter((item) => item.hostId === hostId)
            .toArray();
        for (const item of dropped) this.takePending(item.connectionId);
        return dropped;
    }

    /**
     * Applies one grant update and returns the splices admitted with a removed key, which the caller must cut. Throws
     * when the result would exceed the grant limit, leaving the grants unchanged.
     */
    applyGrants(host: RegisteredHost, add: RelayGrant[], remove: string[]): Splice[] {
        const next = new Map(host.grants);
        for (const keyHash of remove) next.delete(keyHash);
        for (const grant of add) next.set(grant.keyHash, grant.expiresAt);
        this.#pruneExpired(next);
        if (next.size > RELAY_MAX_GRANTS) throw new Error('Grant limit exceeded');
        host.grants = next;
        const removed = new Set(remove);
        return [...(this.#splices.get(host.hostId) ?? [])].filter((splice) =>
            removed.has(splice.keyHash),
        );
    }

    hasGrant(host: RegisteredHost, keyHash: string): boolean {
        if (!host.grants.has(keyHash)) return false;
        const expiresAt = host.grants.get(keyHash);
        if (expiresAt !== undefined && expiresAt <= this.#now()) {
            host.grants.delete(keyHash);
            return false;
        }
        return true;
    }

    hostConnectionCount(hostId: string): number {
        let total = this.#splices.get(hostId)?.size ?? 0;
        for (const item of this.#pending.values()) if (item.hostId === hostId) total += 1;
        return total;
    }

    /**
     * Checks a standby ticket against the host's current registration in constant time.
     */
    isStandbyTicketValid(host: RegisteredHost, ticket: Buffer): boolean {
        const expected = host.standbyTicket;
        return (
            expected !== undefined &&
            expected.length === ticket.length &&
            timingSafeEqual(expected, ticket)
        );
    }

    /**
     * Parks a standby socket and returns the one it replaced, which the caller closes.
     */
    park(host: RegisteredHost, standby: ParkedStandby): ParkedStandby | undefined {
        const previous = host.standby;
        host.standby = standby;
        return previous;
    }

    /**
     * Removes and returns the host's parked socket, for a phone to be spliced to.
     */
    takeStandby(host: RegisteredHost): ParkedStandby | undefined {
        const standby = host.standby;
        host.standby = undefined;
        return standby;
    }

    /**
     * Forgets a parked socket that closed, unless a newer one already replaced it.
     */
    forgetStandby(hostId: string, socket: WebSocket): void {
        const host = this.#hosts.get(hostId);
        if (host?.standby?.socket === socket) host.standby = undefined;
    }

    addPending(item: PendingClient): void {
        this.#pending.set(item.connectionId, item);
    }

    takePending(connectionId: string): PendingClient | undefined {
        const item = this.#pending.get(connectionId);
        if (!item) return undefined;
        this.#pending.delete(connectionId);
        clearTimeout(item.timer);
        return item;
    }

    /**
     * Consumes a ticket once. A wrong host or ticket leaves the pending phone in place for the genuine dial-back.
     */
    claim(connectionId: string, hostId: string, ticket: Buffer): PendingClient | undefined {
        const item = this.#pending.get(connectionId);
        if (!item || item.hostId !== hostId || item.ticket.length !== ticket.length)
            return undefined;
        if (!timingSafeEqual(item.ticket, ticket)) return undefined;
        return this.takePending(connectionId);
    }

    pending(): IterableIterator<PendingClient> {
        return this.#pending.values();
    }

    addSplice(splice: Splice): void {
        const set = this.#splices.get(splice.hostId) ?? new Set<Splice>();
        set.add(splice);
        this.#splices.set(splice.hostId, set);
    }

    removeSplice(splice: Splice): void {
        const set = this.#splices.get(splice.hostId);
        set?.delete(splice);
        if (set?.size === 0) this.#splices.delete(splice.hostId);
    }

    splices(): Splice[] {
        return this.#splices
            .values()
            .flatMap((set) => set.values())
            .toArray();
    }

    sweepExpiredGrants(): void {
        for (const host of this.#hosts.values()) this.#pruneExpired(host.grants);
    }
}
