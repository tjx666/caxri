import { mobileClientCloseReasons } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import { createSocketReader } from '../socket-reader';

const fakeSocket = () => {
    const target = new EventTarget();
    const close = vi.fn();
    const socket = Object.assign(target, { close }) as unknown as WebSocket;
    const deliver = (count: number): void => {
        for (let index = 0; index < count; index += 1)
            target.dispatchEvent(new MessageEvent('message', { data: `{"n":${index}}` }));
    };
    return { close, deliver, socket };
};

describe('createSocketReader', () => {
    it('holds a burst delivered in one batch until the reader consumes it', async () => {
        const { close, deliver, socket } = fakeSocket();
        const reader = createSocketReader(socket);
        deliver(64);

        expect(close).not.toHaveBeenCalled();
        await expect(reader.next()).resolves.toEqual({ n: 0 });
        await expect(reader.next()).resolves.toEqual({ n: 1 });
    });

    it('closes with the inbox-overflow reason once the bounded inbox is full', () => {
        const { close, deliver, socket } = fakeSocket();
        createSocketReader(socket);
        deliver(257);

        expect(close).toHaveBeenCalledExactlyOnceWith(
            mobileClientCloseReasons['inbox-overflow'],
            'inbox-overflow',
        );
    });
});
