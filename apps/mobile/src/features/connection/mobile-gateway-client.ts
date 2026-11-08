import type { MobileFrameCipher } from '@caxri/mobile-transport';
import {
    decodeHex,
    encodeHex,
    HANDSHAKE_NONCE_BYTES,
    MOBILE_TRANSPORT_VERSION,
    mobilePairingResultSchema,
    mobilePublicKey,
    PAIRING_SECRET_BYTES,
    parseMobilePairingLink,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';

import type { MobileCredential, MobileCredentialStore } from './credential-store';
import type { MobileDirectEndpoints } from './direct-endpoint';
import { refreshDirectEndpoint, resolveDirectEndpoint } from './direct-endpoint';
import { isDirectRouteReachable, pairedGatewayRoutes } from './gateway-routes';
import type { MobileGatewayConnectionOptions } from './mobile-gateway-connection';
import { MobileGatewayConnection } from './mobile-gateway-connection';
import {
    MobilePairingError,
    MobileReconnectError,
    MobileServerVerificationError,
    MobileVersionMismatchError,
} from './mobile-gateway-errors';
import type { EstablishedSession } from './mobile-gateway-session';
import { establish, HANDSHAKE_TIMEOUT_MS, receiveSealed } from './mobile-gateway-session';
import { pairingClientHello } from './pairing-client-hello';
import { pairingCredential } from './pairing-credential';
import { createPairingSocketRuntime } from './pairing-socket-runtime';
import type { MobileRouteHints } from './route-hints';
import { reconnectDirectGrace } from './route-hints';
import type { MobileRoutePreference, MobileRoutePreferenceStore } from './route-preference';
import { DEFAULT_MOBILE_ROUTE_PREFERENCE, routesForPreference } from './route-preference';

export {
    MobileGatewayRequestError,
    MobileGatewayTimeoutError,
    MobilePairingError,
    MobileReconnectError,
    MobileVersionMismatchError,
} from './mobile-gateway-errors';

export interface MobileGatewayRuntime {
    /**
     * Seals and opens session frames: the phone's native AES-GCM in the app, the pure-JS cipher in tests. Required, so
     * a runtime that forgets it fails to compile instead of silently falling back to the slow cipher.
     */
    frameCipher: MobileFrameCipher;
    openWebSocket(url: string): WebSocket;
    platform: 'android' | 'ios';
    randomBytes(length: number): Uint8Array;
    /**
     * Whether the phone is on cellular data, where home LAN addresses cannot answer; absent in tests.
     */
    isCellular?: () => Promise<boolean>;
    /**
     * Shortens the direct-only head start when the Relay won last time; absent while pairing and in tests.
     */
    routeHints?: MobileRouteHints;
    /**
     * The computer's last reported direct addresses, which replace the paired ones once known; absent in tests.
     */
    directEndpoints?: MobileDirectEndpoints;
    /**
     * The user's pinned path for reconnects; absent in tests, where every route races.
     */
    routePreference?: MobileRoutePreferenceStore;
}

export interface PairedMobileConnection {
    connection: MobileGatewayConnection;
    credential: MobileCredential;
}

const hasUnsupportedPairingLinkVersion = (source: string): boolean => {
    try {
        const url = new URL(source);
        if (url.protocol !== 'caxri:' || url.hostname !== 'pair') return false;
        const versionText = url.searchParams.get('v');
        if (versionText === null) return false;
        const version = Number(versionText);
        if (!Number.isSafeInteger(version)) return false;
        return version !== MOBILE_TRANSPORT_VERSION;
    } catch {
        return false;
    }
};

/**
 * Reads the computer's current direct endpoint over this connection and remembers it.
 */
const refreshEndpointOver = (
    connection: MobileGatewayConnection,
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
): Promise<void> =>
    refreshDirectEndpoint({
        endpoints: runtime.directEndpoints,
        read: () => connection.request('mobile.computer.routes'),
        serverId: credential.serverId,
    });

/**
 * Only `auto` moves a Relay session back to a direct path; a pinned path stays where the user put it. Each probe first
 * re-reads the computer's endpoint over the Relay, so a computer that changed networks during the session is probed at
 * its new address. `connection` is late-bound because the probe is configured before the connection exists.
 */
const directProbeOptions = (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
    preference: MobileRoutePreference,
    connection: () => MobileGatewayConnection | undefined,
): MobileGatewayConnectionOptions =>
    preference === 'auto'
        ? {
              directProbe: async () => {
                  const current = connection();
                  if (current) await refreshEndpointOver(current, credential, runtime);
                  const endpoint = await resolveDirectEndpoint(credential, runtime.directEndpoints);
                  return isDirectRouteReachable(endpoint.addresses, endpoint.port, runtime);
              },
          }
        : {};

const loadRoutePreference = async (runtime: MobileGatewayRuntime): Promise<MobileRoutePreference> =>
    (await runtime.routePreference?.load()) ?? DEFAULT_MOBILE_ROUTE_PREFERENCE;

export const pairMobileGateway = async (input: {
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    displayName: string;
    pairingLink: string;
    runtime: MobileGatewayRuntime;
    store: MobileCredentialStore;
}): Promise<PairedMobileConnection> => {
    let link: ReturnType<typeof parseMobilePairingLink>;
    try {
        link = parseMobilePairingLink(input.pairingLink);
    } catch {
        if (hasUnsupportedPairingLinkVersion(input.pairingLink))
            throw new MobileVersionMismatchError();
        throw new MobilePairingError('invalid-link', 'This is not a Caxri pairing link.');
    }
    if (link.expiresAt <= Date.now())
        throw new MobilePairingError('expired', 'This pairing code has expired.');
    const clientSecretKey = input.runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = input.runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const { runtime, dispose } = createPairingSocketRuntime(input.runtime, input.signal);
    let session: EstablishedSession;
    try {
        session = await establish({
            routes: pairedGatewayRoutes({ ...link, purpose: 'pairing', secret: link.secret }),
            mode: 'pair',
            expectedServerId: link.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(link.secret, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: pairingClientHello({
                pairingId: link.pairingId,
                displayName: input.displayName,
                platform: input.runtime.platform,
                clientSecretKey,
                clientNonce,
            }),
        });
    } catch (error) {
        dispose();
        if (error instanceof MobilePairingError || error instanceof MobileVersionMismatchError)
            throw error;
        throw new MobilePairingError('rejected', 'Caxri could not verify this pairing.');
    }
    try {
        const paired = mobilePairingResultSchema.parse(
            await receiveSealed(session, HANDSHAKE_TIMEOUT_MS),
        );
        if (paired.deviceId !== session.deviceId)
            throw new Error('Caxri returned an unexpected device identity.');
        const credential = pairingCredential(link, paired);
        await input.store.save(
            credential,
            () => !input.signal?.aborted && (input.isCurrent?.() ?? true),
        );
        if (input.signal?.aborted) throw new Error('Pairing attempt was cancelled.');
        dispose();
        const connection: MobileGatewayConnection = new MobileGatewayConnection(
            session,
            async () => {
                await input.store.clearIfCurrent(credential);
            },
            directProbeOptions(
                credential,
                input.runtime,
                await loadRoutePreference(input.runtime),
                () => connection,
            ),
        );
        void refreshEndpointOver(connection, credential, input.runtime);
        return { connection, credential };
    } catch (error) {
        dispose();
        session.reader.close();
        session.socket.close();
        throw error;
    }
};

export const reconnectMobileGateway = async (
    credential: MobileCredential,
    runtime: MobileGatewayRuntime,
    store: MobileCredentialStore,
): Promise<MobileGatewayConnection> => {
    const clientSecretKey = runtime.randomBytes(X25519_KEY_BYTES);
    const clientNonce = runtime.randomBytes(HANDSHAKE_NONCE_BYTES);
    const endpoint = await resolveDirectEndpoint(credential, runtime.directEndpoints);
    const [directGraceMs, preference] = await Promise.all([
        reconnectDirectGrace({ ...runtime, ...credential, ...endpoint }),
        loadRoutePreference(runtime),
    ]);
    let session: EstablishedSession;
    try {
        session = await establish({
            directGraceMs,
            routes: routesForPreference(
                pairedGatewayRoutes({
                    ...credential,
                    ...endpoint,
                    purpose: 'device',
                    secret: credential.credential,
                }),
                preference,
            ),
            mode: 'connect',
            expectedServerId: credential.serverId,
            clientSecretKey,
            clientNonce,
            presharedKey: decodeHex(credential.credential, PAIRING_SECRET_BYTES),
            runtime,
            clientHello: {
                type: 'hello',
                version: MOBILE_TRANSPORT_VERSION,
                mode: 'connect',
                deviceId: credential.deviceId,
                generation: credential.generation,
                clientPublicKey: encodeHex(mobilePublicKey(clientSecretKey)),
                clientNonce: encodeHex(clientNonce),
            },
        });
    } catch (error) {
        if (error instanceof MobileServerVerificationError) throw new MobileReconnectError();
        throw error;
    }
    const connection: MobileGatewayConnection = new MobileGatewayConnection(
        session,
        async () => {
            await store.clearIfCurrent(credential);
        },
        {
            ...directProbeOptions(credential, runtime, preference, () => connection),
            expectReady: {
                deviceId: credential.deviceId,
                generation: credential.generation,
                onReady: () => runtime.routeHints?.save(credential.serverId, session.route),
            },
        },
    );
    // Sent right behind the handshake like any first request; the Server answers it once `ready` is out.
    void refreshEndpointOver(connection, credential, runtime);
    return connection;
};
