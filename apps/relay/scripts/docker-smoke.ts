import { Buffer } from 'node:buffer';
/**
 * Builds the Relay image, runs it on an ephemeral loopback port, and proves the deployed bundle end to end: health,
 * host registration, a spliced echo round trip, and an unauthorized phone. The container is always removed.
 *
 * Usage: bun run apps/relay/scripts/docker-smoke.ts [--skip-build]
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
    createRelayHostKey,
    encodeHex,
    RELAY_PROTOCOL_VERSION,
    relayAccessKey,
    relayAccessKeyHash,
    relayCloseCodes,
    relayEndpoint,
    relayPaths,
    signRelayHostChallenge,
} from '@caxri/mobile-transport';
import WebSocket from 'ws';

const run = promisify(execFile);
const IMAGE = 'caxri-relay:smoke';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const dockerfile = fileURLToPath(new URL('../Dockerfile', import.meta.url));

const step = (message: string): void => {
    console.log(`[relay-smoke] ${message}`);
};

const docker = async (arguments_: string[]): Promise<string> => {
    const { stdout } = await run('docker', arguments_, {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForHealth = async (baseUrl: string): Promise<unknown> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
        try {
            // eslint-disable-next-line no-await-in-loop -- each probe must observe the container after the last delay
            const response = await fetch(`${baseUrl}${relayPaths.health}`);
            // eslint-disable-next-line no-await-in-loop -- returns on the first healthy probe
            if (response.ok) return await response.json();
        } catch {
            // The container is still starting.
        }
        if (Date.now() > deadline) throw new Error('Relay did not become healthy within 30s');
        // eslint-disable-next-line no-await-in-loop -- bounded polling interval
        await delay(250);
    }
};

/**
 * Collects JSON text frames in order and fails instead of hanging when one never arrives.
 */
const frames = (socket: WebSocket) => {
    const queue: unknown[] = [];
    const waiters: Array<(frame: unknown) => void> = [];
    socket.on('message', (data, isBinary) => {
        const frame = isBinary ? data : (JSON.parse((data as Buffer).toString('utf8')) as unknown);
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else queue.push(frame);
    });
    return (): Promise<unknown> =>
        queue.length > 0
            ? Promise.resolve(queue.shift())
            : new Promise((resolve, reject) => {
                  const timer = setTimeout(
                      () => reject(new Error('Timed out waiting for a frame')),
                      5_000,
                  );
                  waiters.push((frame) => {
                      clearTimeout(timer);
                      resolve(frame);
                  });
              });
};

const open = (url: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.once('open', () => resolve(socket));
        socket.once('error', reject);
    });

const closeCode = (socket: WebSocket): Promise<number> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), 5_000);
        socket.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });

const exercise = async (wsBase: string): Promise<void> => {
    const hostKey = createRelayHostKey();
    const device = relayAccessKey(randomBytes(32), 'device');
    const control = await open(relayEndpoint(wsBase, relayPaths.host));
    const nextControl = frames(control);
    const challenge = (await nextControl()) as { nonce: string };
    const signature = signRelayHostChallenge(
        hostKey.secretKey,
        Buffer.from(challenge.nonce, 'hex'),
    );
    control.send(
        JSON.stringify({
            type: 'host-register',
            version: RELAY_PROTOCOL_VERSION,
            publicKey: encodeHex(hostKey.publicKey),
            signature: encodeHex(signature),
            grants: [{ keyHash: relayAccessKeyHash(device) }],
        }),
    );
    const { hostId } = (await nextControl()) as { hostId: string };
    step('host registered');

    const client = await open(relayEndpoint(wsBase, relayPaths.client));
    const nextClient = frames(client);
    client.send(
        JSON.stringify({
            type: 'relay-connect',
            version: RELAY_PROTOCOL_VERSION,
            hostId,
            accessKey: encodeHex(device),
        }),
    );
    const incoming = (await nextControl()) as { connectionId: string; ticket: string };
    const data = await open(relayEndpoint(wsBase, relayPaths.hostData));
    data.on('message', (payload, isBinary) => data.send(payload, { binary: isBinary }));
    data.send(
        JSON.stringify({
            type: 'host-accept',
            version: RELAY_PROTOCOL_VERSION,
            hostId,
            connectionId: incoming.connectionId,
            ticket: incoming.ticket,
        }),
    );
    const ready = (await nextClient()) as { type: string };
    if (ready.type !== 'relay-ready') throw new Error(`Expected relay-ready, got ${ready.type}`);
    client.send(JSON.stringify({ ping: 'through-docker' }));
    const echoed = (await nextClient()) as { ping?: string };
    if (echoed.ping !== 'through-docker') throw new Error('Echo payload did not round-trip');
    step('echo round trip through the splice ok');

    const strangerKey = relayAccessKey(randomBytes(32), 'device');
    const stranger = await open(relayEndpoint(wsBase, relayPaths.client));
    const strangerClosed = closeCode(stranger);
    stranger.send(
        JSON.stringify({
            type: 'relay-connect',
            version: RELAY_PROTOCOL_VERSION,
            hostId,
            accessKey: encodeHex(strangerKey),
        }),
    );
    const code = await strangerClosed;
    if (code !== relayCloseCodes.unauthorized)
        throw new Error(`Expected 4401 for an ungranted key, got ${code}`);
    step('ungranted phone rejected with 4401');

    for (const socket of [client, data, control]) socket.close();
};

const main = async (): Promise<void> => {
    if (!process.argv.includes('--skip-build')) {
        step('building image');
        await docker(['build', '-f', dockerfile, '-t', IMAGE, '.']);
    }
    const container = await docker(['run', '--detach', '--publish', '127.0.0.1::8080', IMAGE]);
    try {
        const mapping = await docker(['port', container, '8080/tcp']);
        const port = mapping.split('\n', 1)[0]?.split(':').at(-1);
        if (!port) throw new Error(`Unexpected port mapping: ${mapping}`);
        const health = await waitForHealth(`http://127.0.0.1:${port}`);
        step(`health ${JSON.stringify(health)}`);
        await exercise(`ws://127.0.0.1:${port}`);
        const logs = await run('docker', ['logs', container]);
        const lines = `${logs.stdout}${logs.stderr}`.trim().split('\n');
        if (lines.every((line) => !line.includes('"event":"relay.connection_spliced"')))
            throw new Error('Container log is missing relay.connection_spliced');
        step(`container log lines: ${lines.length}`);
        await docker(['stop', '--time', '5', container]);
        const state = await docker(['inspect', '--format', '{{.State.ExitCode}}', container]);
        if (state !== '0') throw new Error(`Relay exited with ${state} on SIGTERM`);
        step('graceful SIGTERM exit 0');
    } finally {
        try {
            await docker(['rm', '--force', container]);
        } catch {
            // Already gone; nothing left to clean up.
        }
        step('container removed');
    }
    step('PASS');
};

await main();
