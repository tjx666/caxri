import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../../atomic-file';

const BRIDGE_SCRIPT = `'use strict';
const net = require('node:net');
// The shell wrapper maps these private exit codes to fixed diagnostics so runtime paths and arbitrary child stderr
// never escape the bridge boundary.
const exitCodes = {
  launchContextUnavailable: 10,
  socketTimeout: 11,
  socketUnavailable: 12,
  signalRejected: 13,
  ackUnavailable: 14,
};
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
const hasAnyLaunchContext = Boolean(
  process.env.CAXRI_HOOK_RUNTIME || socketPath || signal.terminalId || signal.launchId || signal.token,
);
const hasLaunchContext = Boolean(socketPath && signal.terminalId && signal.launchId && signal.token);
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
if (!hasAnyLaunchContext) {
  process.exitCode = 0;
} else if (!hasLaunchContext) {
  process.exitCode = exitCodes.launchContextUnavailable;
} else readSessionId((sessionId) => {
  if (sessionId) signal.agentSessionId = sessionId;
  const socket = net.createConnection(socketPath);
  let response = '';
  let settled = false;
  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    process.exitCode = exitCode;
  };
  socket.setEncoding('utf8');
  socket.setTimeout(750, () => {
    finish(exitCodes.socketTimeout);
    socket.destroy();
  });
  socket.on('connect', () => socket.end(JSON.stringify(signal)));
  socket.on('data', (chunk) => {
    response += chunk;
    if (response.length > 1024) response = '';
  });
  socket.on('end', () => {
    try {
      finish(JSON.parse(response).ok === true ? 0 : exitCodes.signalRejected);
    } catch {
      finish(exitCodes.ackUnavailable);
    }
  });
  socket.on('error', (error) => {
    const code = error && typeof error.code === 'string' ? error.code : undefined;
    finish(code === 'ENOENT' || code === 'ECONNREFUSED' ? 0 : exitCodes.socketUnavailable);
  });
  socket.on('close', () => {
    finish(exitCodes.ackUnavailable);
    process.stdin.pause();
  });
});
`;

const BRIDGE_VERSION = 7;

const BRIDGE_WRAPPER = String.raw`#!/bin/sh
bridge_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -z "$CAXRI_HOOK_RUNTIME" ] || [ ! -x "$CAXRI_HOOK_RUNTIME" ]; then
  if [ -S "$CAXRI_HOOK_SOCKET" ]; then
    printf 'caxri-hook: runtime_unavailable\n' >&2
  fi
elif [ ! -r "$bridge_dir/bridge.cjs" ]; then
  if [ -S "$CAXRI_HOOK_SOCKET" ]; then
    printf 'caxri-hook: bridge_unavailable\n' >&2
  fi
else
  ELECTRON_RUN_AS_NODE=1 "$CAXRI_HOOK_RUNTIME" "$bridge_dir/bridge.cjs" "$@" >/dev/null 2>&1
  bridge_status=$?
  case "$bridge_status" in
    0) ;;
    10)
      if [ -S "$CAXRI_HOOK_SOCKET" ]; then
        printf 'caxri-hook: launch_context_unavailable\n' >&2
      fi
      ;;
    11) printf 'caxri-hook: socket_timeout\n' >&2 ;;
    12) printf 'caxri-hook: socket_unavailable\n' >&2 ;;
    13) printf 'caxri-hook: signal_rejected\n' >&2 ;;
    14) printf 'caxri-hook: ack_unavailable\n' >&2 ;;
    *) printf 'caxri-hook: bridge_runtime_failed\n' >&2 ;;
  esac
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
