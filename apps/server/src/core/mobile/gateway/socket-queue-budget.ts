import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';

export { MOBILE_GATEWAY_MAX_WIRE_BYTES };
const MAXIMUM_QUEUED_MESSAGES = 8;
const MAXIMUM_QUEUED_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 4;

/**
 * Bounds data already delivered by `ws` but still waiting for this connection's ordered handler. The WebSocket
 * `maxPayload` limit applies to one frame only; without a separate queue budget, an unauthenticated LAN peer can retain
 * an unbounded number of otherwise valid frames while an earlier handshake or request is awaiting I/O.
 */
export class MobileSocketQueueBudget {
    #bytes = 0;
    #messages = 0;

    tryAcquire(byteLength: number): (() => void) | undefined {
        if (
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            this.#messages >= MAXIMUM_QUEUED_MESSAGES ||
            this.#bytes + byteLength > MAXIMUM_QUEUED_BYTES
        )
            return;
        this.#messages += 1;
        this.#bytes += byteLength;
        let isReleased = false;
        return () => {
            if (isReleased) return;
            isReleased = true;
            this.#messages -= 1;
            this.#bytes -= byteLength;
        };
    }
}
