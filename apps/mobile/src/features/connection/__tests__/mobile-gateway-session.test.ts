import type { MobileFrameCipher, MobileSessionKeys } from '@caxri/mobile-transport';
import { decodeSealedFrame, MobileFrameCounter } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import type { EstablishedSession } from '../mobile-gateway-session';
import { sendSealed } from '../mobile-gateway-session';

/**
 * A native cipher whose seals finish in whatever order the test releases them.
 */
function heldCipher() {
    const pending: Array<() => void> = [];
    const cipher: MobileFrameCipher = {
        open: () => Promise.reject(new Error('unused')),
        seal: (_key, _nonce, _additionalData, plaintext) =>
            new Promise((resolve) => {
                pending.push(() => resolve(new Uint8Array([...plaintext, ...new Uint8Array(16)])));
            }),
    };
    return { cipher, release: (index: number) => pending[index]?.() };
}

function session(cipher: MobileFrameCipher) {
    const send = vi.fn<(frame: Uint8Array) => void>();
    const established = {
        connectionId: new Uint8Array(16),
        deviceId: 'device_test',
        keys: { clientToServer: new Uint8Array(32) } as MobileSessionKeys,
        outbound: new MobileFrameCounter(),
        runtime: { frameCipher: cipher },
        sendQueue: Promise.resolve(),
        socket: { send },
    } as unknown as EstablishedSession;
    return { established, send };
}

describe('sendSealed', () => {
    it('writes frames in counter order even when a later seal finishes first', async () => {
        const held = heldCipher();
        const { established, send } = session(held.cipher);

        const first = sendSealed(established, { type: 'heartbeat', nonce: 'a' });
        const second = sendSealed(established, { type: 'heartbeat', nonce: 'b' });
        held.release(1);
        await Promise.resolve();
        expect(send).not.toHaveBeenCalled();
        held.release(0);
        await Promise.all([first, second]);

        expect(send.mock.calls.map(([frame]) => decodeSealedFrame(frame).counter)).toEqual([0, 1]);
    });

    it('rejects a send whose seal failed without blocking the queue behind it', async () => {
        const failing: MobileFrameCipher = {
            open: () => Promise.reject(new Error('unused')),
            seal: () => Promise.reject(new Error('seal failed')),
        };
        const { established, send } = session(failing);

        await expect(sendSealed(established, { type: 'heartbeat', nonce: 'a' })).rejects.toThrow(
            'seal failed',
        );
        expect(send).not.toHaveBeenCalled();
        await expect(established.sendQueue).resolves.toBeUndefined();
    });
});
