import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { MOBILE_TRANSPORT_VERSION } from './contract.js';
import { openMobileFrame, sealMobileFrame } from './sealed-frame.js';
import { deriveMobileSessionKeys, handshakeConfirmation, mobilePublicKey } from './session-keys.js';

export const MOBILE_TRANSPORT_ACCEPTANCE_VECTOR_ID = 'caxri-mobile-transport-v5';

const bytes = (start: number, length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => (start + index) & 0xff);

const expected = {
    clientConfirmation: 'baa8609119a002e19065568a3bd539565dbfe16548bb370cbf793ec5dc820da3',
    clientToServerCiphertext:
        '13d137572aabb3087e651bab06a23a53bfb3f7556038821c64f61eb04434c295556ba196142ebcdf31aa',
    serverConfirmation: 'eaeae4502676cc21eed0a57d45106777ae911399233366be064eb77816409efc',
    serverToClientCiphertext:
        '8d9dc1ed814753f1e7237af803c081a25c638844f4182e72fe0eeda135129e5873f4aa996be18225bdb1',
    transcriptHash: 'aaa72c420c4992de9d908ad124ec14f77f53a76790fd9381f1afe9d3600410f7',
} as const;

function evaluateMobileTransportAcceptanceVector() {
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
    const plaintext = utf8ToBytes('caxri-acceptance-vector-v5');
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
