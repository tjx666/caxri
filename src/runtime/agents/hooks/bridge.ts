import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../../atomic-file';

const BRIDGE_SCRIPT = `'use strict';
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
// Providers pipe a JSON payload on stdin. Only the opaque session identifier is extracted so a manual
// in-terminal resume can rebind the Terminal; prompt and response content never cross this boundary.
function readSessionId(callback) {
  let source = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let sessionId;
    try {
      const payload = JSON.parse(source);
      const value = payload && (payload.session_id ?? payload.sessionId);
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) sessionId = value;
    } catch {}
    callback(sessionId);
  };
  // Stdin may be an interactive TTY when a human runs the bridge by hand; never wait on it.
  const timer = setTimeout(finish, 250);
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    source += chunk;
    if (source.length > 65536) { source = ''; clearTimeout(timer); finish(); }
  });
  process.stdin.on('end', () => { clearTimeout(timer); finish(); });
  process.stdin.on('error', () => { clearTimeout(timer); finish(); });
}
readSessionId((sessionId) => {
  if (sessionId) signal.agentSessionId = sessionId;
  const socket = net.createConnection(socketPath);
  socket.setTimeout(750, () => socket.destroy());
  socket.on('connect', () => socket.end(JSON.stringify(signal)));
  socket.on('data', () => {});
  socket.on('error', () => {});
  socket.on('close', () => process.exit(0));
});
`;

const BRIDGE_VERSION = 2;

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

async function writeIfChanged(path: string, source: string, mode: number): Promise<void> {
    try {
        if ((await readFile(path, 'utf8')) === source) return;
    } catch {
        // A missing or unreadable staged bridge is repaired by the atomic replacement below.
    }
    await atomicWrite(path, source, mode);
}

/**
 * Stages one version-independent executable path so ordinary Caxri upgrades do not churn hooks.
 */
export async function stageAgentHookBridge(sharedPath: string): Promise<string> {
    const directory = join(sharedPath, 'bin');
    const bridgePath = join(directory, 'caxri-agent-hook-bridge');
    const manifestPath = join(directory, 'manifest.json');
    try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            bridgeVersion?: unknown;
        };
        /**
         * A newer Caxri owns the shared bridge; older binaries must not downgrade it.
         */
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
