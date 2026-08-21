import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, opendir, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '../../../shared/agents';
import { agentProviderIds } from '../../../shared/agents';
import { isOpaqueAgentSessionId } from '../contract';
import type { AgentLifecyclePhase, AgentLifecycleSignal } from './contract';
import { agentLifecyclePhases } from './contract';

const MAX_SIGNAL_BYTES = 4_096;
const MAX_AGENT_SESSION_ID_LENGTH = 256;
/**
 * Bounds the sweep by profile-owned candidates rather than by position in the directory. The previous bound counted
 * every entry in the temp directory and stopped at 4096, which made reclamation depend on where the socket happened to
 * land among unrelated files — a routine macOS `$TMPDIR` already holds several thousand entries, so a crashed Runtime's
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

interface HookWireSignal extends AgentLifecycleSignal {
    protocolVersion: number;
    schemaVersion: number;
    token: string;
}

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
 * Removes only bounded, profile-owned socket entries whose encoded Runtime PID no longer exists. A crash bypasses
 * `close()`, while a live sibling Runtime for the same profile must stay intact.
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

function parseSignal(source: string): HookWireSignal | undefined {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
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
        return undefined;
    }
    if (
        signal.agentSessionId !== undefined &&
        (typeof signal.agentSessionId !== 'string' ||
            signal.agentSessionId.length > MAX_AGENT_SESSION_ID_LENGTH ||
            !isOpaqueAgentSessionId(signal.agentSessionId))
    ) {
        return undefined;
    }
    return signal as unknown as HookWireSignal;
}

/**
 * Authenticated local signal boundary. Provider hooks can report only a phase, opaque PTY generation, and an opaque
 * provider session identifier; prompt text and provider hook payloads never cross into Caxri.
 */
export class AgentHookServer {
    private readonly launchesByToken = new Map<string, RegisteredLaunch>();
    private server?: Server;

    constructor(
        readonly socketPath: string,
        private readonly schemaVersions: Readonly<Record<AgentProvider, number>>,
        // `onSignal` names a callback property shared with `AgentHookManagerOptions.onSignal`
        // and `src/runtime/bootstrap.ts`; renaming only here would break that shared contract.
        // eslint-disable-next-line unicorn/consistent-boolean-name
        private readonly onSignal: (signal: AgentLifecycleSignal) => boolean,
    ) {}

    private accept(socket: Socket): void {
        socket.setEncoding('utf8');
        socket.setTimeout(1_000, () => socket.destroy());
        let source = '';
        socket.on('data', (chunk: string) => {
            source += chunk;
            if (Buffer.byteLength(source, 'utf8') > MAX_SIGNAL_BYTES) socket.destroy();
        });
        socket.on('end', () => {
            const signal = parseSignal(source);
            if (!signal || !this.authorize(signal)) {
                socket.end('{"ok":false}\n');
                return;
            }
            const isAccepted = this.onSignal(signal);
            socket.end(isAccepted ? '{"ok":true}\n' : '{"ok":false}\n');
        });
        socket.on('error', () => {});
    }

    private authorize(signal: HookWireSignal): boolean {
        const launch = this.launchesByToken.get(signal.token);
        return Boolean(
            launch &&
            launch.launchId === signal.launchId &&
            launch.terminalId === signal.terminalId &&
            (!launch.provider || launch.provider === signal.provider) &&
            this.schemaVersions[signal.provider] === signal.schemaVersion,
        );
    }

    async start(): Promise<void> {
        if (this.server) return;
        await rm(this.socketPath, { force: true });
        const server = createServer((socket) => this.accept(socket));
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
