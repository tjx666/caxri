import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';

const MAXIMUM_QUEUED_MESSAGES = 4;
const MAXIMUM_QUEUED_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 2;

/**
 * Bounds messages delivered by React Native before the serial request reader consumes them. A mutually authenticated
 * peer is still untrusted for availability, so neither handshake nor request processing may create an unbounded inbox.
 */
export class MobileSocketReaderBudget {
    #bytes = 0;
    #messages = 0;

    tryAcquire(byteLength: number): (() => void) | undefined {
        if (
            !Number.isSafeInteger(byteLength) ||
            byteLength < 0 ||
            byteLength > MOBILE_GATEWAY_MAX_WIRE_BYTES ||
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
