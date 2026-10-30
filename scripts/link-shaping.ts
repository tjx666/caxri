/**
 * A simulated network link for benchmarks: each direction is a serial pipe of a given bandwidth followed by a one-way
 * propagation delay, so a large reply queues behind its own bytes the way it does on a slow uplink. Used by
 * `scripts/ssh-link-throttle.ts` (an SSH `ProxyCommand`) and `scripts/relay-link-benchmark.ts` (an in-process TCP proxy
 * in front of the Relay).
 */

import type { Buffer } from 'node:buffer';
import type { AddressInfo, Server, Socket } from 'node:net';
import { connect, createServer } from 'node:net';
import type { Writable } from 'node:stream';

/**
 * Large enough to keep timer counts low, small enough that a 64 KiB packet arrives progressively, not all at once.
 */
const SEGMENT_BYTES = 4096;

/**
 * One direction of the link. Segments are delivered in order at `max(arrival, previous finish) + serialization +
 * one-way delay`, which keeps them monotonic, so a single FIFO and one timer suffice.
 */
export class LinkDirection {
    #busyUntil = 0;
    #queue: Array<{ at: number; segment: Buffer }> = [];
    #timer: ReturnType<typeof setTimeout> | undefined;
    #ended = false;

    constructor(
        private readonly output: Writable,
        private readonly bytesPerMs: number,
        private readonly oneWayMs: number,
    ) {}

    #schedule(): void {
        if (this.#timer !== undefined) return;
        const next = this.#queue.at(0);
        if (!next) {
            if (this.#ended) this.output.end();
            return;
        }
        this.#timer = setTimeout(
            () => {
                this.#timer = undefined;
                const now = performance.now();
                while ((this.#queue.at(0)?.at ?? Infinity) <= now)
                    this.output.write(this.#queue.shift()!.segment);
                this.#schedule();
            },
            Math.max(0, next.at - performance.now()),
        );
    }

    push(chunk: Buffer): void {
        for (let offset = 0; offset < chunk.length; offset += SEGMENT_BYTES) {
            const segment = chunk.subarray(offset, offset + SEGMENT_BYTES);
            const start = Math.max(performance.now(), this.#busyUntil);
            this.#busyUntil =
                this.bytesPerMs > 0 ? start + segment.length / this.bytesPerMs : start;
            this.#queue.push({ at: this.#busyUntil + this.oneWayMs, segment });
        }
        this.#schedule();
    }

    end(): void {
        this.#ended = true;
        this.#schedule();
    }
}

/**
 * Converts a link rate in kilobits per second to the bytes per millisecond `LinkDirection` takes; 0 means unlimited.
 */
export const bytesPerMsFromKbps = (kbps: number): number => (kbps * 1000) / 8 / 1000;

export interface ShapedLink {
    /**
     * Round trip added to every exchange, split evenly between the two directions.
     */
    rttMs: number;
    /**
     * Bandwidth in each direction; 0 relays at full speed and only adds the delay.
     */
    kbps?: number;
    /**
     * Round trips a new connection spends before its first byte can travel: 1 for plain TCP, 2 for TCP plus TLS 1.3.
     * Defaults to 1.
     */
    setupRoundTrips?: number;
}

export interface ShapedProxy {
    close(): Promise<void>;
    port: number;
}

/**
 * Listens on an ephemeral loopback port and forwards every TCP connection to `target` through a shaped link. A new
 * connection holds its first bytes for `setupRoundTrips` round trips, the cost of the TCP (and TLS) handshake a real
 * client pays before its first request travels.
 */
export const startShapedProxy = async (
    target: { host: string; port: number },
    link: ShapedLink,
): Promise<ShapedProxy> => {
    const bytesPerMs = bytesPerMsFromKbps(link.kbps ?? 0);
    const oneWayMs = link.rttMs / 2;
    const setupMs = link.rttMs * (link.setupRoundTrips ?? 1);
    const sockets = new Set<Socket>();
    const server: Server = createServer((client) => {
        client.pause();
        const upstream = connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        const up = new LinkDirection(upstream, bytesPerMs, oneWayMs);
        const down = new LinkDirection(client, bytesPerMs, oneWayMs);
        client.on('data', (chunk: Buffer) => up.push(chunk));
        client.on('end', () => up.end());
        upstream.on('data', (chunk: Buffer) => down.push(chunk));
        upstream.on('end', () => down.end());
        const destroy = (): void => {
            client.destroy();
            upstream.destroy();
            sockets.delete(client);
            sockets.delete(upstream);
        };
        client.on('error', destroy);
        upstream.on('error', destroy);
        // A close travels the link too, so the far side learns of it one way later.
        client.on('close', () => setTimeout(destroy, oneWayMs));
        upstream.on('close', () => setTimeout(destroy, oneWayMs));
        setTimeout(() => client.resume(), setupMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        close: () =>
            new Promise((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    };
};
