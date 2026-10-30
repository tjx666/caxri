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
            clientToServer: '15ac6eeb3907110817b12dd7e4818bf3c2c02e6845323c26cffea512d7023054',
            confirmation: '6c37cf4a99acb839365e9c02eae22fe972fc04230ef5d09bb59163c842ace67f',
            serverProof: 'c3a690dee6271b5a6730bcad541756b9edd4f4fc6d8011de7400595dcf295f8a',
            serverToClient: '8e157e07eea2eac79b67e59cda9d25fb1ae53cf11c616dabf6e37a57cfb8a27f',
            transcriptHash: '46c2b27fd746bb0f9b3fc7bc2e007b5b14c494dda7448ffbb5b4bad686304924',
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
