import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, opendir, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds, mobileAttentionQuestionSchema } from '@caxri/protocol';
import { ensureUnixSocketDirectory } from '@caxri/system';

import { isOpaqueAgentSessionId } from '../contract';
import type {
    AgentLifecyclePhase,
    AgentLifecycleSignal,
    AgentSignalIgnoredReason,
} from './contract';
import { agentLifecyclePhases } from './contract';

const MAX_SIGNAL_BYTES = 4_096;
const MAX_ATTENTION_BYTES = 64 * 1_024;
const MAX_PHASE_LENGTH = 64;
const MAX_AGENT_CWD_LENGTH = 1_024;
const MAX_AGENT_ID_LENGTH = 256;
const MAX_AGENT_SESSION_ID_LENGTH = 256;
const MAX_AGENT_TOOL_USE_ID_LENGTH = 256;
const MAX_AGENT_TURN_ID_LENGTH = 256;
const SHELL_TOOL_PHASES = new Set<AgentLifecyclePhase>([
    'shellToolStarted',
    'shellToolFinished',
    'shellToolFailed',
]);
/**
 * Bounds the sweep by profile-owned candidates rather than by position in the directory. The previous bound counted
 * every entry in the temp directory and stopped at 4096, which made reclamation depend on where the socket happened to
 * land among unrelated files: a routine macOS `$TMPDIR` already holds several thousand entries, so a crashed Server's
 * socket could survive indefinitely while the sweep reported success. Matching the profile prefix is a cheap string
 * compare, and only the profile itself can grow the matching set, so capping that set keeps the expensive `lstat`/`rm`
 * work bounded without letting foreign churn starve the sweep.
 */
const MAX_PROFILE_SOCKET_CANDIDATES = 512;
const MAX_STALE_SOCKET_REMOVALS = 64;

interface RegisteredLaunch {
    launchId: string;
    provider?: AgentProvider;
    terminalId: string;
}

interface HookWireAuth {
    launchId: string;
    provider: AgentProvider;
    schemaVersion: number;
    terminalId: string;
    token: string;
}

interface HookWireContext extends HookWireAuth {
    phase: AgentLifecyclePhase;
    protocolVersion: number;
}

interface HookWireSignal extends AgentLifecycleSignal, HookWireContext {
    kind?: undefined;
}

interface HookWireBridgeStarted extends HookWireContext {
    kind: 'bridgeStarted';
}

export interface HookWireAttention extends HookWireContext {
    kind: 'attention';
    attentionKind: 'permission' | 'question';
    toolName: string;
    summary: string;
    questions: Array<{
        question: string;
        header: string;
        multiSelect: boolean;
        options: Array<{ label: string; description?: string }>;
    }>;
}

type HookWirePacket = HookWireBridgeStarted | HookWireSignal | HookWireAttention;

export type AgentHookSignalRejectionReason =
    | 'downstreamRejected'
    | 'invalidAgentCwd'
    | 'invalidAgentId'
    | 'invalidAgentSessionId'
    | 'invalidAgentToolUseId'
    | 'invalidAgentTurnId'
    | 'invalidAgentDigest'
    | 'invalidJson'
    | 'invalidSignal'
    | 'launchMismatch'
    | 'payloadTooLarge'
    | 'providerMismatch'
    | 'schemaMismatch'
    | 'terminalMismatch'
    | 'transportError'
    | 'transportTimeout'
    | 'unknownToken';

/**
 * Outcome of applying one authenticated signal downstream. An ignored signal always names its reason: an unexplained
 * drop reads identically to a lost hook in the log, which is the failure this contract exists to prevent.
 */
export type AgentHookSignalResult =
    | { disposition: 'accepted' | 'rejected' }
    | { disposition: 'ignored'; reason: AgentSignalIgnoredReason };

/**
 * Existence-only detail about the identifiers a signal carried. The values themselves stay on the provider's side of
 * the boundary; only whether they were present crosses into diagnostics.
 */
interface AgentHookSignalPresence {
    hasAgentCwd?: boolean;
    hasAgentSessionId?: boolean;
    hasAgentTurnId?: boolean;
    worktreeCreateIntent?: boolean;
}

export type AgentHookSignalDiagnostic =
    | {
          outcome: 'started';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          terminalId: string;
      }
    | (AgentHookSignalPresence & {
          /**
           * Server-side handling cost for this signal, from the first received byte to the settled disposition. The
           * bridge abandons the connection after its own 2s socket timeout, so this is the measurement that says how
           * much headroom is left before signals start being lost to that timeout.
           */
          handlingMs?: number;
          outcome: 'accepted';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          terminalId: string;
      })
    | (AgentHookSignalPresence & {
          handlingMs?: number;
          outcome: 'ignored';
          phase?: AgentLifecyclePhase;
          provider: AgentProvider;
          reason: AgentSignalIgnoredReason;
          /**
           * Bounded wire token when `reason` is `unknownPhase`. Never used as a metric label.
           */
          receivedPhase?: string;
          terminalId: string;
      })
    | (AgentHookSignalPresence & {
          handlingMs?: number;
          outcome: 'rejected';
          phase?: AgentLifecyclePhase;
          provider?: AgentProvider;
          reason: AgentHookSignalRejectionReason;
          receivedPhase?: string;
          terminalId?: string;
      });

function isProvider(value: unknown): value is AgentProvider {
    return typeof value === 'string' && agentProviderIds.includes(value as AgentProvider);
}

function isPhase(value: unknown): value is AgentLifecyclePhase {
    return typeof value === 'string' && agentLifecyclePhases.includes(value as AgentLifecyclePhase);
}

function fileSystemErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function isProcessAlive(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        return !['EINVAL', 'ESRCH'].includes(fileSystemErrorCode(error) ?? '');
    }
}

/**
 * Removes only bounded, profile-owned socket entries whose encoded Server PID no longer exists. A crash bypasses
 * `close()`, while a live sibling Server for the same profile must stay intact.
 */
export async function pruneStaleAgentHookSockets(
    directoryPath: string,
    profileId: string,
    currentProcessId = process.pid,
    /**
     * Overrides the candidate cap so a test can prove the bound counts profile-owned sockets rather than directory
     * position. Production always uses {@link MAX_PROFILE_SOCKET_CANDIDATES}.
     */
    maxCandidates = MAX_PROFILE_SOCKET_CANDIDATES,
): Promise<void> {
    const prefix = `caxri-hooks-${profileId}-`;
    let candidates = 0;
    let removed = 0;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
        if (candidates >= maxCandidates || removed >= MAX_STALE_SOCKET_REMOVALS) break;
        if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.sock')) continue;
        candidates += 1;
        const encodedProcessId = entry.name.slice(prefix.length, -'.sock'.length);
        if (!/^\d+$/.test(encodedProcessId)) continue;
        const processId = Number(encodedProcessId);
        if (processId === currentProcessId || isProcessAlive(processId)) continue;
        const path = join(directoryPath, entry.name);
        try {
            if ((await lstat(path)).isSocket()) {
                await rm(path, { force: true });
                removed += 1;
            }
        } catch (error) {
            if (fileSystemErrorCode(error) !== 'ENOENT') throw error;
        }
    }
}

function parsePacket(
    source: string,
):
    | { packet: HookWirePacket }
    | { reason: AgentHookSignalRejectionReason }
    | { context: HookWireAuth & AgentHookSignalPresence; unknownPhase: string } {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return { reason: 'invalidJson' };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { reason: 'invalidSignal' };
    const signal = value as Record<string, unknown>;
    if (
        signal.protocolVersion !== 1 ||
        typeof signal.schemaVersion !== 'number' ||
        typeof signal.launchId !== 'string' ||
        typeof signal.terminalId !== 'string' ||
        typeof signal.token !== 'string' ||
        !isProvider(signal.provider) ||
        typeof signal.phase !== 'string' ||
        signal.phase.length === 0 ||
        signal.phase.length > MAX_PHASE_LENGTH
    ) {
        return { reason: 'invalidSignal' };
    }
    if (!isPhase(signal.phase)) {
        if (signal.kind !== undefined) return { reason: 'invalidSignal' };
        if (
            signal.agentId !== undefined &&
            (typeof signal.agentId !== 'string' ||
                signal.agentId.length > MAX_AGENT_ID_LENGTH ||
                !isOpaqueAgentSessionId(signal.agentId))
        ) {
            return { reason: 'invalidAgentId' };
        }
        if (
            signal.agentSessionId !== undefined &&
            (typeof signal.agentSessionId !== 'string' ||
                signal.agentSessionId.length > MAX_AGENT_SESSION_ID_LENGTH ||
                !isOpaqueAgentSessionId(signal.agentSessionId))
        ) {
            return { reason: 'invalidAgentSessionId' };
        }
        if (
            signal.agentTurnId !== undefined &&
            (typeof signal.agentTurnId !== 'string' ||
                signal.agentTurnId.length > MAX_AGENT_TURN_ID_LENGTH ||
                !isOpaqueAgentSessionId(signal.agentTurnId))
        ) {
            return { reason: 'invalidAgentTurnId' };
        }
        if (
            signal.agentCwd !== undefined &&
            (typeof signal.agentCwd !== 'string' ||
                signal.agentCwd.length === 0 ||
                signal.agentCwd.length > MAX_AGENT_CWD_LENGTH ||
                !signal.agentCwd.startsWith('/') ||
                signal.agentCwd.includes('\0'))
        ) {
            return { reason: 'invalidAgentCwd' };
        }
        if (signal.agentToolUseId !== undefined) return { reason: 'invalidAgentToolUseId' };
        if (signal.worktreeCreateIntent !== undefined) return { reason: 'invalidSignal' };
        if (
            signal.agentPromptDigest !== undefined ||
            signal.agentResponseDigest !== undefined ||
            signal.agentContentOverflow !== undefined ||
            signal.agentResponseByteLength !== undefined ||
            signal.agentFailure !== undefined ||
            signal.agentResponseStop !== undefined ||
            signal.agentTurnContinues !== undefined
        ) {
            return { reason: 'invalidAgentDigest' };
        }
        return {
            unknownPhase: signal.phase,
            context: {
                launchId: signal.launchId,
                provider: signal.provider,
                schemaVersion: signal.schemaVersion,
                terminalId: signal.terminalId,
                token: signal.token,
                hasAgentCwd: signal.agentCwd !== undefined,
                hasAgentSessionId: signal.agentSessionId !== undefined,
                hasAgentTurnId: signal.agentTurnId !== undefined,
            },
        };
    }
    if (signal.kind === 'attention') {
        if (
            signal.provider !== 'claude' ||
            signal.phase !== 'attentionRequested' ||
            !['permission', 'question'].includes(String(signal.attentionKind)) ||
            typeof signal.toolName !== 'string' ||
            signal.toolName.length > 100 ||
            typeof signal.summary !== 'string' ||
            signal.summary.length > 500 ||
            !mobileAttentionQuestionSchema.array().max(4).safeParse(signal.questions).success ||
            (signal.attentionKind === 'question' &&
                (!Array.isArray(signal.questions) || signal.questions.length === 0))
        )
            return { reason: 'invalidSignal' };
        return { packet: signal as unknown as HookWireAttention };
    }
    if (signal.kind === 'bridgeStarted')
        return { packet: signal as unknown as HookWireBridgeStarted };
    if (signal.kind !== undefined) return { reason: 'invalidSignal' };
    if (
        signal.agentId !== undefined &&
        (typeof signal.agentId !== 'string' ||
            signal.agentId.length > MAX_AGENT_ID_LENGTH ||
            !isOpaqueAgentSessionId(signal.agentId))
    ) {
        return { reason: 'invalidAgentId' };
    }
    if (
        signal.agentSessionId !== undefined &&
        (typeof signal.agentSessionId !== 'string' ||
            signal.agentSessionId.length > MAX_AGENT_SESSION_ID_LENGTH ||
            !isOpaqueAgentSessionId(signal.agentSessionId))
    ) {
        return { reason: 'invalidAgentSessionId' };
    }
    if (
        signal.agentTurnId !== undefined &&
        (typeof signal.agentTurnId !== 'string' ||
            signal.agentTurnId.length > MAX_AGENT_TURN_ID_LENGTH ||
            !isOpaqueAgentSessionId(signal.agentTurnId))
    ) {
        return { reason: 'invalidAgentTurnId' };
    }
    if (
        signal.agentToolUseId !== undefined &&
        (typeof signal.agentToolUseId !== 'string' ||
            signal.agentToolUseId.length > MAX_AGENT_TOOL_USE_ID_LENGTH ||
            !isOpaqueAgentSessionId(signal.agentToolUseId) ||
            !SHELL_TOOL_PHASES.has(signal.phase))
    ) {
        return { reason: 'invalidAgentToolUseId' };
    }
    for (const [field, phase] of [
        ['agentPromptDigest', 'turnStarted'],
        ['agentResponseDigest', 'turnFinished'],
    ] as const) {
        const digest = signal[field];
        if (
            digest !== undefined &&
            (typeof digest !== 'string' ||
                !/^[a-f0-9]{64}$/u.test(digest) ||
                signal.phase !== phase ||
                signal.agentId !== undefined)
        )
            return { reason: 'invalidAgentDigest' };
    }
    if (signal.agentContentOverflow !== undefined && signal.agentContentOverflow !== true)
        return { reason: 'invalidAgentDigest' };
    if (
        signal.agentResponseByteLength !== undefined &&
        (signal.provider !== 'grok' ||
            signal.phase !== 'turnFinished' ||
            signal.agentId !== undefined ||
            typeof signal.agentResponseByteLength !== 'number' ||
            !Number.isSafeInteger(signal.agentResponseByteLength) ||
            signal.agentResponseByteLength < 0 ||
            signal.agentResponseByteLength > 1_048_576 ||
            !signal.agentResponseDigest)
    )
        return { reason: 'invalidAgentDigest' };
    if (
        signal.agentFailure !== undefined &&
        (typeof signal.agentFailure !== 'string' ||
            !['claude', 'grok'].includes(signal.provider) ||
            !['turnFinished', 'turnFailed'].includes(signal.phase) ||
            signal.agentId !== undefined ||
            ![
                'rate_limit',
                'billing_error',
                'authentication_failed',
                'max_output_tokens',
                'provider_failed',
            ].includes(signal.agentFailure))
    )
        return { reason: 'invalidAgentDigest' };
    if (
        signal.agentResponseStop !== undefined &&
        (signal.agentResponseStop !== true ||
            signal.provider !== 'grok' ||
            signal.phase !== 'turnFinished' ||
            signal.agentId !== undefined)
    )
        return { reason: 'invalidAgentDigest' };
    if (
        signal.agentTurnContinues !== undefined &&
        (signal.agentTurnContinues !== true ||
            signal.provider !== 'grok' ||
            signal.phase !== 'turnFinished' ||
            signal.agentId !== undefined)
    )
        return { reason: 'invalidAgentDigest' };
    /**
     * Shape-only validation. A path that clears this gate is still an unproven provider claim; it becomes durable state
     * only after `WorkbenchRootService.observeAgentCwd` matches it against real Git worktree topology.
     */
    if (
        signal.agentCwd !== undefined &&
        (typeof signal.agentCwd !== 'string' ||
            signal.agentCwd.length === 0 ||
            signal.agentCwd.length > MAX_AGENT_CWD_LENGTH ||
            !signal.agentCwd.startsWith('/') ||
            signal.agentCwd.includes('\0'))
    ) {
        return { reason: 'invalidAgentCwd' };
    }
    if (
        signal.worktreeCreateIntent !== undefined &&
        (signal.worktreeCreateIntent !== true || !SHELL_TOOL_PHASES.has(signal.phase))
    )
        return { reason: 'invalidSignal' };
    if ((signal.worktreeCreateIntent === true) !== (signal.agentToolUseId !== undefined))
        return { reason: 'invalidSignal' };
    return { packet: signal as unknown as HookWireSignal };
}

/**
 * Records only whether each optional identifier was present. `agentCwd` and `worktreeCreateIntent` are what make the
 * worktree-following path observable at all, and both are existence-only here: the directory and the classified command
 * never reach diagnostics.
 */
function diagnosticFields(signal: HookWireSignal) {
    return {
        hasAgentCwd: signal.agentCwd !== undefined,
        hasAgentSessionId: signal.agentSessionId !== undefined,
        hasAgentTurnId: signal.agentTurnId !== undefined,
        phase: signal.phase,
        provider: signal.provider,
        terminalId: signal.terminalId,
        worktreeCreateIntent: signal.worktreeCreateIntent === true,
    };
}

function packetDiagnosticFields(packet: HookWirePacket) {
    return {
        ...(packet.kind === undefined && {
            hasAgentSessionId: packet.agentSessionId !== undefined,
        }),
        phase: packet.phase,
        provider: packet.provider,
        terminalId: packet.terminalId,
    };
}

/**
 * Authenticated local signal boundary. Provider hooks can report only a phase, opaque PTY generation, bounded opaque
 * provider identifiers, a worktree-create classification, and the event's own bounded absolute working directory;
 * prompt text, tool arguments, tool results, and provider hook payloads never cross into Caxri.
 */
export class AgentHookServer {
    private readonly launchesByToken = new Map<string, RegisteredLaunch>();
    private server?: Server;

    constructor(
        readonly socketPath: string,
        private readonly schemaVersions: Readonly<Record<AgentProvider, number>>,
        /**
         * Separates an irrelevant authenticated signal from a downstream processing failure.
         */
        private readonly onSignal: (
            signal: AgentLifecycleSignal,
        ) => AgentHookSignalResult | Promise<AgentHookSignalResult>,
        private readonly onDiagnostic: (diagnostic: AgentHookSignalDiagnostic) => void = () => {},
        private readonly onAttention: (
            request: HookWireAttention,
            signal: AbortSignal,
        ) => Promise<{
            decision?: 'allow' | 'deny';
            answers?: Record<string, string>;
        } | null> = () => Promise.resolve(null),
    ) {}

    private accept(socket: Socket): void {
        socket.setEncoding('utf8');
        let source = '';
        let isSettled = false;
        let receivedAt: number | undefined;
        const attentionAbort = new AbortController();
        const didSettle = (diagnostic: AgentHookSignalDiagnostic): boolean => {
            if (isSettled) return false;
            isSettled = true;
            this.onDiagnostic(
                receivedAt === undefined || diagnostic.outcome === 'started'
                    ? diagnostic
                    : { ...diagnostic, handlingMs: performance.now() - receivedAt },
            );
            return true;
        };
        socket.setTimeout(2_500, () => {
            didSettle({ outcome: 'rejected', reason: 'transportTimeout' });
            socket.destroy();
        });
        socket.on('data', (chunk: string) => {
            if (isSettled) return;
            receivedAt ??= performance.now();
            source += chunk;
            if (
                Buffer.byteLength(source, 'utf8') >
                (source.includes('"kind":"attention"') ? MAX_ATTENTION_BYTES : MAX_SIGNAL_BYTES)
            ) {
                didSettle({ outcome: 'rejected', reason: 'payloadTooLarge' });
                socket.destroy();
            }
        });
        socket.on('end', async () => {
            if (isSettled) return;
            const parsed = parsePacket(source);
            if ('reason' in parsed) {
                didSettle({ outcome: 'rejected', reason: parsed.reason });
                socket.end('{"ok":false}\n');
                return;
            }
            if ('unknownPhase' in parsed) {
                const authorization = this.authorizationOutcome(parsed.context);
                const presence = {
                    hasAgentCwd: parsed.context.hasAgentCwd,
                    hasAgentSessionId: parsed.context.hasAgentSessionId,
                    hasAgentTurnId: parsed.context.hasAgentTurnId,
                    provider: parsed.context.provider,
                    receivedPhase: parsed.unknownPhase,
                    terminalId: parsed.context.terminalId,
                };
                if (authorization?.disposition === 'rejected') {
                    didSettle({
                        ...presence,
                        outcome: 'rejected',
                        reason: authorization.reason,
                    });
                    socket.end('{"ok":false}\n');
                    return;
                }
                didSettle({
                    ...presence,
                    outcome: 'ignored',
                    reason: authorization?.reason ?? 'unknownPhase',
                });
                socket.end('{"ok":true,"ignored":true}\n');
                return;
            }
            const { packet } = parsed;
            const authorization = this.authorizationOutcome(packet);
            if (authorization?.disposition === 'rejected') {
                didSettle({
                    ...packetDiagnosticFields(packet),
                    outcome: 'rejected',
                    reason: authorization.reason,
                });
                socket.end('{"ok":false}\n');
                return;
            }
            if (authorization?.disposition === 'ignored') {
                didSettle({
                    ...packetDiagnosticFields(packet),
                    outcome: 'ignored',
                    reason: authorization.reason,
                });
                // A benign nested-CLI signal still needs an "ok" reply so the bridge exits 0 instead of printing
                // "caxri-hook: signal_rejected" to the nested CLI's stderr for a mismatch that is not a security
                // problem (see the JSDoc on authorizationOutcome).
                socket.end('{"ok":true,"ignored":true}\n');
                return;
            }
            if (packet.kind === 'bridgeStarted') {
                didSettle({ ...packetDiagnosticFields(packet), outcome: 'started' });
                socket.end('{"ok":true}\n');
                return;
            }
            if (packet.kind === 'attention') {
                socket.setTimeout(125_000);
                try {
                    const answer = await this.onAttention(packet, attentionAbort.signal);
                    didSettle({ ...packetDiagnosticFields(packet), outcome: 'accepted' });
                    socket.end(`${JSON.stringify({ ok: Boolean(answer), ...answer })}\n`);
                } catch {
                    didSettle({
                        ...packetDiagnosticFields(packet),
                        outcome: 'rejected',
                        reason: 'downstreamRejected',
                    });
                    socket.end('{"ok":false}\n');
                }
                return;
            }
            const signal = packet;
            let result: AgentHookSignalResult;
            try {
                result = await this.onSignal(signal);
            } catch {
                result = { disposition: 'rejected' };
            }
            if (
                !didSettle(
                    result.disposition === 'rejected'
                        ? {
                              ...diagnosticFields(signal),
                              outcome: 'rejected',
                              reason: 'downstreamRejected',
                          }
                        : result.disposition === 'ignored'
                          ? {
                                ...diagnosticFields(signal),
                                outcome: 'ignored',
                                reason: result.reason,
                            }
                          : { ...diagnosticFields(signal), outcome: 'accepted' },
                )
            )
                return;
            socket.end(
                result.disposition === 'accepted'
                    ? '{"ok":true}\n'
                    : result.disposition === 'ignored'
                      ? '{"ok":true,"ignored":true}\n'
                      : '{"ok":false}\n',
            );
        });
        socket.on('error', () => {
            attentionAbort.abort();
            didSettle({ outcome: 'rejected', reason: 'transportError' });
        });
        socket.on('close', () => attentionAbort.abort());
    }

    /**
     * Classifies an authenticated-token signal as fully authorized (`undefined`), benign but not actionable
     * (`'ignored'`), or a genuine security or protocol problem (`'rejected'`).
     *
     * `providerMismatch` is `'ignored'` rather than `'rejected'`: a Terminal running provider A's CLI can spawn
     * provider B's CLI as a nested subprocess (for example, Claude Code shelling out to `codex`), and the
     * `CAXRI_HOOK_*` environment is inherited by that child process, so the nested CLI's own hook fires with the parent
     * Terminal's token but its own provider id. That is not a forged or malicious signal, so it should not be logged or
     * surfaced as a rejection, and the bridge must still see an `"ok"` reply so the nested CLI's hook script does not
     * print `caxri-hook: signal_rejected` to stderr for something benign.
     *
     * `schemaMismatch` only rejects a signal whose `schemaVersion` is _newer_ than this server build expects. The
     * bridge learns the schema from the `CAXRI_HOOK_SCHEMA_*` launch environment of the Terminal that ran it, and that
     * environment came from this very instance, so a mismatch is not a routine multi-build situation any more (issue
     * #557 moved the schema out of the shared provider file for exactly that reason). It remains a bound rather than an
     * equality check because the token, not the schema, authenticates the launch: schema bumps to date have been
     * additive (see `git show b3f718b5`), and a genuinely breaking wire change must bump `protocolVersion` instead of
     * relying on schema rejection to gate compatibility.
     */
    private authorizationOutcome(
        signal: HookWireAuth,
    ):
        | { disposition: 'ignored'; reason: 'providerMismatch' }
        | { disposition: 'rejected'; reason: AgentHookSignalRejectionReason }
        | undefined {
        const launch = this.launchesByToken.get(signal.token);
        if (!launch) return { disposition: 'rejected', reason: 'unknownToken' };
        if (launch.launchId !== signal.launchId)
            return { disposition: 'rejected', reason: 'launchMismatch' };
        if (launch.terminalId !== signal.terminalId)
            return { disposition: 'rejected', reason: 'terminalMismatch' };
        if (launch.provider && launch.provider !== signal.provider)
            return { disposition: 'ignored', reason: 'providerMismatch' };
        if (signal.schemaVersion > this.schemaVersions[signal.provider])
            return { disposition: 'rejected', reason: 'schemaMismatch' };
        return undefined;
    }

    async start(): Promise<void> {
        if (this.server) return;
        await ensureUnixSocketDirectory(this.socketPath);
        await rm(this.socketPath, { force: true });
        // Async PreToolUse provenance must finish before the acknowledgement, so keep the writable half open after the
        // bridge finishes sending its payload. Every accept path explicitly ends or destroys the socket.
        const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                function onError(error: Error) {
                    server.off('listening', onListening);
                    reject(error);
                }
                function onListening() {
                    server.off('error', onError);
                    resolve();
                }
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.socketPath);
            });
            await chmod(this.socketPath, 0o600);
        } catch (error) {
            this.server = undefined;
            if (server.listening)
                await new Promise<void>((resolve) => {
                    server.close(() => resolve());
                });
            await rm(this.socketPath, { force: true });
            throw error;
        }
    }

    register(terminalId: string, launchId: string, provider?: AgentProvider): string {
        const token = randomBytes(32).toString('hex');
        this.launchesByToken.set(token, { launchId, provider, terminalId });
        return token;
    }

    unregister(token: string): void {
        this.launchesByToken.delete(token);
    }

    async close(): Promise<void> {
        this.launchesByToken.clear();
        const server = this.server;
        this.server = undefined;
        if (server?.listening)
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        await rm(this.socketPath, { force: true });
    }
}
