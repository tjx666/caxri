import { Buffer } from 'node:buffer';

import type { HandshakeTranscript, MobileClientHello } from '@caxri/mobile-transport';
import {
    decodeHex,
    deriveMobileSessionKeys,
    HANDSHAKE_NONCE_BYTES,
    MobileFrameCounter,
    mobilePublicKey,
    MobileReplayGuard,
    PAIRING_SECRET_BYTES,
    X25519_KEY_BYTES,
} from '@caxri/mobile-transport';
import type { Principal } from '@caxri/protocol';

import type { MobileDeviceRecord } from '../device-registry';
import type { MobileGatewayDiagnostics } from './diagnostics';
import type { MobileGatewayOptions } from './gateway-options';
import type { GatewaySession } from './gateway-session';
import type { MobilePairingLedger } from './pairing-ledger';

/**
 * Preserves one challenge shape for invalid pairing IDs without disclosing whether one exists.
 */
function dummyCandidate(
    hello: Extract<MobileClientHello, { mode: 'pair' }>,
    now: number,
    random: (bytes: number) => Uint8Array,
): MobileDeviceRecord {
    return {
        deviceId: `device_${Buffer.from(random(16)).toString('hex')}`,
        displayName: hello.displayName,
        platform: hello.platform,
        credential: Buffer.from(random(PAIRING_SECRET_BYTES)).toString('hex'),
        generation: 1,
        role: 'control',
        projectIds: ['invalid-pairing'],
        createdAt: now,
    };
}

interface MobileHandshakeDependencies {
    bootId: MobileGatewayOptions['bootId'];
    diagnostics: MobileGatewayDiagnostics;
    now: () => number;
    pairings: MobilePairingLedger;
    protocolIdentity: MobileGatewayOptions['protocolIdentity'];
    random: (bytes: number) => Uint8Array;
    registry: MobileGatewayOptions['registry'];
}

/**
 * Builds the Server side of a hello. An unknown pairing or device still gets a challenge of the same shape, derived
 * from random material, so the reply does not disclose whether it exists.
 */
export function beginMobileHandshake(
    hello: MobileClientHello,
    dependencies: MobileHandshakeDependencies,
): GatewaySession {
    const connectionId = Buffer.from(dependencies.random(16)).toString('hex');
    const serverSecretKey = dependencies.random(X25519_KEY_BYTES);
    const serverPublicKey = mobilePublicKey(serverSecretKey);
    const serverNonce = dependencies.random(HANDSHAKE_NONCE_BYTES);
    let deviceId: string;
    let generation: number;
    let presharedKey: Uint8Array;
    let principal: Principal | undefined;
    let candidate: MobileDeviceRecord | undefined;
    let isValid: boolean;
    if (hello.mode === 'pair') {
        const taken = dependencies.pairings.take(hello.pairingId);
        const pairing = taken.pairing;
        isValid = taken.isValid;
        if (!isValid) dependencies.diagnostics.pairingOutcome(pairing ? 'expired' : 'not-found');
        candidate = isValid
            ? dependencies.registry.preparePair({
                  displayName: hello.displayName,
                  platform: hello.platform,
                  projectIds: pairing!.projectIds,
              })
            : dummyCandidate(hello, dependencies.now(), dependencies.random);
        deviceId = candidate.deviceId;
        generation = candidate.generation;
        presharedKey = decodeHex(
            pairing?.secret ??
                Buffer.from(dependencies.random(PAIRING_SECRET_BYTES)).toString('hex'),
            PAIRING_SECRET_BYTES,
        );
    } else {
        const material = dependencies.registry.handshakeMaterial(hello.deviceId, hello.generation);
        isValid = Boolean(material);
        deviceId = hello.deviceId;
        generation = hello.generation;
        principal = material?.principal;
        presharedKey = decodeHex(
            material?.credential ??
                Buffer.from(dependencies.random(PAIRING_SECRET_BYTES)).toString('hex'),
            PAIRING_SECRET_BYTES,
        );
    }
    const transcript: HandshakeTranscript = {
        mode: hello.mode,
        serverId: dependencies.protocolIdentity.serverId,
        principalId: `paired-device:${deviceId}`,
        connectionId: decodeHex(connectionId, 16),
        clientPublicKey: decodeHex(hello.clientPublicKey, X25519_KEY_BYTES),
        serverPublicKey,
        clientNonce: decodeHex(hello.clientNonce, HANDSHAKE_NONCE_BYTES),
        serverNonce,
    };
    const keys = deriveMobileSessionKeys({
        localSecretKey: serverSecretKey,
        peerPublicKey: transcript.clientPublicKey,
        presharedKey,
        transcript,
    });
    return {
        candidate,
        connection: {
            serverId: dependencies.protocolIdentity.serverId,
            bootId: dependencies.bootId,
            stateEpoch: dependencies.protocolIdentity.stateEpoch,
            clientId: `mobile:${deviceId}`,
            connectionId,
        },
        deviceId,
        generation,
        inbound: new MobileReplayGuard(),
        keys,
        mode: hello.mode,
        outbound: new MobileFrameCounter(),
        principal,
        transcript,
        valid: isValid,
    };
}
