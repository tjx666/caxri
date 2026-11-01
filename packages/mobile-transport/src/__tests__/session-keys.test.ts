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
            clientToServer: 'f40ba4d91783e57dcfb3b0d5c0948bbf470956f9d3a0f93e26025a8ef8724070',
            confirmation: 'f767769620832f00a10a6cea50749610d28959c149159bdb57dde9bfcbe59d70',
            serverProof: '94cc043d4ed2690f1452855d348eb3bbfb1bb4289a8d2b711115d39c9ebd329d',
            serverToClient: 'b7851c1a85bebc2777fa9260e0e81c19d499e54d318af1674d7d54c7503cce7f',
            transcriptHash: 'd87a14553739949f3cfb8962baca356d290dbdce96901574ae8c864a6075b4f9',
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
