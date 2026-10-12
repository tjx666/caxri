import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';

import { atomicWrite } from '../../atomic-file';
import { WORKTREE_COMMAND_SOURCE } from './worktree-command';

const BRIDGE_RECEIPT_TIMEOUT_MS = 250;
const BRIDGE_SOCKET_TIMEOUT_MS = 2_000;
const BRIDGE_STDIN_TIMEOUT_MS = 250;
const BRIDGE_ATTENTION_TIMEOUT_MS = 125_000;
export const AGENT_HOOK_BRIDGE_MAX_DELIVERY_MS = BRIDGE_STDIN_TIMEOUT_MS + BRIDGE_SOCKET_TIMEOUT_MS;

/**
 * Hook payload keys that carry each provider's per-turn identity, in precedence order. Exhaustive on purpose: a newly
 * catalogued provider fails to compile until it declares its key, instead of silently being read with another
 * provider's. The table is serialized into the standalone bridge script, where a provider it does not name carries no
 * turn identity. Claude's documented per-prompt identity spans UserPromptSubmit, Stop, and StopFailure (v2.1.196+).
 * https://code.claude.com/docs/en/hooks#common-input-fields
 */
const HOOK_TURN_ID_KEYS: Record<AgentProvider, readonly string[]> = {
    claude: ['prompt_id'],
    codex: ['turn_id', 'turnId'],
    grok: ['promptId'],
};

const BRIDGE_SCRIPT = String.raw`'use strict';
const net = require('node:net');
const { createHash } = require('node:crypto');
// The shell wrapper maps these private exit codes to fixed diagnostics so runtime paths and arbitrary child stderr
// never escape the bridge boundary.
const exitCodes = {
  launchContextUnavailable: 10,
  socketTimeout: 11,
  socketUnavailable: 12,
  signalRejected: 13,
  ackUnavailable: 14,
  payloadScopeUnavailable: 15,
};
const args = new Map();
for (let index = 2; index < process.argv.length - 1; index += 2) {
  if (process.argv[index].startsWith('--')) args.set(process.argv[index].slice(2), process.argv[index + 1]);
}
// The schema version is not part of the installed hook command: the command is shared by every Caxri build on the
// machine, so it must stay identical across builds or they would rewrite each other's entries. Each Caxri instance
// tells the bridge which schema it expects through the launch environment, next to the socket that instance owns.
const provider = args.get('provider');
const interactive = args.get('interactive');
const turnIdKeys = new Map(${JSON.stringify(Object.entries(HOOK_TURN_ID_KEYS))}).get(provider) || [];
// Grok imports Claude hooks by default. Those inherited commands must not identify it as Claude Code.
if (process.env.GROK_SESSION_ID && provider !== 'grok') process.exit(0);
const schemaFromEnvironment = Number(process.env['CAXRI_HOOK_SCHEMA_' + String(provider).toUpperCase()]);
// A shell profile sourced after launch can overwrite the variable with anything; a non-numeric value must not turn
// every signal in the Terminal into an unexplained rejection.
const schemaVersion = Number.isFinite(schemaFromEnvironment) ? schemaFromEnvironment : 0;
const signal = {
  protocolVersion: 1,
  provider,
  phase: args.get('phase'),
  schemaVersion,
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
// Providers pipe a JSON payload on stdin. Only opaque session, turn, subagent, and tool identifiers, a bounded
// worktree-create classification, and the event's own absolute working directory are extracted, so commands, output,
// prompts, and responses never cross this boundary.
const MAX_CWD_LENGTH = 1024;
// The provider's own cwd for this event, not a tool argument. Server Core proves it against Git worktree topology
// before it becomes durable, so the bridge only enforces a bounded absolute path with no embedded NUL.
function readCwd(payload) {
  const cwd = payload && payload.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_CWD_LENGTH) return undefined;
  if (cwd[0] !== '/' || cwd.includes('\0')) return undefined;
  return cwd;
}
${WORKTREE_COMMAND_SOURCE}
function hasWorktreeCreateIntent(payload) {
  if (!['shellToolStarted', 'shellToolFinished', 'shellToolFailed'].includes(signal.phase)) return false;
  return commandCreatesWorktree(payload && payload.tool_input && payload.tool_input.command);
}
// Mirrors '??' across keys: the first present key wins even when its value is not a usable identifier.
function firstPresent(payload, keys) {
  if (payload === null || payload === undefined) return undefined;
  const key = keys.find((candidate) => payload[candidate] !== undefined && payload[candidate] !== null);
  return key === undefined ? undefined : payload[key];
}
function readIdentifiers(callback) {
  let source = '';
  let done = false;
  const captureDigests = ['claude', 'codex', 'grok'].includes(provider) && process.env.CAXRI_HOOK_DIGEST === '1';
  const sourceLimit = captureDigests ? 1048576 : 65536;
  let overflow = false;
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
    let cwd;
    let sessionId;
    let toolUseId;
    let turnId;
    let promptDigest;
    let responseDigest;
    let responseByteLength;
    let turnContinues;
    let failure;
    let worktreeCreateIntent = false;
    try {
      const payload = JSON.parse(source);
      const agentValue = payload && (payload.agent_id ?? payload.agentId ?? (provider === 'grok' ? (payload.subagentId ?? (payload.subagentType ? payload.sessionId : undefined)) : undefined));
      if (provider === 'grok') {
        // A shutdown Stop has no completed turn. Child/background activity cannot settle the main Session.
        if (agentValue) return callback({ ignored: true });
        if (signal.phase === 'sessionIdentified' && !['new', 'load'].includes(payload.source))
          return callback({ ignored: true });
        if (signal.phase === 'turnFinished' && !payload.promptId) return callback({ ignored: true });
        if (signal.phase === 'turnFinished' && (payload.reason !== 'end_turn' ||
            (Array.isArray(payload.backgroundTasks) && payload.backgroundTasks.length) ||
            (Array.isArray(payload.sessionCrons) && payload.sessionCrons.length))) {
          if (!captureDigests) return callback({ ignored: true });
          turnContinues = true;
        }
      }
      if (typeof agentValue === 'string' && agentValue.length > 0 && agentValue.length <= 256) agentId = agentValue;
      const value = payload && (payload.session_id ?? payload.sessionId);
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) sessionId = value;
      const turnValue = firstPresent(payload, turnIdKeys);
      if (typeof turnValue === 'string' && turnValue.length > 0 && turnValue.length <= 256) turnId = turnValue;
      const toolValue = payload && (payload.tool_use_id ?? payload.toolUseId);
      if (typeof toolValue === 'string' && toolValue.length > 0 && toolValue.length <= 256) toolUseId = toolValue;
      worktreeCreateIntent = hasWorktreeCreateIntent(payload);
      cwd = readCwd(payload);
      if (captureDigests && !agentId && !overflow) {
        if (['turnFinished', 'turnFailed'].includes(signal.phase) && payload.hook_event_name === 'StopFailure')
          failure = ['rate_limit', 'billing_error', 'authentication_failed', 'max_output_tokens'].includes(payload.error) ? payload.error : 'provider_failed';
        if (signal.phase === 'turnFailed' && provider === 'grok' && payload.hook_event_name === 'StopCancelled')
          failure = 'provider_failed';
        if (signal.phase === 'turnStarted' && typeof payload.prompt === 'string')
          promptDigest = createHash('sha256').update(payload.prompt).digest('hex');
        const response = provider === 'grok' ? payload.lastAssistantMessage : payload.last_assistant_message;
        if (signal.phase === 'turnFinished' && !failure && typeof response === 'string') {
          responseDigest = createHash('sha256').update(response).digest('hex');
          if (provider === 'grok') {
            responseByteLength = Buffer.byteLength(response);
            // Native Grok clips Stop text; a prefix hash cannot authenticate the omitted suffix.
            if (/… \[\+\d+ chars\]$/.test(response)) overflow = true;
          }
        }
      }
    } catch {
      // Grok writes native-child scope after event content. A truncated prefix cannot prove this is the main Agent.
      if (provider === 'grok') { process.exitCode = exitCodes.payloadScopeUnavailable; return; }
      // Common hook fields precede event-specific tool input/results. A large payload is intentionally truncated, but
      // these bounded opaque identifiers remain recoverable without retaining or parsing provider content. The cwd is
      // deliberately not recovered here: its character class overlaps provider content, and every later hook event
      // carries it again, so a truncated payload costs at most one event of latency.
      agentId = prefixString(['agent_id', 'agentId']);
      sessionId = prefixString(['session_id', 'sessionId']);
      turnId = prefixString(turnIdKeys);
    }
    const responseStop = captureDigests && provider === 'grok' && signal.phase === 'turnFinished';
    callback({ agentId, cwd, sessionId, toolUseId, turnId, worktreeCreateIntent, promptDigest, responseDigest, responseByteLength, responseStop, turnContinues, failure, overflow: captureDigests && overflow });
  };
  // Stdin may be an interactive TTY when a human runs the bridge by hand; never wait on it.
  const timer = setTimeout(finish, ${BRIDGE_STDIN_TIMEOUT_MS});
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    source += chunk;
    // Ordinary hooks keep their existing UTF-16 budget; UTF-8 accounting is specific to opt-in task digests.
    const sourceSize = captureDigests ? Buffer.byteLength(source, 'utf8') : source.length;
    if (sourceSize > sourceLimit) { overflow = true; source = source.slice(0, 65536); clearTimeout(timer); finish(); }
  });
  process.stdin.on('end', () => { clearTimeout(timer); finish(); });
  process.stdin.on('error', () => { clearTimeout(timer); finish(); });
}
// Only Claude's two answerable hooks use this longer channel. Keep full question input in this process so the Server
// receives only bounded display fields; the original questions are echoed back to Claude with the user's answers.
function readAttention(callback) {
  let source = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      const payload = JSON.parse(source);
      const toolName = String(payload.tool_name || '').slice(0, 100);
      const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
      const summary = String(toolInput.command || toolInput.file_path || toolInput.path || '').slice(0, 500);
      const questions = interactive === 'question' && Array.isArray(toolInput.questions)
        ? toolInput.questions.slice(0, 4).map(q => ({
            question: String(q.question || '').slice(0, 500),
            header: String(q.header || '').slice(0, 100),
            multiSelect: q.multiSelect === true,
            options: Array.isArray(q.options) ? q.options.slice(0, 8).map(o => ({
              label: String(o.label || '').slice(0, 100),
              description: typeof o.description === 'string' ? o.description.slice(0, 250) : undefined,
            })) : [],
          })) : [];
      if (interactive === 'question' && (
        !Array.isArray(toolInput.questions) || toolInput.questions.length !== questions.length ||
        new Set(questions.map(q => q.question)).size !== questions.length ||
        questions.some(q => !q.question)
      )) return callback(null);
      callback({ toolName, summary, questions, originalQuestions: toolInput.questions });
    } catch { callback(null); }
  };
  const timer = setTimeout(finish, 1000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    source += chunk;
    if (source.length > 65536) { clearTimeout(timer); callback(null); done = true; }
  });
  process.stdin.on('end', () => { clearTimeout(timer); finish(); });
  process.stdin.on('error', () => { clearTimeout(timer); finish(); });
}
function sendAttention(input) {
  if (!input || !hasLaunchContext) return;
  const socket = net.createConnection(socketPath);
  let response = '';
  socket.setEncoding('utf8');
  socket.setTimeout(${BRIDGE_ATTENTION_TIMEOUT_MS}, () => socket.destroy());
  socket.on('connect', () => socket.end(JSON.stringify({
    ...signal,
    kind: 'attention',
    attentionKind: interactive,
    toolName: input.toolName,
    summary: input.summary,
    questions: input.questions,
  })));
  socket.on('data', chunk => { response += chunk; if (response.length > 8192) socket.destroy(); });
  socket.on('end', () => {
    try {
      const answer = JSON.parse(response);
      if (!answer.ok) return;
      if (interactive === 'permission' && ['allow', 'deny'].includes(answer.decision)) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: {
          hookEventName: 'PermissionRequest', decision: { behavior: answer.decision },
        } }) + '\n');
      } else if (interactive === 'question' && answer.answers && Array.isArray(input.originalQuestions)) {
        const originalAnswers = {};
        for (let index = 0; index < input.questions.length; index += 1) {
          const displayQuestion = input.questions[index].question;
          const originalQuestion = input.originalQuestions[index].question;
          if (typeof originalQuestion !== 'string' || typeof answer.answers[displayQuestion] !== 'string') return;
          originalAnswers[originalQuestion] = answer.answers[displayQuestion];
        }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'allow',
          updatedInput: { questions: input.originalQuestions, answers: originalAnswers },
        } }) + '\n');
      }
    } catch { /* No answer leaves Claude's native prompt available. */ }
  });
  socket.on('error', () => {});
}
if (!hasAnyLaunchContext) {
  process.exitCode = 0;
} else if (!hasLaunchContext) {
  process.exitCode = exitCodes.launchContextUnavailable;
} else if (interactive && provider === 'claude') {
  readAttention(sendAttention);
} else {
if (process.env.CAXRI_HOOK_RECEIPTS === '1') reportBridgeStarted();
readIdentifiers(({ agentId, cwd, sessionId, toolUseId, turnId, worktreeCreateIntent, promptDigest, responseDigest, responseByteLength, responseStop, turnContinues, failure, overflow, ignored }) => {
  if (ignored) { process.stdin.pause(); return; }
  if (agentId) signal.agentId = agentId;
  if (cwd) signal.agentCwd = cwd;
  if (sessionId) signal.agentSessionId = sessionId;
  // The shared bridge also serves older live Servers, whose attention packets do not accept tool IDs.
  if (toolUseId && (worktreeCreateIntent || (provider === 'codex' && schemaVersion >= 9 && ['attentionRequested', 'attentionResolved'].includes(signal.phase)))) signal.agentToolUseId = toolUseId;
  if (turnId) signal.agentTurnId = turnId;
  if (promptDigest) signal.agentPromptDigest = promptDigest;
  if (responseDigest) signal.agentResponseDigest = responseDigest;
  if (responseByteLength !== undefined) signal.agentResponseByteLength = responseByteLength;
  if (responseStop) signal.agentResponseStop = true;
  if (failure) signal.agentFailure = failure;
  if (overflow) signal.agentContentOverflow = true;
  if (turnContinues) signal.agentTurnContinues = true;
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

/**
 * Bump on every bridge script change, including a behavior-preserving one: same-version builds sharing the staged
 * bridge would otherwise keep rewriting each other's copy.
 */
const BRIDGE_VERSION = 23;

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
  case " $* " in
    *" --interactive "*) ELECTRON_RUN_AS_NODE=1 "$CAXRI_HOOK_RUNTIME" "$bridge_dir/bridge.cjs" "$@" 2>/dev/null ;;
    *) ELECTRON_RUN_AS_NODE=1 "$CAXRI_HOOK_RUNTIME" "$bridge_dir/bridge.cjs" "$@" >/dev/null 2>&1 ;;
  esac
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
    15) printf 'caxri-hook: payload_scope_unavailable\n' >&2 ;;
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
