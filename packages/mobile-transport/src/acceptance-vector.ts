import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { MOBILE_TRANSPORT_VERSION } from './contract.js';
import { openMobileFrame, sealMobileFrame } from './sealed-frame.js';
import { deriveMobileSessionKeys, handshakeConfirmation, mobilePublicKey } from './session-keys.js';

export const MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID = 'caxri-mobile-transport-v3';

const bytes = (start: number, length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);

const expected = {
    clientConfirmation: '53839d9f120ebe69ff2b7af380e36c29fd161fa4b303d7895c0756c0e2e12a0e',
    clientToServerCiphertext:
        '76f025073f284ba088d6ce5e6efba3871d39a5bcb03d67e4bc4cb8073762ad730dd103d4f80abb4715f8',
    serverConfirmation: '343ef64548fc40d7d4aa3cf8dba413bd82f830f286254423781e48fc3936fc6a',
    serverToClientCiphertext:
        '4b4efa5f7c6549e39845ef88537919299fb71f500ce31f2182acbce797aa654045fe9717af8766a38054',
    transcriptHash: '4a82b6aecaefdcd245d8afa973a87143a2a1407bc03d5195ee6a46df85d6970f',
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
    const plaintext = utf8ToBytes('caxri-acceptance-vector-v3');
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
