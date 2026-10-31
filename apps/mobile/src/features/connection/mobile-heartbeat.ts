import type { MobileClientPayload } from '@caxri/mobile-transport';
import { encodeHex } from '@caxri/mobile-transport';

const HEARTBEAT_INTERVAL_MS = 3_000;
/**
 * Long enough to outlast a computer whose Server is starved of CPU for a few seconds; Orca's mobile client waits 8 s
 * for its liveness probe too. A dead path is still caught within about 11 s, and a wake or network change probes
 * sooner.
 */
const HEARTBEAT_ACK_DEADLINE_MS = 8_000;

/**
 * Application heartbeat is paused in background; the Server may close the idle socket.
 */
export class MobileHeartbeat {
    readonly #onTimeout: () => void;
    readonly #randomBytes: (size: number) => Uint8Array;
    readonly #send: (payload: MobileClientPayload) => void;
    #interval?: ReturnType<typeof setInterval>;
    #pending?: { nonce: string; timeout: ReturnType<typeof setTimeout> };
    /**
     * The unacknowledged nonce a background pause abandoned. A stalled Server may still answer it after the next
     * heartbeat went out; that late answer is stale, not a protocol violation.
     */
    #abandonedNonce?: string;

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
        if (nonce === this.#abandonedNonce) {
            this.#abandonedNonce = undefined;
            return;
        }
        if (!this.#pending) return;
        if (this.#pending.nonce !== nonce)
            throw new Error('Caxri returned an unexpected heartbeat nonce.');
        clearTimeout(this.#pending.timeout);
        this.#pending = undefined;
    }

    stop(): void {
        if (this.#interval !== undefined) clearInterval(this.#interval);
        this.#interval = undefined;
        if (this.#pending) {
            clearTimeout(this.#pending.timeout);
            this.#abandonedNonce = this.#pending.nonce;
        }
        this.#pending = undefined;
    }
}
