import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { decodeHex, encodeHex } from '../encoding';
import {
    additionalDataForFrame,
    deriveMobileSessionKeys,
    handshakeConfirmation,
    isHandshakeConfirmationValid,
    nonceForCounter,
} from '../session-keys';

const clientSecret = decodeHex('11'.repeat(32));
const serverSecret = decodeHex('22'.repeat(32));
const presharedKey = decodeHex('33'.repeat(32));
const transcript = {
    clientNonce: decodeHex('44'.repeat(32)),
    clientPublicKey: x25519.getPublicKey(clientSecret),
    connectionId: decodeHex('55'.repeat(16)),
    mode: 'pair' as const,
    principalId: 'pairing_test',
    serverId: 'server_test',
    serverNonce: decodeHex('66'.repeat(32)),
    serverPublicKey: x25519.getPublicKey(serverSecret),
};

describe('mobile session keys', () => {
    it('derives the same directional keys for both X25519 peers', () => {
        const client = deriveMobileSessionKeys({
            localSecretKey: clientSecret,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey,
            transcript,
        });
        const server = deriveMobileSessionKeys({
            localSecretKey: serverSecret,
            peerPublicKey: transcript.clientPublicKey,
            presharedKey,
            transcript,
        });
        expect(encodeHex(client.clientToServer)).toBe(encodeHex(server.clientToServer));
        expect(encodeHex(client.serverToClient)).toBe(encodeHex(server.serverToClient));
        expect(encodeHex(client.confirmation)).toBe(encodeHex(server.confirmation));
        expect(
            isHandshakeConfirmationValid(handshakeConfirmation(server, 'server'), client, 'server'),
        ).toBe(true);
        expect(
            isHandshakeConfirmationValid(handshakeConfirmation(server, 'server'), client, 'client'),
        ).toBe(false);
        expect({
            clientToServer: encodeHex(client.clientToServer),
            confirmation: encodeHex(client.confirmation),
            serverProof: encodeHex(handshakeConfirmation(client, 'server')),
            serverToClient: encodeHex(client.serverToClient),
            transcriptHash: encodeHex(client.transcriptHash),
        }).toEqual({
            clientToServer: '842a5235a1f5cd327e52e988b181e2ce1770fa42ce5de742cb81295fa282b2fb',
            confirmation: '3b3671770d0ca604363c77fb2a0d0e9d36a673f5ddb2aa36a59aabbc3576b849',
            serverProof: 'f44f76762e52c457baa643b85e3bf7e7e13f341023ce205fa3cb6407db7e4ab5',
            serverToClient: 'e781963810d054072af7ee96963c72d6a4ff1153a112b31e4e1bf30bb0b09340',
            transcriptHash: 'cf284cd81384274bef445f424e61a6f013c22b60832dd0d647a84d32eb5a4a8a',
        });
    });

    it('binds every key to the complete transcript', () => {
        const original = deriveMobileSessionKeys({
            localSecretKey: clientSecret,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey,
            transcript,
        });
        const changed = deriveMobileSessionKeys({
            localSecretKey: clientSecret,
            peerPublicKey: transcript.serverPublicKey,
            presharedKey,
            transcript: { ...transcript, serverId: 'server_other' },
        });
        expect(encodeHex(original.clientToServer)).not.toBe(encodeHex(changed.clientToServer));
    });

    it('uses directional, monotonic 96-bit nonces and binds matching AAD', () => {
        expect(encodeHex(nonceForCounter('client-to-server', 0))).toBe('000000010000000000000000');
        expect(encodeHex(nonceForCounter('server-to-client', 1))).toBe('000000020000000000000001');
        expect(() => nonceForCounter('client-to-server', Number.MAX_SAFE_INTEGER)).toThrow();
        expect(
            encodeHex(
                additionalDataForFrame({
                    connectionId: transcript.connectionId,
                    counter: 4,
                    deviceId: 'device_test',
                    direction: 'client-to-server',
                }),
            ),
        ).not.toBe(
            encodeHex(
                additionalDataForFrame({
                    connectionId: transcript.connectionId,
                    counter: 4,
                    deviceId: 'device_test',
                    direction: 'server-to-client',
                }),
            ),
        );
    });

    it('rejects malformed transcript identifiers before deriving keys', () => {
        expect(() =>
            deriveMobileSessionKeys({
                localSecretKey: clientSecret,
                peerPublicKey: transcript.serverPublicKey,
                presharedKey,
                transcript: { ...transcript, connectionId: new Uint8Array(15) },
            }),
        ).toThrow('Connection ID length is invalid');
    });
});
