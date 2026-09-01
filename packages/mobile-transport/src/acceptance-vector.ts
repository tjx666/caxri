import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { MOBILE_TRANSPORT_VERSION } from './contract.js';
import { openMobileFrame, sealMobileFrame } from './sealed-frame.js';
import { deriveMobileSessionKeys, handshakeConfirmation, mobilePublicKey } from './session-keys.js';

export const MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID = 'caxri-mobile-transport-v1';

const bytes = (start: number, length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);

const expected = {
    clientConfirmation: 'd5a706dd212e8061f779c5ae4497f23d93a79c003a01b21bd3afa2211ba269f0',
    clientToServerCiphertext:
        'c9281a19ca342f6c0600324ef851d6f279cd7f4743a6d4faa19d47bc6492fd2f5cbe6d11a0665ee62cfb',
    serverConfirmation: 'f1d0a6fc38c37f71802c0eed148e3e890ae837525a7d4840e2430934edbc9575',
    serverToClientCiphertext:
        '57681d503d07bc41f54830f404c2b4d0c10ddb1070294f9917b0ee8750abf90c4260c14d6c808110b896',
    transcriptHash: 'df1aed5220e17696d541f62717b94b906c31d670430bc5b2b7caea9796d190fc',
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
    const plaintext = utf8ToBytes('caxri-acceptance-vector-v1');
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
