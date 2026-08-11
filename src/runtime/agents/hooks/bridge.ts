import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BRIDGE_SCRIPT = String.raw`'use strict';
const net = require('node:net');
const args = new Map();
for (let index = 2; index < process.argv.length - 1; index += 2) {
  if (process.argv[index].startsWith('--')) args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
const signal = {
  protocolVersion: 1,
  provider: args.get('provider'),
  phase: args.get('phase'),
  schemaVersion: Number(args.get('schema')),
  terminalId: process.env.CAXRI_HOOK_TERMINAL_ID,
  launchId: process.env.CAXRI_HOOK_LAUNCH_ID,
  token: process.env.CAXRI_HOOK_TOKEN,
};
const socketPath = process.env.CAXRI_HOOK_SOCKET;
if (!socketPath || !signal.terminalId || !signal.launchId || !signal.token) process.exit(0);
const socket = net.createConnection(socketPath);
socket.setTimeout(750, () => socket.destroy());
socket.on('connect', () => socket.end(JSON.stringify(signal)));
socket.on('data', () => {});
socket.on('error', () => {});
socket.on('close', () => process.exit(0));
`;

const BRIDGE_VERSION = 1;

const BRIDGE_WRAPPER = String.raw`#!/bin/sh
bridge_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "\${CAXRI_HOOK_RUNTIME:-}" ]; then
  ELECTRON_RUN_AS_NODE=1 "$CAXRI_HOOK_RUNTIME" "$bridge_dir/bridge.cjs" "$@" >/dev/null 2>&1
fi
case " $* " in
  *" --reply empty-json "*) printf '{}\n' ;;
esac
exit 0
`;

async function atomicWrite(path: string, source: string, mode: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', mode);
        try {
            await file.writeFile(source, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(dirname(path), 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

async function writeIfChanged(path: string, source: string, mode: number): Promise<void> {
    try {
        if ((await readFile(path, 'utf8')) === source) return;
    } catch {
        // A missing or unreadable staged bridge is repaired by the atomic replacement below.
    }
    await atomicWrite(path, source, mode);
}

/** Stages one version-independent executable path so ordinary Caxri upgrades do not churn hooks. */
export async function stageAgentHookBridge(sharedPath: string): Promise<string> {
    const directory = join(sharedPath, 'bin');
    const bridgePath = join(directory, 'caxri-agent-hook-bridge');
    const manifestPath = join(directory, 'manifest.json');
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            bridgeVersion?: unknown;
        };
        /** A newer Caxri owns the shared bridge; older binaries must not downgrade it. */
        if (typeof manifest.bridgeVersion === 'number' && manifest.bridgeVersion > BRIDGE_VERSION)
            return bridgePath;
    } catch {
        // Missing or malformed manifests are repaired together with the staged bridge below.
    }
    await Promise.all([
        writeIfChanged(join(directory, 'bridge.cjs'), BRIDGE_SCRIPT, 0o600),
        writeIfChanged(bridgePath, BRIDGE_WRAPPER, 0o700),
    ]);
    await writeIfChanged(
        manifestPath,
        `${JSON.stringify({ bridgeVersion: BRIDGE_VERSION }, null, 2)}\n`,
        0o600,
    );
    return bridgePath;
}
