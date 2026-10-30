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
import { parseArgs } from 'node:util';

import { bytesPerMsFromKbps, LinkDirection } from './link-shaping';

const STATS_INTERVAL_MS = 200;

interface LinkStats {
    downBytes: number;
    upBytes: number;
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
    const bytesPerMs = bytesPerMsFromKbps(Number(values.kbps));
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
