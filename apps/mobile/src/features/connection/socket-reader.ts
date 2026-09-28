import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';

import { MobileSocketReaderBudget } from './socket-reader-budget';

/**
 * One ordered inbox for a gateway socket's JSON messages, shared by the handshake, the authenticated connection, and
 * update recovery.
 */
export interface SocketReader {
    close(): void;
    next(timeoutMs?: number): Promise<unknown>;
}

export const connectionClosedError = (): Error => new Error('The Caxri connection closed.');

export const createSocketReader = (socket: WebSocket): SocketReader => {
    const queued: Array<{ release(): void; value: unknown }> = [];
    const waiting: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    const budget = new MobileSocketReaderBudget();
    let isClosed = false;

    /**
     * A peer close may follow a final authenticated frame before the owner advances to its steady-state reader. Keep
     * already parsed frames available in that case; explicit local cleanup and protocol failures discard them.
     */
    const rejectAll = (shouldDiscardQueued: boolean): void => {
        isClosed = true;
        const pendingRequests = [...waiting];
        waiting.length = 0;
        if (shouldDiscardQueued) {
            const queuedMessages = [...queued];
            queued.length = 0;
            for (const item of queuedMessages) item.release();
        }
        for (const pending of pendingRequests) pending.reject(connectionClosedError());
    };
    socket.addEventListener('message', (event) => {
        if (isClosed) return;
        if (typeof event.data !== 'string') {
            socket.close();
            rejectAll(true);
            return;
        }
        if (event.data.length > MOBILE_GATEWAY_MAX_WIRE_BYTES) {
            socket.close();
            rejectAll(true);
            return;
        }
        // Server wire messages are ASCII JSON, so code-unit length is also their UTF-8 byte length.
        const byteLength = event.data.length;
        const release = budget.tryAcquire(byteLength);
        if (!release) {
            socket.close();
            rejectAll(true);
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(event.data) as unknown;
        } catch {
            release();
            socket.close();
            rejectAll(true);
            return;
        }
        const pending = waiting.shift();
        if (pending) {
            release();
            pending.resolve(value);
        } else queued.push({ release, value });
    });
    socket.addEventListener('close', () => rejectAll(false));
    socket.addEventListener('error', () => rejectAll(false));

    return {
        close: () => rejectAll(true),
        next: (timeoutMs) => {
            const item = queued.shift();
            if (item) {
                item.release();
                return Promise.resolve(item.value);
            }
            if (isClosed) return Promise.reject(connectionClosedError());
            return new Promise((resolve, reject) => {
                const timeout: { handle?: ReturnType<typeof setTimeout> } = {};
                const pending = {
                    resolve: (result: unknown) => {
                        clearTimeout(timeout.handle);
                        resolve(result);
                    },
                    reject: (error: Error) => {
                        clearTimeout(timeout.handle);
                        reject(error);
                    },
                };
                if (timeoutMs !== undefined)
                    timeout.handle = setTimeout(() => {
                        const index = waiting.indexOf(pending);
                        if (index !== -1) waiting.splice(index, 1);
                        reject(new Error('Caxri did not respond in time.'));
                    }, timeoutMs);
                waiting.push(pending);
            });
        },
    };
};
