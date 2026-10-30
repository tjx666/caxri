import type { RelayGrant } from '@caxri/mobile-transport';
import {
    decodeHex,
    isRelayUrl,
    relayAccessKey,
    relayAccessKeyHash,
    relayHostIdForPublicKey,
    relayHostPublicKey,
} from '@caxri/mobile-transport';
import type { MobileRelayFailure } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type WebSocket from 'ws';

import type { MobileDeviceRegistry } from '../device-registry';
import type { RelayConnectorTiming } from './host-connector';
import { RelayHostConnector } from './host-connector';

const accessKeyHash = (secretHex: string, purpose: 'device' | 'pairing'): string =>
    relayAccessKeyHash(relayAccessKey(decodeHex(secretHex, 32), purpose));

export interface RelayRouteStatus {
    state: 'connecting' | 'offline' | 'online';
    hostId: string;
    lastFailure?: MobileRelayFailure;
}

export interface MobileRelayRouteOptions {
    /**
     * Source of the persisted host key and the device credentials whose grants the Relay holds; device changes resync
     * grants while the route is active.
     */
    registry: Pick<MobileDeviceRegistry, 'activeCredentials' | 'onDevicesChanged' | 'relayHostKey'>;
    pendingPairingSecrets: () => Array<{ expiresAt: number; secret: string }>;
    canAccept: () => boolean;
    onConnection: (socket: WebSocket, dialMs: number) => void;
    logger?: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    timing?: Partial<RelayConnectorTiming>;
}

/**
 * The gateway's view of the Relay: which URL is configured, the host ID phones address, the grant set derived from
 * pairing secrets and device credentials, and the one connector that runs while access is on. URL changes replace the
 * connector; an invalid or empty URL turns the route off.
 */
/* eslint-disable unicorn/consistent-class-member-order -- The public lifecycle API stays together before internals. */
export class MobileRelayRoute {
    readonly #options: MobileRelayRouteOptions;
    readonly #deviceGrantCache = new Map<string, string>();
    /**
     * Pairing grants by key hash, kept until their QR link expires even after the pairing is consumed. The Relay cuts
     * every splice admitted with a removed key, and a phone keeps its pairing socket as its first session, so a pairing
     * grant must only ever expire, never be removed.
     */
    readonly #pairingGrants = new Map<string, number>();
    #connector?: RelayHostConnector;
    #hostId?: string;
    #isActive = false;
    #secretKey?: Uint8Array;
    #url?: string;
    #hostKeyLoad?: Promise<void>;
    #stopDeviceChanges?: () => void;
    #grantUpdateHolds = 0;

    constructor(options: MobileRelayRouteOptions) {
        this.#options = options;
    }

    /**
     * The pairing target for a new QR link: present whenever a Relay is configured, even while the connector is
     * reconnecting, because the phone keeps it for later.
     */
    pairingTarget(): { hostId: string; url: string } | undefined {
        if (!this.#url || !this.#hostId) return;
        return { url: this.#url, hostId: this.#hostId };
    }

    status(): RelayRouteStatus | undefined {
        if (!this.#connector || !this.#hostId) return;
        const { lastFailure, state } = this.#connector;
        return {
            state: state === 'stopped' ? 'offline' : state,
            hostId: this.#hostId,
            ...(lastFailure && { lastFailure }),
        };
    }

    /**
     * Applies a new setting value. Resolves after the host key is loaded, so a pairing created right after carries the
     * Relay target.
     */
    async configure(url: string | null | undefined): Promise<void> {
        const next = url && isRelayUrl(url) ? url : undefined;
        if (next === this.#url && (!next || this.#secretKey)) return;
        this.#url = next;
        this.#stopConnector();
        if (next) await this.#loadHostKey();
        if (this.#isActive) this.#startConnector();
    }

    async activate(): Promise<void> {
        this.#isActive = true;
        this.#stopDeviceChanges ??= this.#options.registry.onDevicesChanged(() =>
            this.syncGrants(),
        );
        if (this.#url) await this.#loadHostKey();
        this.#startConnector();
    }

    syncGrants(): void {
        if (this.#grantUpdateHolds > 0) return;
        this.#connector?.syncGrants();
    }

    /**
     * Defers grant updates until the returned release runs, then syncs once. Revocation holds them so the sealed
     * `revoked` frame reaches the phone before the Relay cuts the splice for the removed key; otherwise the phone only
     * sees `unauthorized`, which never clears its credential.
     */
    deferGrantUpdates(): () => void {
        this.#grantUpdateHolds += 1;
        let isReleased = false;
        return () => {
            if (isReleased) return;
            isReleased = true;
            this.#grantUpdateHolds -= 1;
            this.syncGrants();
        };
    }

    deactivate(): void {
        this.#isActive = false;
        this.#stopDeviceChanges?.();
        this.#stopDeviceChanges = undefined;
        this.#pairingGrants.clear();
        this.#stopConnector();
    }

    #grants(): RelayGrant[] {
        const credentials = this.#options.registry.activeCredentials();
        const live = new Set(credentials);
        for (const credential of this.#deviceGrantCache.keys())
            if (!live.has(credential)) this.#deviceGrantCache.delete(credential);
        const devices = credentials.map((credential) => {
            let keyHash = this.#deviceGrantCache.get(credential);
            if (!keyHash) {
                keyHash = accessKeyHash(credential, 'device');
                this.#deviceGrantCache.set(credential, keyHash);
            }
            return { keyHash };
        });
        for (const { expiresAt, secret } of this.#options.pendingPairingSecrets())
            this.#pairingGrants.set(accessKeyHash(secret, 'pairing'), expiresAt);
        const now = this.#options.now?.() ?? Date.now();
        const pairings: RelayGrant[] = [];
        for (const [keyHash, expiresAt] of this.#pairingGrants)
            if (expiresAt <= now) this.#pairingGrants.delete(keyHash);
            else pairings.push({ keyHash, expiresAt });
        return [...pairings, ...devices];
    }

    /**
     * The key never changes for a profile, so concurrent callers share one load.
     */
    async #loadHostKey(): Promise<void> {
        this.#hostKeyLoad ??= (async () => {
            const secretKey = decodeHex(await this.#options.registry.relayHostKey(), 32);
            this.#secretKey = secretKey;
            this.#hostId = relayHostIdForPublicKey(relayHostPublicKey(secretKey));
        })();
        try {
            await this.#hostKeyLoad;
        } catch (error) {
            this.#hostKeyLoad = undefined;
            throw error;
        }
    }

    #startConnector(): void {
        if (this.#connector || !this.#url || !this.#secretKey) return;
        this.#connector = new RelayHostConnector({
            url: this.#url,
            secretKey: this.#secretKey,
            grants: () => this.#grants(),
            canAccept: this.#options.canAccept,
            onConnection: this.#options.onConnection,
            ...(this.#options.logger && { logger: this.#options.logger }),
            ...(this.#options.now && { now: this.#options.now }),
            ...(this.#options.timing && { timing: this.#options.timing }),
        });
        this.#connector.start();
    }

    #stopConnector(): void {
        this.#connector?.stop();
        this.#connector = undefined;
    }
}
/* eslint-enable unicorn/consistent-class-member-order */
