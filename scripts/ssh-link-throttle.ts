#!/usr/bin/env bun

/**
 * An OpenSSH `ProxyCommand` that relays stdin/stdout to a TCP target through a simulated link: each direction is a
 * serial pipe of `--kbps` bandwidth followed by half of `--rtt-ms` of propagation delay, so a large reply queues behind
 * its own bytes the way it does on a slow uplink. It also counts the bytes that actually cross the link (after SSH
 * encryption and any SSH compression) and keeps the totals in `<--stats-dir>/<pid>.json`, so a benchmark can read what
 * travelled without trusting the application's own accounting.
 *
 *     ProxyCommand bun run scripts/ssh-link-throttle.ts --target 127.0.0.1:2222 --kbps 400 --rtt-ms 400 --stats-dir /tmp/x
 *
 * `--kbps 0` relays at full speed and only adds the delay. Used by `scripts/ssh-link-benchmark.ts`; see
 * `docs/ssh-host.md#slow-links`.
 */

import type { Buffer } from 'node:buffer';
import { renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

/**
 * Large enough to keep timer counts low, small enough that a 64 KiB SSH packet arrives progressively, not all at once.
 */
const SEGMENT_BYTES = 4096;
const STATS_INTERVAL_MS = 200;

interface LinkStats {
    downBytes: number;
    upBytes: number;
}

/**
 * One direction of the link. Segments are delivered in order at `max(arrival, previous finish) + serialization +
 * one-way delay`, which keeps them monotonic, so a single FIFO and one timer suffice.
 */
class LinkDirection {
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

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            'kbps': { type: 'string', default: '0' },
            'rtt-ms': { type: 'string', default: '0' },
            'stats-dir': { type: 'string' },
            'target': { type: 'string' },
        },
    });
    const [host, port] = (values.target ?? '').split(':', 2);
    if (!host || !port) throw new Error('--target <host>:<port> is required');
    const bytesPerMs = (Number(values.kbps) * 1000) / 8 / 1000;
    const oneWayMs = Number(values['rtt-ms']) / 2;
    const stats: LinkStats = { downBytes: 0, upBytes: 0 };
    const statsFile = values['stats-dir']
        ? join(values['stats-dir'], `${process.pid}.json`)
        : undefined;
    let written = '';
    /**
     * Synchronous on purpose: the final flush must land before `process.exit`, and a tiny file every 200 ms costs
     * nothing. The rename keeps a reader from ever seeing half a file.
     */
    const flushStats = () => {
        const text = JSON.stringify(stats);
        if (!statsFile || text === written) return;
        written = text;
        // oxlint-disable-next-line node/no-sync -- the final flush must land before process.exit; see JSDoc above
        writeFileSync(`${statsFile}.tmp`, text);
        // oxlint-disable-next-line node/no-sync -- the final flush must land before process.exit; see JSDoc above
        renameSync(`${statsFile}.tmp`, statsFile);
    };
    const statsTimer = setInterval(flushStats, STATS_INTERVAL_MS);

    const socket = connect(Number(port), host);
    const up = new LinkDirection(socket, bytesPerMs, oneWayMs);
    const down = new LinkDirection(process.stdout, bytesPerMs, oneWayMs);
    process.stdin.on('data', (chunk: Buffer) => {
        stats.upBytes += chunk.length;
        up.push(chunk);
    });
    process.stdin.on('end', () => up.end());
    socket.on('data', (chunk: Buffer) => {
        stats.downBytes += chunk.length;
        down.push(chunk);
    });
    const finish = () => {
        clearInterval(statsTimer);
        flushStats();
        process.exit(0);
    };
    // Bytes still in flight are delivered before the relay exits, as a real link would.
    socket.on('end', () => down.end());
    process.stdout.on('finish', finish);
    socket.on('error', finish);
}
