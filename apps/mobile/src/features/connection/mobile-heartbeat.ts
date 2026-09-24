import type { MobileClientPayload } from '@caxri/mobile-transport';
import { encodeHex } from '@caxri/mobile-transport';

const HEARTBEAT_INTERVAL_MS = 3_000;
const HEARTBEAT_ACK_DEADLINE_MS = 5_000;

/**
 * Application heartbeat is paused in background; the Server may close the idle socket.
 */
export class MobileHeartbeat {
    readonly #onTimeout: () => void;
    readonly #randomBytes: (size: number) => Uint8Array;
    readonly #send: (payload: MobileClientPayload) => void;
    #interval?: ReturnType<typeof setInterval>;
    #pending?: { nonce: string; timeout: ReturnType<typeof setTimeout> };

    constructor(input: {
        onTimeout: () => void;
        randomBytes: (size: number) => Uint8Array;
        send: (payload: MobileClientPayload) => void;
    }) {
        this.#onTimeout = input.onTimeout;
        this.#randomBytes = input.randomBytes;
        this.#send = input.send;
    }

    start(): void {
        if (this.#interval !== undefined) return;
        this.#interval = setInterval(() => {
            if (this.#pending) return;
            const nonce = encodeHex(this.#randomBytes(16));
            try {
                this.#send({ type: 'heartbeat', nonce });
            } catch {
                this.stop();
                this.#onTimeout();
                return;
            }
            const timeout = setTimeout(() => {
                if (this.#pending?.nonce !== nonce) return;
                this.stop();
                this.#onTimeout();
            }, HEARTBEAT_ACK_DEADLINE_MS);
            this.#pending = { nonce, timeout };
        }, HEARTBEAT_INTERVAL_MS);
    }

    acknowledge(nonce: string): void {
        if (!this.#pending) return;
        if (this.#pending.nonce !== nonce)
            throw new Error('Caxri returned an unexpected heartbeat nonce.');
        clearTimeout(this.#pending.timeout);
        this.#pending = undefined;
    }

    stop(): void {
        if (this.#interval !== undefined) clearInterval(this.#interval);
        this.#interval = undefined;
        if (this.#pending) clearTimeout(this.#pending.timeout);
        this.#pending = undefined;
    }
}
