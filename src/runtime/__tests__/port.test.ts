import { describe, expect, it, vi } from 'vitest';

import { createRuntimeParentPort } from '../port';

describe('Runtime supervisor port', () => {
    it('adapts Electron utility-process messages', () => {
        let receive: ((event: { data: unknown }) => void) | undefined;
        const postMessage = vi.fn();
        const port = createRuntimeParentPort({
            on: vi.fn(),
            parentPort: {
                on: (_event, listener) => {
                    receive = listener;
                },
                postMessage,
            },
        });
        const listener = vi.fn();
        port.onMessage(listener);
        receive?.({ data: { id: 'request-1' } });
        port.send({ ok: true });
        expect(listener).toHaveBeenCalledWith({ id: 'request-1' });
        expect(postMessage).toHaveBeenCalledWith({ ok: true });
    });

    it('adapts Host child-process IPC without changing message shapes', () => {
        let receive: ((message: unknown) => void) | undefined;
        const send = vi.fn(() => true);
        const port = createRuntimeParentPort({
            on: (_event, listener) => {
                receive = listener;
            },
            send,
        });
        const listener = vi.fn();
        port.onMessage(listener);
        receive?.({ id: 'request-2' });
        port.send({ ok: true });
        expect(listener).toHaveBeenCalledWith({ id: 'request-2' });
        expect(send).toHaveBeenCalledWith({ ok: true });
    });

    it('treats a connected Host IPC backpressure signal as an accepted send', () => {
        const send = vi.fn(() => false);
        const port = createRuntimeParentPort({
            connected: true,
            on: vi.fn(),
            send,
        });

        expect(() => port.send({ ok: true })).not.toThrow();
        expect(send).toHaveBeenCalledWith({ ok: true });
    });

    it('fails before sending when the Host IPC channel is disconnected', () => {
        const send = vi.fn(() => false);
        const port = createRuntimeParentPort({
            connected: false,
            on: vi.fn(),
            send,
        });

        expect(() => port.send({ ok: true })).toThrow('Runtime parent IPC channel is unavailable');
        expect(send).not.toHaveBeenCalled();
    });

    it('fails closed without either supervised channel', () => {
        expect(() => createRuntimeParentPort({ on: vi.fn() })).toThrow(
            'authenticated supervisor IPC channel',
        );
    });
});
