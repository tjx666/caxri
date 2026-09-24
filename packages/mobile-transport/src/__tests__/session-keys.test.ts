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
            clientToServer: '7464a67d60fddd5b87fea1199241192ec176ea232a84fb2540420c562fd68e4e',
            confirmation: 'bec8284204e449aba800b3eac7eab4831117db335b1f716d67b2c59e1a235c68',
            serverProof: '59bb0e0938371a0bc21e5dd5bc89569edffedc4541eed5db193ebcf77a7a9398',
            serverToClient: 'b71400d0611435d7110e169cbf5dcc28d9b64ade49a7dfc521cdda20bcced1db',
            transcriptHash: '73a8f9080bded7e03a89f37db8a3e43d85f6c6682315c5e1a670e3d6efcf4a72',
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
