import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, opendir, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

import { isOpaqueAgentSessionId } from '../contract';
import type { AgentLifecyclePhase, AgentLifecycleSignal } from './contract';
import { agentLifecyclePhases } from './contract';

const MAX_SIGNAL_BYTES = 4_096;
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
 * land among unrelated files — a routine macOS `$TMPDIR` already holds several thousand entries, so a crashed Server's
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

interface HookWireContext {
    launchId: string;
    phase: AgentLifecyclePhase;
    protocolVersion: number;
    provider: AgentProvider;
    schemaVersion: number;
    terminalId: string;
    token: string;
}

interface HookWireSignal extends AgentLifecycleSignal, HookWireContext {
    kind?: undefined;
}

interface HookWireBridgeStarted extends HookWireContext {
    kind: 'bridgeStarted';
}

type HookWirePacket = HookWireBridgeStarted | HookWireSignal;

export type AgentHookSignalRejectionReason =
    | 'downstreamRejected'
    | 'invalidAgentId'
    | 'invalidAgentSessionId'
    | 'invalidAgentToolUseId'
    | 'invalidAgentTurnId'
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

export type AgentHookSignalDisposition = 'accepted' | 'ignored' | 'rejected';

export type AgentHookSignalDiagnostic =
    | {
          outcome: 'started';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          terminalId: string;
      }
    | {
          hasAgentSessionId?: boolean;
          outcome: 'accepted' | 'ignored';
          phase: AgentLifecyclePhase;
          provider: AgentProvider;
          /**
           * Present only when the disposition is `'ignored'` because of a benign provider mismatch (see
           * {@link AgentHookServer.authorizationOutcome}); the ordinary downstream-ignored path never sets it.
           */
          reason?: 'providerMismatch';
          terminalId: string;
      }
    | {
          hasAgentSessionId?: boolean;
          outcome: 'rejected';
          phase?: AgentLifecyclePhase;
          provider?: AgentProvider;
          reason: AgentHookSignalRejectionReason;
          terminalId?: string;
      };

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
): { packet: HookWirePacket } | { reason: AgentHookSignalRejectionReason } {
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
        !isPhase(signal.phase)
    ) {
        return { reason: 'invalidSignal' };
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
    if (
        signal.worktreeCreateIntent !== undefined &&
        (signal.worktreeCreateIntent !== true || !SHELL_TOOL_PHASES.has(signal.phase))
    )
        return { reason: 'invalidSignal' };
    if ((signal.worktreeCreateIntent === true) !== (signal.agentToolUseId !== undefined))
        return { reason: 'invalidSignal' };
    return { packet: signal as unknown as HookWireSignal };
}

function diagnosticFields(signal: HookWireSignal) {
    return {
        hasAgentSessionId: signal.agentSessionId !== undefined,
        phase: signal.phase,
        provider: signal.provider,
        terminalId: signal.terminalId,
    };
}

function packetDiagnosticFields(packet: HookWirePacket) {
    return {
        ...(packet.kind !== 'bridgeStarted' && {
            hasAgentSessionId: packet.agentSessionId !== undefined,
        }),
        phase: packet.phase,
        provider: packet.provider,
        terminalId: packet.terminalId,
    };
}

/**
 * Authenticated local signal boundary. Provider hooks can report only a phase, opaque PTY generation, bounded opaque
 * provider identifiers, and a worktree-create classification; prompt text, tool arguments, tool results, and provider
 * hook payloads never cross into Caxri.
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
        ) => AgentHookSignalDisposition | Promise<AgentHookSignalDisposition>,
        private readonly onDiagnostic: (diagnostic: AgentHookSignalDiagnostic) => void = () => {},
    ) {}

    private accept(socket: Socket): void {
        socket.setEncoding('utf8');
        let source = '';
        let isSettled = false;
        const didSettle = (diagnostic: AgentHookSignalDiagnostic): boolean => {
            if (isSettled) return false;
            isSettled = true;
            this.onDiagnostic(diagnostic);
            return true;
        };
        socket.setTimeout(2_500, () => {
            didSettle({ outcome: 'rejected', reason: 'transportTimeout' });
            socket.destroy();
        });
        socket.on('data', (chunk: string) => {
            if (isSettled) return;
            source += chunk;
            if (Buffer.byteLength(source, 'utf8') > MAX_SIGNAL_BYTES) {
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
            const signal = packet;
            let disposition: AgentHookSignalDisposition;
            try {
                disposition = await this.onSignal(signal);
            } catch {
                disposition = 'rejected';
            }
            if (
                !didSettle(
                    disposition === 'rejected'
                        ? {
                              ...diagnosticFields(signal),
                              outcome: 'rejected',
                              reason: 'downstreamRejected',
                          }
                        : { ...diagnosticFields(signal), outcome: disposition },
                )
            )
                return;
            socket.end(
                disposition === 'accepted'
                    ? '{"ok":true}\n'
                    : disposition === 'ignored'
                      ? '{"ok":true,"ignored":true}\n'
                      : '{"ok":false}\n',
            );
        });
        socket.on('error', () => {
            didSettle({ outcome: 'rejected', reason: 'transportError' });
        });
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
     * `--schema N` literal is baked into the shared, global hook config (`~/.claude/settings.json` and Codex's
     * equivalent) by whichever locally installed Caxri build last wrote it, and every local build reads that same file.
     * An older running build must therefore keep accepting a signal that carries a schema number from a newer sibling
     * build, as long as the wire _shape_ of existing phases has not changed — schema bumps to date have been additive
     * (see `git show b3f718b5`). A genuinely breaking wire change must bump `protocolVersion` instead of relying on
     * schema rejection to gate compatibility.
     */
    private authorizationOutcome(
        signal: HookWireContext,
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
