import type { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, rm } from 'node:fs/promises';
import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import process from 'node:process';

import { ensureUnixSocketDirectory } from '@caxri/system';

import type {
    ManagedAgentLauncherClientMessage,
    ManagedAgentLauncherEnvironment,
    ManagedAgentLauncherEvent,
    ManagedAgentLauncherSignal,
    ManagedAgentLaunchPlan,
} from './protocol';
import {
    BoundedJsonLineDecoder,
    encodeJsonLine,
    MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES,
    MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES,
    parseManagedAgentLauncherClientMessage,
    validateManagedAgentLaunchPlan,
} from './protocol';

const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_MANAGED_AGENT_LAUNCHES = 64;

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
}

interface AgentInputHandoff {
    ready: Promise<void>;
    resumeAfterDrain(): void;
    closeOnLostDrain(): void;
}

interface ManagedLaunchState {
    terminalId: string;
    launchId: string;
    plan?: ManagedAgentLaunchPlan;
    tokenDigest?: Buffer;
    socket?: Socket;
    processId?: number;
    phase: 'prepared' | 'claimed' | 'started' | 'exited';
    started: Deferred<number>;
    completed: Deferred<void>;
    isCanceling: boolean;
    terminationSignal?: NodeJS.Signals;
    termination?: Promise<void>;
    phaseTimer?: NodeJS.Timeout;
    exitAckSent?: boolean;
    handoff?: AgentInputHandoff;
    handoffLost?: boolean;
    handoffComplete?: boolean;
}

export interface ManagedAgentLauncherServerOptions {
    socketPath: string;
    runtimePath: string;
    entryPath: string;
    onEvent?(event: ManagedAgentLauncherEvent): void;
    beforeExitAck?(terminalId: string): AgentInputHandoff;
    claimTimeoutMs?: number;
    terminationGraceMs?: number;
}

export interface PrepareManagedAgentLaunchInput {
    terminalId: string;
    launchId: string;
    plan: ManagedAgentLaunchPlan;
}

export interface PreparedManagedAgentLaunch {
    environment: ManagedAgentLauncherEnvironment;
    started: Promise<number>;
}

function deferred<T>(): Deferred<T> {
    const { promise, reject, resolve } = Promise.withResolvers<T>();
    return { promise, resolve, reject };
}

function launcherFailure(): Error {
    return new Error('Managed Agent launch ended before the Agent started');
}

function observeExpectedRejection(promise: Promise<unknown>): void {
    // eslint-disable-next-line unicorn/prefer-await -- The handler must attach synchronously without replacing the API promise.
    promise.then(undefined, () => {});
}

function tokenDigest(token: string): Buffer {
    return createHash('sha256').update(token, 'utf8').digest();
}

function isTokenMatch(expectedDigest: Buffer, received: string): boolean {
    return timingSafeEqual(expectedDigest, tokenDigest(received));
}

function wait(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, durationMs);
    });
}

/**
 * Owns one-use launch plans inside Terminal Host. Plans and tokens stay in memory and never enter events, errors, or
 * return values beyond the five environment entries required by the long-lived shell to invoke its private launcher.
 */
export class ManagedAgentLauncherServer {
    private readonly launches = new Map<string, ManagedLaunchState>();
    private readonly launchesByTerminal = new Map<string, ManagedLaunchState>();
    private readonly sockets = new Set<Socket>();
    private server?: Server;
    private isClosing = false;

    constructor(private readonly options: ManagedAgentLauncherServerOptions) {
        if (
            !isAbsolute(options.socketPath) ||
            !isAbsolute(options.runtimePath) ||
            !isAbsolute(options.entryPath)
        ) {
            throw new Error('Managed Agent launcher paths must be absolute');
        }
    }

    private claimTimeoutMs(): number {
        return this.options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    }

    private terminationGraceMs(): number {
        return this.options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    }

    private emit(event: ManagedAgentLauncherEvent): void {
        try {
            this.options.onEvent?.(event);
        } catch {
            // Lifecycle cleanup cannot depend on an observation callback.
        }
    }

    private removeState(state: ManagedLaunchState): void {
        if (state.phaseTimer) clearTimeout(state.phaseTimer);
        if (this.launches.get(state.launchId) === state) this.launches.delete(state.launchId);
        if (this.launchesByTerminal.get(state.terminalId) === state)
            this.launchesByTerminal.delete(state.terminalId);
        state.tokenDigest = undefined;
        state.plan = undefined;
        state.socket = undefined;
        state.processId = undefined;
        state.phaseTimer = undefined;
    }

    private armPhaseTimeout(state: ManagedLaunchState): void {
        if (state.phaseTimer) clearTimeout(state.phaseTimer);
        state.phaseTimer = setTimeout(() => {
            if (state.phase !== 'prepared' && state.phase !== 'claimed') return;
            this.finishWithoutClientExit(state);
        }, this.claimTimeoutMs());
    }

    private rejectBeforeStart(state: ManagedLaunchState): void {
        if (state.phase !== 'started' && state.phase !== 'exited')
            state.started.reject(launcherFailure());
    }

    private finishWithoutClientExit(state: ManagedLaunchState): void {
        if (state.phase === 'exited') {
            if (state.socket) this.failConnection(state, state.socket);
            return;
        }
        const socket = state.socket;
        this.rejectBeforeStart(state);
        if (state.phase === 'started' && state.processId) {
            this.emit({
                type: 'exited',
                terminalId: state.terminalId,
                launchId: state.launchId,
                exitCode: null,
                signal: state.terminationSignal ?? 'SIGHUP',
            });
        }
        state.phase = 'exited';
        state.completed.resolve();
        this.removeState(state);
        socket?.destroy();
    }

    private writeControl(
        state: ManagedLaunchState,
        message:
            | { type: 'cancel' }
            | { type: 'signal'; signal: ManagedAgentLauncherSignal }
            | { type: 'exitAck' },
    ): boolean {
        const socket = state.socket;
        if (!socket || socket.destroyed || !socket.writable) return false;
        try {
            socket.write(encodeJsonLine(message, MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES));
            return true;
        } catch {
            return false;
        }
    }

    private async waitForCompletion(state: ManagedLaunchState): Promise<boolean> {
        await Promise.race([state.completed.promise, wait(this.terminationGraceMs())]);
        return state.phase === 'exited' && this.launches.get(state.launchId) !== state;
    }

    private terminate(state: ManagedLaunchState): Promise<void> {
        if (state.termination) return state.termination;
        state.termination = this.terminateOwnedState(state);
        return state.termination;
    }

    private async terminateOwnedState(state: ManagedLaunchState): Promise<void> {
        state.isCanceling = true;
        state.tokenDigest = undefined;

        if (state.phase === 'prepared') {
            this.finishWithoutClientExit(state);
            return;
        }

        /**
         * The authenticated launcher owns the real ChildProcess handle and its termination escalation. This server must
         * not signal a cached PID because the OS may have reused it after an unobserved child exit.
         */
        this.writeControl(state, { type: 'cancel' });
        if (await this.waitForCompletion(state)) return;
        this.finishWithoutClientExit(state);
    }

    private failConnection(state: ManagedLaunchState | undefined, socket: Socket): void {
        socket.destroy();
        if (!state) return;
        if (state.phase === 'exited') {
            this.finishLostDrain(state);
            return;
        }
        // eslint-disable-next-line no-void -- The exact launch owns its asynchronous fail-closed cleanup.
        void this.terminate(state);
    }

    private finishLostDrain(state: ManagedLaunchState): void {
        if (state.handoffComplete || state.handoffLost) return;
        state.handoffLost = true;
        if (!state.handoff) return;
        const handoff = state.handoff;
        // eslint-disable-next-line no-void -- The completed PTY callback is the close and FD-reuse barrier.
        void handoff.ready
            .then(() => {
                state.handoffComplete = true;
                try {
                    handoff.closeOnLostDrain();
                } finally {
                    state.completed.resolve();
                    this.removeState(state);
                }
            })
            .catch(() => {
                // An unconfirmed write must keep the PTY fenced; Host shutdown owns final process teardown.
            });
    }

    private accept(socket: Socket): void {
        if (this.sockets.size >= 64 || this.isClosing) {
            socket.destroy();
            return;
        }
        this.sockets.add(socket);
        const decoder = new BoundedJsonLineDecoder(MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES);
        let state: ManagedLaunchState | undefined;
        socket.setEncoding('utf8');
        socket.setTimeout(this.claimTimeoutMs(), () => this.failConnection(state, socket));

        socket.on('data', (chunk: string) => {
            let values: Array<{ value: unknown; byteLength: number }>;
            try {
                values = decoder.push(chunk);
            } catch {
                this.failConnection(state, socket);
                return;
            }

            for (const { value } of values) {
                let message: ManagedAgentLauncherClientMessage;
                try {
                    message = parseManagedAgentLauncherClientMessage(value);
                } catch {
                    this.failConnection(state, socket);
                    return;
                }

                if (!state) {
                    if (message.type !== 'claim') {
                        this.failConnection(undefined, socket);
                        return;
                    }
                    const candidate = this.launches.get(message.launchId);
                    if (
                        !candidate?.tokenDigest ||
                        candidate.phase !== 'prepared' ||
                        !isTokenMatch(candidate.tokenDigest, message.token)
                    ) {
                        this.failConnection(undefined, socket);
                        return;
                    }
                    state = candidate;
                    const plan = state.plan;
                    if (!plan) {
                        this.failConnection(state, socket);
                        return;
                    }
                    state.tokenDigest = undefined;
                    state.phase = 'claimed';
                    state.socket = socket;
                    socket.setTimeout(0);
                    this.armPhaseTimeout(state);
                    try {
                        socket.write(encodeJsonLine(plan, MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES));
                        state.plan = undefined;
                    } catch {
                        this.failConnection(state, socket);
                        return;
                    }
                    continue;
                }

                if (message.type === 'claim') {
                    this.failConnection(state, socket);
                    return;
                }
                if (message.type === 'drained') {
                    if (state.phase !== 'exited' || !state.exitAckSent) {
                        this.failConnection(state, socket);
                        return;
                    }
                    state.handoffComplete = true;
                    try {
                        state.handoff?.resumeAfterDrain();
                    } catch {
                        state.handoff?.closeOnLostDrain();
                    }
                    state.completed.resolve();
                    this.removeState(state);
                    socket.end();
                    continue;
                }
                if (message.type === 'started') {
                    if (state.phase !== 'claimed') {
                        this.failConnection(state, socket);
                        return;
                    }
                    state.phase = 'started';
                    if (state.phaseTimer) clearTimeout(state.phaseTimer);
                    state.phaseTimer = undefined;
                    state.processId = message.processId;
                    state.started.resolve(message.processId);
                    this.emit({
                        type: 'started',
                        terminalId: state.terminalId,
                        launchId: state.launchId,
                        processId: message.processId,
                    });
                    if (state.isCanceling) this.writeControl(state, { type: 'cancel' });
                    continue;
                }
                if (state.phase !== 'started') {
                    this.failConnection(state, socket);
                    return;
                }
                state.phase = 'exited';
                this.emit({
                    type: 'exited',
                    terminalId: state.terminalId,
                    launchId: state.launchId,
                    exitCode: message.exitCode,
                    signal: message.signal,
                });
                const exitedState = state;
                try {
                    exitedState.handoff = this.options.beforeExitAck?.(exitedState.terminalId) ?? {
                        ready: Promise.resolve(),
                        resumeAfterDrain: () => {},
                        closeOnLostDrain: () => {},
                    };
                } catch {
                    this.failConnection(exitedState, socket);
                    return;
                }
                // eslint-disable-next-line no-void -- Observe the exact launch's asynchronous PTY input barrier.
                void exitedState.handoff.ready
                    .then(() => {
                        if (socket.destroyed || exitedState.handoffLost) {
                            return;
                        }
                        exitedState.exitAckSent = this.writeControl(exitedState, {
                            type: 'exitAck',
                        });
                        if (!exitedState.exitAckSent) socket.destroy();
                    })
                    .catch(() => this.failConnection(exitedState, socket));
            }
        });
        socket.once('end', () => {
            try {
                decoder.finish();
            } catch {
                this.failConnection(state, socket);
            }
        });
        socket.once('error', () => this.failConnection(state, socket));
        socket.once('close', () => {
            this.sockets.delete(socket);
            if (state && !state.handoffComplete) this.failConnection(state, socket);
        });
    }

    async start(): Promise<void> {
        if (this.server) return;
        if (this.isClosing) throw new Error('Managed Agent launcher server is closing');

        await ensureUnixSocketDirectory(this.options.socketPath);

        try {
            const existing = await lstat(this.options.socketPath);
            if (!existing.isSocket())
                throw new Error('Managed Agent launcher socket path is occupied');
            await rm(this.options.socketPath, { force: true });
        } catch (error) {
            if (!(
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                Reflect.get(error, 'code') === 'ENOENT'
            )) {
                throw error;
            }
        }

        const server = createServer((socket) => this.accept(socket));
        this.server = server;
        try {
            await new Promise<void>((resolve, reject) => {
                function onError(error: Error): void {
                    server.off('listening', onListening);
                    reject(error);
                }
                function onListening(): void {
                    server.off('error', onError);
                    resolve();
                }
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.options.socketPath);
            });
            await chmod(this.options.socketPath, 0o600);
        } catch (error) {
            this.server = undefined;
            if (server.listening)
                await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(this.options.socketPath, { force: true });
            throw error;
        }
    }

    prepare(input: PrepareManagedAgentLaunchInput): PreparedManagedAgentLaunch {
        if (!this.server?.listening || this.isClosing)
            throw new Error('Managed Agent launcher server is not running');
        if (
            input.terminalId.length === 0 ||
            input.terminalId.length > 256 ||
            input.launchId.length === 0 ||
            input.launchId.length > 256 ||
            this.launches.has(input.launchId) ||
            this.launchesByTerminal.has(input.terminalId) ||
            this.launches.size >= MAX_MANAGED_AGENT_LAUNCHES
        ) {
            throw new Error('Invalid or duplicate managed Agent launch identity');
        }

        const started = deferred<number>();
        // A caller may cancel an unused prepared launch without awaiting `started`; keep that expected rejection handled.
        observeExpectedRejection(started.promise);
        const token = randomBytes(32).toString('hex');
        const state: ManagedLaunchState = {
            terminalId: input.terminalId,
            launchId: input.launchId,
            plan: validateManagedAgentLaunchPlan(input.plan),
            tokenDigest: tokenDigest(token),
            phase: 'prepared',
            started,
            completed: deferred<void>(),
            isCanceling: false,
        };
        this.launches.set(input.launchId, state);
        this.launchesByTerminal.set(input.terminalId, state);
        this.armPhaseTimeout(state);

        return {
            environment: {
                CAXRI_AGENT_LAUNCHER_RUNTIME: this.options.runtimePath,
                CAXRI_AGENT_LAUNCHER_ENTRY: this.options.entryPath,
                CAXRI_AGENT_LAUNCHER_SOCKET: this.options.socketPath,
                CAXRI_AGENT_LAUNCHER_ID: input.launchId,
                CAXRI_AGENT_LAUNCHER_TOKEN: token,
            },
            started: started.promise,
        };
    }

    /**
     * Checks the exact child immediately before Host writes to its PTY.
     */
    isRunningExact(terminalId: string, launchId: string): boolean {
        const state = this.launchesByTerminal.get(terminalId);
        if (
            !state ||
            state.launchId !== launchId ||
            state.phase !== 'started' ||
            state.isCanceling ||
            !state.processId
        )
            return false;
        try {
            process.kill(state.processId, 0);
            return true;
        } catch {
            return false;
        }
    }

    signalExact(terminalId: string, launchId: string, signal: ManagedAgentLauncherSignal): boolean {
        const state = this.launches.get(launchId);
        if (
            !state ||
            state.terminalId !== terminalId ||
            state.phase !== 'started' ||
            state.isCanceling
        ) {
            return false;
        }
        return this.writeControl(state, { type: 'signal', signal });
    }

    async cancel(terminalId: string, launchId: string): Promise<boolean> {
        const state = this.launches.get(launchId);
        if (!state || state.terminalId !== terminalId) return false;
        await this.terminate(state);
        return true;
    }

    async close(): Promise<void> {
        if (this.isClosing) return;
        this.isClosing = true;
        const server = this.server;
        this.server = undefined;
        const serverClosed =
            server?.listening === true
                ? new Promise<void>((resolve) => server.close(() => resolve()))
                : Promise.resolve();
        await Promise.all(this.launches.values().map((state) => this.terminate(state)));
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await serverClosed;
        await rm(this.options.socketPath, { force: true });
    }
}
