import { MOBILE_GATEWAY_MAX_WIRE_BYTES } from '@caxri/mobile-transport';

const MAXIMUM_QUEUED_MESSAGES = 256;
const MAXIMUM_QUEUED_BYTES = MOBILE_GATEWAY_MAX_WIRE_BYTES * 8;

/**
 * Bounds messages delivered by React Native before the serial request reader consumes them. A mutually authenticated
 * peer is still untrusted for availability, so neither handshake nor request processing may create an unbounded inbox.
 *
 * The bound must still absorb a legitimate burst: the phone pipelines a Session's subscriptions and reads, a running
 * Agent streams Chat events, and React Native may deliver several WebSocket messages in one JS batch before the
 * reader's continuation runs. Over the Relay, TCP coalescing makes such batches common. A four-message bound closed
 * live connections there, and each forced reconnect cost a full Relay handshake. 256 messages is a generous ceiling,
 * not a measured one; the byte bound (about 1 MB) is what keeps the inbox cheap.
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
