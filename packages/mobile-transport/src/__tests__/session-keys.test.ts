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
            clientToServer: '6aa2904e4adf2262626bc11db2d50864ed1c42c3af3af3e2bc83da429c73750c',
            confirmation: '212727627f777cd7e924b61c768fdbaaef97cd35b6060eee516958c3d2a9db7a',
            serverProof: 'e6d50075d343bfdbcebdd13895b27e1d5b525d600b5a3c4975e62db8a2a91d18',
            serverToClient: '200bb707bf694a34991b470ea36ad770c8890064415c374ac7b6d0de750c0ce1',
            transcriptHash: 'b38db3b506386264e4d6cf66e8f049f7a002bace948e961638e5569a002671c7',
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
