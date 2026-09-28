import {
    decodeHex,
    deriveMobileUpdateRecoveryKey,
    encodeHex,
    isMobileUpdateRecoveryProofEqual,
    mobileUpdateRecoveryClientProof,
    mobileUpdateRecoveryHelloSchema,
    mobileUpdateRecoveryProofSchema,
    mobileUpdateRecoveryServerProof,
} from '@caxri/mobile-transport';
import { describe, expect, it } from 'vitest';

import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { MobileUpdateRecoveryRejectedError, recoverMobileUpdate } from '../recover-mobile-update';
import { AndroidConnectingSocket, flushTasks, mobileCredential } from './mobile-gateway-fixture';

const bundle = { version: '0.0.77', versionCode: 77, sizeBytes: 1_024, md5: 'a'.repeat(32) };
const download = {
    bundle,
    expiresAt: 1_788_106_000_000,
    url: `http://192.168.1.5:41337/mobile/update/${'b'.repeat(64)}`,
};
const serverNonce = '77'.repeat(32);

type Behavior = 'accept' | 'no-bundle' | 'reject' | 'tamper';

/**
 * Plays Desktop's side of `update-recovery-v1` with the real transport crypto and the phone's stored credential.
 */
class RecoveryServerSocket extends EventTarget {
    readonly #behavior: Behavior;
    #hello?: ReturnType<typeof mobileUpdateRecoveryHelloSchema.parse>;
    isClosed = false;
    sent: unknown[] = [];

    constructor(behavior: Behavior) {
        super();
        this.#behavior = behavior;
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    #reply(value: unknown): void {
        queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })),
        );
    }

    close(): void {
        this.isClosed = true;
    }

    send(data: string): void {
        const frame = JSON.parse(data) as unknown;
        this.sent.push(frame);
        if (!this.#hello) {
            this.#hello = mobileUpdateRecoveryHelloSchema.parse(frame);
            this.#reply({
                type: 'update-recovery-challenge',
                protocol: 'update-recovery-v1',
                serverNonce,
            });
            return;
        }
        const key = deriveMobileUpdateRecoveryKey({
            credential: decodeHex(mobileCredential.credential, 32),
            transcript: {
                clientNonce: decodeHex(this.#hello.clientNonce, 32),
                deviceId: this.#hello.deviceId,
                generation: this.#hello.generation,
                serverId: mobileCredential.serverId,
                serverNonce: decodeHex(serverNonce, 32),
            },
        });
        const { proof } = mobileUpdateRecoveryProofSchema.parse(frame);
        expect(
            isMobileUpdateRecoveryProofEqual(
                decodeHex(proof),
                mobileUpdateRecoveryClientProof(key),
            ),
        ).toBe(true);
        if (this.#behavior === 'reject') {
            this.#reply({ type: 'update-recovery-rejected', protocol: 'update-recovery-v1' });
            return;
        }
        const payload = JSON.stringify(
            this.#behavior === 'no-bundle' ? { bundle: null } : download,
        );
        const signed =
            this.#behavior === 'tamper'
                ? JSON.stringify({ ...download, url: `${download.url.slice(0, -1)}c` })
                : payload;
        this.#reply({
            type: 'update-recovery-result',
            protocol: 'update-recovery-v1',
            payload: signed,
            proof: encodeHex(mobileUpdateRecoveryServerProof(key, payload)),
        });
    }
}

const runtimeFor = (behavior: Behavior) => {
    const sockets: RecoveryServerSocket[] = [];
    const runtime: MobileGatewayRuntime = {
        openWebSocket: () => {
            const socket = new RecoveryServerSocket(behavior);
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
        platform: 'android',
        randomBytes: (bytes) => new Uint8Array(bytes).fill(0x31),
    };
    return { runtime, sockets };
};

describe('recoverMobileUpdate', () => {
    it('proves the stored pairing and returns the verified download', async () => {
        const { runtime, sockets } = runtimeFor('accept');
        await expect(recoverMobileUpdate(mobileCredential, runtime)).resolves.toEqual(download);
        expect(sockets[0]?.sent[0]).toEqual({
            type: 'update-recovery-hello',
            protocol: 'update-recovery-v1',
            deviceId: mobileCredential.deviceId,
            generation: mobileCredential.generation,
            clientNonce: '31'.repeat(32),
        });
        expect(sockets[0]?.isClosed).toBe(true);
    });

    it('closes an address-race loser that Android opens after recovery began, without a hello', async () => {
        const winner = new RecoveryServerSocket('accept');
        const loser = new AndroidConnectingSocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: (url) =>
                (url.includes('192.168.1.5') ? loser : winner) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(0x31),
        };
        const credential = { ...mobileCredential, addresses: ['192.168.1.5', '192.168.1.6'] };

        await expect(recoverMobileUpdate(credential, runtime)).resolves.toEqual(download);
        loser.open();
        await flushTasks();

        expect(loser.sent).toEqual([]);
        expect(loser.isClosed).toBe(true);
    });

    it('returns no bundle when the newer Desktop ships no APK', async () => {
        const { runtime } = runtimeFor('no-bundle');
        await expect(recoverMobileUpdate(mobileCredential, runtime)).resolves.toEqual({
            bundle: null,
        });
    });

    it('reports a rejected pairing without a download', async () => {
        const { runtime, sockets } = runtimeFor('reject');
        await expect(recoverMobileUpdate(mobileCredential, runtime)).rejects.toBeInstanceOf(
            MobileUpdateRecoveryRejectedError,
        );
        expect(sockets[0]?.isClosed).toBe(true);
    });

    it('refuses a download URL the Desktop did not sign', async () => {
        const { runtime } = runtimeFor('tamper');
        await expect(recoverMobileUpdate(mobileCredential, runtime)).rejects.toThrow(
            'Caxri could not verify the update from your computer.',
        );
    });
});
