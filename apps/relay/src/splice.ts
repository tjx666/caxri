import { relayCloseCodes } from '@caxri/mobile-transport';
import type WebSocket from 'ws';
import type { RawData } from 'ws';

import type { RelayEndCause } from './log';

const OPEN = 1;
const BACKPRESSURE_POLL_MS = 25;

export interface SpliceLimits {
    pauseAboveBytes: number;
    resumeBelowBytes: number;
    maxDirectionBufferedBytes: number;
    maxPausedMs: number;
}

export interface SpliceEnd {
    cause: RelayEndCause;
    bytesUp: number;
    bytesDown: number;
    durationMs: number;
}

/**
 * Close codes that carry a peer's own decision and may cross the splice unchanged. Everything else (1001 going away,
 * 1005 no status, 1006 abnormal, 1011 internal) reads as the peer vanishing.
 */
const mirroredCloseCode = (code: number): number =>
    code === 1000 || (code >= 3000 && code <= 4999) ? code : relayCloseCodes['peer-gone'];

const byteLength = (data: RawData): number => {
    if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
    return data instanceof ArrayBuffer ? data.byteLength : data.length;
};

/**
 * Joins the phone's socket (`client`) to the Server's dial-back socket (`host`) without reading either stream. Each
 * direction pauses its source while the destination's send buffer is above the high watermark, so a slow phone backs
 * pressure up into the Server's TCP window instead of into Relay memory. A direction stuck above the hard cap or paused
 * for too long ends both sockets as `capacity`.
 */
export class Splice {
    readonly #limits: SpliceLimits;
    readonly #now: () => number;
    readonly #startedAt: number;
    readonly #onEnd: (end: SpliceEnd) => void;
    readonly #recordedCause?: (socket: WebSocket) => RelayEndCause | undefined;
    readonly #pausedSince = new Map<WebSocket, number>();
    #timer?: ReturnType<typeof setInterval>;
    #bytesUp = 0;
    #bytesDown = 0;
    #ended = false;
    #endCause?: RelayEndCause;
    readonly client: WebSocket;
    readonly host: WebSocket;
    readonly keyHash: string;
    readonly hostId: string;

    constructor(input: {
        client: WebSocket;
        host: WebSocket;
        hostId: string;
        keyHash: string;
        limits: SpliceLimits;
        now?: () => number;
        onEnd: (end: SpliceEnd) => void;
        /**
         * Reads the cause the Relay already recorded against a socket (a heartbeat timeout, a shutdown) before it
         * closed it. Supplied as a callback because the Relay forgets a socket's state as soon as it closes.
         */
        recordedCause?: (socket: WebSocket) => RelayEndCause | undefined;
    }) {
        this.client = input.client;
        this.host = input.host;
        this.hostId = input.hostId;
        this.keyHash = input.keyHash;
        this.#limits = input.limits;
        this.#now = input.now ?? Date.now;
        this.#startedAt = this.#now();
        this.#onEnd = input.onEnd;
        this.#recordedCause = input.recordedCause;
        this.#forward(this.client, this.host, (bytes) => (this.#bytesUp += bytes));
        this.#forward(this.host, this.client, (bytes) => (this.#bytesDown += bytes));
        this.#mirrorClose(this.client, this.host, 'client-closed');
        this.#mirrorClose(this.host, this.client, 'host-closed');
    }

    #forward(source: WebSocket, destination: WebSocket, count: (bytes: number) => void): void {
        source.on('message', (data, isBinary) => {
            if (destination.readyState !== OPEN) return;
            count(byteLength(data));
            destination.send(data, { binary: isBinary });
            if (destination.bufferedAmount > this.#limits.maxDirectionBufferedBytes) {
                this.close('capacity', relayCloseCodes.capacity);
                return;
            }
            if (destination.bufferedAmount > this.#limits.pauseAboveBytes && !source.isPaused) {
                source.pause();
                this.#pausedSince.set(source, this.#now());
                this.#ensureTimer();
            }
        });
    }

    /**
     * `ws` emits no drain event, so paused directions are polled until the destination falls below the low watermark.
     */
    #ensureTimer(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => {
            for (const [source, since] of this.#pausedSince) {
                const destination = source === this.client ? this.host : this.client;
                if (destination.bufferedAmount < this.#limits.resumeBelowBytes) {
                    this.#pausedSince.delete(source);
                    source.resume();
                } else if (this.#now() - since > this.#limits.maxPausedMs) {
                    this.close('capacity', relayCloseCodes.capacity);
                    return;
                }
            }
            if (this.#pausedSince.size === 0) this.#stopTimer();
        }, BACKPRESSURE_POLL_MS);
        this.#timer.unref();
    }

    #stopTimer(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = undefined;
    }

    #mirrorClose(source: WebSocket, destination: WebSocket, cause: RelayEndCause): void {
        source.on('error', () => {});
        source.on('close', (code, reason) => {
            this.#endCause ??= this.#recordedCause?.(source) ?? cause;
            if (destination.readyState === OPEN) destination.close(mirroredCloseCode(code), reason);
            else if (destination.readyState !== 3) destination.terminate();
            this.#finish();
        });
    }

    #finish(): void {
        if (this.#ended) return;
        this.#ended = true;
        this.#stopTimer();
        this.#pausedSince.clear();
        this.#onEnd({
            cause: this.#endCause ?? 'client-closed',
            bytesUp: this.#bytesUp,
            bytesDown: this.#bytesDown,
            durationMs: this.#now() - this.#startedAt,
        });
    }

    get bufferedAmount(): number {
        return this.client.bufferedAmount + this.host.bufferedAmount;
    }

    /**
     * Ends both sockets with one Relay decision. The first recorded cause wins.
     */
    close(cause: RelayEndCause, code: number): void {
        this.#endCause ??= cause;
        for (const socket of [this.client, this.host]) {
            if (socket.readyState === OPEN) socket.close(code);
            else socket.terminate();
        }
    }
}
