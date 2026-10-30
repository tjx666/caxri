import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { MOBILE_TRANSPORT_VERSION } from './contract.js';
import { openMobileFrame, sealMobileFrame } from './sealed-frame.js';
import { deriveMobileSessionKeys, handshakeConfirmation, mobilePublicKey } from './session-keys.js';

export const MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID = 'caxri-mobile-transport-v4';

const bytes = (start: number, length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);

const expected = {
    clientConfirmation: '4ee9a01fd5841f839a4d7c175801d315571ed6819ba0371d08c28719c2886414',
    clientToServerCiphertext:
        '1ac9d4104fab82bba0eab77c18297eb195a6203bb3ae680f14641aef08a6512050c330c7776cd83f8e04',
    serverConfirmation: '51197562b73e94aa7c4b8dc8bfaf4c9fadec4f303b524ad1179aadef9472bcc7',
    serverToClientCiphertext:
        'd70e0f326e16c4d3f3ffe0b421ac46d107b350310165b387aeeb052f2456b6278d91ed9cc58a3a358e50',
    transcriptHash: 'a5e7141b3e4ac2eb6fdce8779ec5b7ba617afd584d3320c167c4cfe291f95712',
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
    const plaintext = utf8ToBytes('caxri-acceptance-vector-v4');
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
