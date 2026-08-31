import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWrite } from '../../atomic-file';

const BRIDGE_RECEIPT_TIMEOUT_MS = 250;
const BRIDGE_SOCKET_TIMEOUT_MS = 2_000;
const BRIDGE_STDIN_TIMEOUT_MS = 250;
export const AGENT_HOOK_BRIDGE_MAX_DELIVERY_MS = BRIDGE_STDIN_TIMEOUT_MS + BRIDGE_SOCKET_TIMEOUT_MS;

const BRIDGE_SCRIPT = String.raw`'use strict';
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
// Report a content-free, authenticated receipt before reading provider stdin. This makes a missing lifecycle signal
// distinguishable from a bridge that never reached the Server without exposing the provider payload.
function reportBridgeStarted() {
  const socket = net.createConnection(socketPath);
  socket.setTimeout(${BRIDGE_RECEIPT_TIMEOUT_MS}, () => socket.destroy());
  socket.on('connect', () => socket.end(JSON.stringify({ ...signal, kind: 'bridgeStarted' })));
  socket.on('data', () => {});
  socket.on('error', () => {});
}
// Providers pipe a JSON payload on stdin. Only opaque session, turn, subagent, and tool identifiers plus a bounded
// worktree-create classification are extracted, so commands, output, prompts, and responses never cross this boundary.
function splitShellSegments(command) {
  const segments = [];
  let segment = '';
  let quote;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      segment += character;
      continue;
    }
    const separator = character === ';' || character === '\n' || character === '\r' ||
      character === '(' || character === ')' || character === '|' ||
      (character === '&' && command[index + 1] === '&');
    if (!separator) {
      segment += character;
      continue;
    }
    if (segment.trim()) segments.push(segment);
    segment = '';
    if ((character === '|' && command[index + 1] === '|') ||
        (character === '&' && command[index + 1] === '&')) index += 1;
  }
  if (segment.trim()) segments.push(segment);
  return segments;
}
function tokenizeShellSegment(segment) {
  const tokens = [];
  let token = '';
  let quote;
  let escaped = false;
  const finish = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (const character of segment) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      finish();
    } else {
      token += character;
    }
  }
  finish();
  return tokens;
}
function basename(token) {
  return token.slice(token.lastIndexOf('/') + 1);
}
function findCommandIndex(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
  for (let wrappers = 0; wrappers < 4; wrappers += 1) {
    const command = basename(tokens[index] ?? '');
    if (command === 'command' || command === 'sudo' || command === 'rtk') {
      index += 1;
      continue;
    }
    if (command === 'env') {
      index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
      continue;
    }
    break;
  }
  return index;
}
function segmentCreatesWorktree(segment) {
  const tokens = tokenizeShellSegment(segment);
  let index = findCommandIndex(tokens);
  if (basename(tokens[index] ?? '') !== 'git') return false;
  index += 1;
  const optionsWithValues = new Set(['-C', '-c', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (optionsWithValues.has(option)) index += 1;
  }
  return tokens[index] === 'worktree' && tokens[index + 1] === 'add';
}
function hasWorktreeCreateIntent(payload) {
  if (!['shellToolStarted', 'shellToolFinished', 'shellToolFailed'].includes(signal.phase)) return false;
  const command = payload && payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string' || command.length === 0 || command.length > 32768) return false;
  return splitShellSegments(command).some(segmentCreatesWorktree);
}
function readIdentifiers(callback) {
  let source = '';
  let done = false;
  function prefixString(keys) {
    let commonEnd = source.length;
    for (const marker of ['"tool_calls"', '"tool_input"', '"tool_response"', '"permission_suggestions"']) {
      const index = source.indexOf(marker);
      if (index >= 0 && index < commonEnd) commonEnd = index;
    }
    const common = source.slice(0, commonEnd);
    for (const key of keys) {
      const match = common.match(new RegExp('(?:^|[,{])\\s*"' + key + '"\\s*:\\s*"([a-zA-Z0-9_.-]{1,256})"'));
      if (match) return match[1];
    }
  }
  const finish = () => {
    if (done) return;
    done = true;
    let agentId;
    let sessionId;
    let toolUseId;
    let turnId;
    let worktreeCreateIntent = false;
    try {
      const payload = JSON.parse(source);
      const agentValue = payload && (payload.agent_id ?? payload.agentId);
      if (typeof agentValue === 'string' && agentValue.length > 0 && agentValue.length <= 256) agentId = agentValue;
      const value = payload && (payload.session_id ?? payload.sessionId);
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) sessionId = value;
      const turnValue = payload && (payload.turn_id ?? payload.turnId);
      if (typeof turnValue === 'string' && turnValue.length > 0 && turnValue.length <= 256) turnId = turnValue;
      const toolValue = payload && (payload.tool_use_id ?? payload.toolUseId);
      if (typeof toolValue === 'string' && toolValue.length > 0 && toolValue.length <= 256) toolUseId = toolValue;
      worktreeCreateIntent = hasWorktreeCreateIntent(payload);
    } catch {
      // Common hook fields precede event-specific tool input/results. A large payload is intentionally truncated, but
      // these bounded opaque identifiers remain recoverable without retaining or parsing provider content.
      agentId = prefixString(['agent_id', 'agentId']);
      sessionId = prefixString(['session_id', 'sessionId']);
      turnId = prefixString(['turn_id', 'turnId']);
    }
    callback({ agentId, sessionId, toolUseId, turnId, worktreeCreateIntent });
  };
  // Stdin may be an interactive TTY when a human runs the bridge by hand; never wait on it.
  const timer = setTimeout(finish, ${BRIDGE_STDIN_TIMEOUT_MS});
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    source += chunk;
    if (source.length > 65536) { source = source.slice(0, 65536); clearTimeout(timer); finish(); }
  });
  process.stdin.on('end', () => { clearTimeout(timer); finish(); });
  process.stdin.on('error', () => { clearTimeout(timer); finish(); });
}
if (!hasAnyLaunchContext) {
  process.exitCode = 0;
} else if (!hasLaunchContext) {
  process.exitCode = exitCodes.launchContextUnavailable;
} else {
if (process.env.CAXRI_HOOK_RECEIPTS === '1') reportBridgeStarted();
readIdentifiers(({ agentId, sessionId, toolUseId, turnId, worktreeCreateIntent }) => {
  if (agentId) signal.agentId = agentId;
  if (sessionId) signal.agentSessionId = sessionId;
  if (toolUseId && worktreeCreateIntent) signal.agentToolUseId = toolUseId;
  if (turnId) signal.agentTurnId = turnId;
  if (worktreeCreateIntent) signal.worktreeCreateIntent = true;
  const socket = net.createConnection(socketPath);
  let response = '';
  let settled = false;
  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    process.exitCode = exitCode;
  };
  socket.setEncoding('utf8');
  socket.setTimeout(${BRIDGE_SOCKET_TIMEOUT_MS}, () => {
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
}
`;

const BRIDGE_VERSION = 12;

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
