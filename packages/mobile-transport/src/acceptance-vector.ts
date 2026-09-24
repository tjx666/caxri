import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { MOBILE_TRANSPORT_VERSION } from './contract.js';
import { openMobileFrame, sealMobileFrame } from './sealed-frame.js';
import { deriveMobileSessionKeys, handshakeConfirmation, mobilePublicKey } from './session-keys.js';

export const MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID = 'caxri-mobile-transport-v2';

const bytes = (start: number, length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);

const expected = {
    clientConfirmation: '9cdaf3180a0a29f53fe1694d11356d096911ddc6ce8faf8a9409aaf94179a78c',
    clientToServerCiphertext:
        '874a1faca67c30858bb0d474090f139843a39f7d8b25b6f0d16dde6d2668724dfb631cf70dcc7c01459a',
    serverConfirmation: 'e536409d2c3f5798d929f15261a24a444b32ea390969a58fa1332dcfaef272d1',
    serverToClientCiphertext:
        'aa56ebde662a602a361a8853d540d32c3e9b1d428c4e7d169b2954bd98f38d6ee420b5d86910f6768aa4',
    transcriptHash: '7a3f8fdf346e9c6550ec287c8359f96df8264e3b9a5d1ef19e9b9fab723dff5f',
} as const;

export function evaluateMobileTransportAcceptanceVector() {
    const clientSecretKey = bytes(0, 32);
    const serverSecretKey = bytes(32, 32);
    const presharedKey = bytes(64, 32);
    const connectionId = bytes(96, 16);
    const transcript = {
        clientNonce: bytes(112, 32),
        clientPublicKey: mobilePublicKey(clientSecretKey),
        connectionId,
        mode: 'pair' as const,
        principalId: 'acceptance-device',
        serverId: 'acceptance-server',
        serverNonce: bytes(144, 32),
        serverPublicKey: mobilePublicKey(serverSecretKey),
    };
    const client = deriveMobileSessionKeys({
        localSecretKey: clientSecretKey,
        peerPublicKey: transcript.serverPublicKey,
        presharedKey,
        transcript,
    });
    const server = deriveMobileSessionKeys({
        localSecretKey: serverSecretKey,
        peerPublicKey: transcript.clientPublicKey,
        presharedKey,
        transcript,
    });
    const plaintext = utf8ToBytes('caxri-acceptance-vector-v2');
    const clientContext = {
        connectionId,
        counter: 7,
        deviceId: 'acceptance-device',
        direction: 'client-to-server' as const,
    };
    const serverContext = {
        connectionId,
        counter: 11,
        deviceId: 'acceptance-device',
        direction: 'server-to-client' as const,
    };
    const clientCiphertext = sealMobileFrame(client.clientToServer, clientContext, plaintext);
    const serverCiphertext = sealMobileFrame(server.serverToClient, serverContext, plaintext);
    return {
        clientConfirmation: bytesToHex(handshakeConfirmation(client, 'client')),
        clientRoundTrip:
            bytesToHex(openMobileFrame(server.clientToServer, clientContext, clientCiphertext)) ===
            bytesToHex(plaintext),
        clientToServerCiphertext: bytesToHex(clientCiphertext),
        directionalKeysMatch:
            bytesToHex(client.clientToServer) === bytesToHex(server.clientToServer) &&
            bytesToHex(client.serverToClient) === bytesToHex(server.serverToClient),
        serverConfirmation: bytesToHex(handshakeConfirmation(server, 'server')),
        serverRoundTrip:
            bytesToHex(openMobileFrame(client.serverToClient, serverContext, serverCiphertext)) ===
            bytesToHex(plaintext),
        serverToClientCiphertext: bytesToHex(serverCiphertext),
        transcriptHash: bytesToHex(client.transcriptHash),
    };
}

export function verifyMobileTransportAcceptanceVector() {
    const actual = evaluateMobileTransportAcceptanceVector();
    const isStable =
        actual.directionalKeysMatch &&
        actual.clientRoundTrip &&
        actual.serverRoundTrip &&
        actual.clientConfirmation === expected.clientConfirmation &&
        actual.clientToServerCiphertext === expected.clientToServerCiphertext &&
        actual.serverConfirmation === expected.serverConfirmation &&
        actual.serverToClientCiphertext === expected.serverToClientCiphertext &&
        actual.transcriptHash === expected.transcriptHash;
    return {
        algorithms: ['X25519', 'HKDF-SHA256', 'AES-256-GCM'],
        protocolVersion: MOBILE_TRANSPORT_VERSION,
        status: isStable ? ('passed' as const) : ('failed' as const),
        vectorId: MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID,
    };
}
