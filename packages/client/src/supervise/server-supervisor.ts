import process from 'node:process';

import type { ServerManifest } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError } from '@caxri/protocol';

import { ServerClient } from './client.js';
import { discoverServerManifest } from './discovery.js';
import type { ServerLaunchOptions, ServerLaunchReceipt } from './launch.js';
import { launchServer } from './launch.js';

export interface ServerSupervisionPolicy {
    maximumRestartAttempts: number;
    maximumRestartBackoffMs: number;
    pollingIntervalMs: number;
    restartBackoffBaseMs: number;
    stabilityWindowMs: number;
}

const defaultServerSupervisionPolicy: Readonly<ServerSupervisionPolicy> = Object.freeze({
    maximumRestartAttempts: 3,
    maximumRestartBackoffMs: 2_000,
    pollingIntervalMs: 25,
    restartBackoffBaseMs: 250,
    stabilityWindowMs: 30_000,
});

export type ServerSupervisionEvent =
    | {
          backoffMs: number;
          restartCount: number;
          status: 'restarting';
      }
    | {
          error: CaxriError;
          restartCount: number;
          status: 'failed';
      };

/**
 * Platform adapter for the shared Server artifact lifecycle contract. Desktop and CLI use the local default; a
 * platform-managed deployment can provide equivalent discovery, process, launch, and wait primitives without changing
 * restart limits or readiness semantics.
 */
export interface ServerArtifactSupervisorAdapter {
    connect(manifest: ServerManifest, timeoutMs: number): Promise<ServerClient>;
    discover(userDataPath: string): Promise<ServerManifest>;
    isProcessAlive(pid: number): boolean;
    launch(userDataPath: string, options: ServerLaunchOptions): Promise<ServerLaunchReceipt>;
    now(): number;
    wait(milliseconds: number): Promise<void>;
}

const defaultAdapter: ServerArtifactSupervisorAdapter = {
    connect: (manifest, timeoutMs) =>
        ServerClient.connect(manifest, timeoutMs, { kind: 'operator' }),
    discover: discoverServerManifest,
    isProcessAlive: (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return fileSystemCode(error) !== 'ESRCH';
        }
    },
    launch: launchServer,
    now: Date.now,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function isNotFound(error: unknown): boolean {
    return error instanceof CaxriError && error.code === 'NOT_FOUND';
}

function restartBackoffMs(policy: ServerSupervisionPolicy, restartCount: number): number {
    return Math.min(
        policy.restartBackoffBaseMs * 2 ** (restartCount - 1),
        policy.maximumRestartBackoffMs,
    );
}

interface ProcessIdentity {
    pid: number;
    startedAt: number;
}

/**
 * Supervises one profile's immutable Server artifact. A ready process is adopted, a missing process is launched once,
 * and a Core that dies before or shortly after readiness is restarted with the same bounded policy formerly applied to
 * the generic execution child. The class deliberately does not keep the Server alive after its caller exits: Desktop,
 * CLI, or a platform owns when to invoke the contract.
 */
export class ServerArtifactSupervisor extends EventTarget {
    private activeProcess?: ProcessIdentity;
    private launchedPid?: number;
    private readyAt?: number;
    private restartCount = 0;
    private restartNotBefore = 0;
    private terminalFailure?: CaxriError;
    private readonly adapter: ServerArtifactSupervisorAdapter;
    private readonly policy: ServerSupervisionPolicy;

    constructor(
        private readonly userDataPath: string,
        private readonly launchOptions: ServerLaunchOptions,
        options: {
            adapter?: ServerArtifactSupervisorAdapter;
            policy?: Partial<ServerSupervisionPolicy>;
        } = {},
    ) {
        super();
        this.adapter = options.adapter ?? defaultAdapter;
        this.policy = { ...defaultServerSupervisionPolicy, ...options.policy };
    }

    private emitLifecycle(event: ServerSupervisionEvent): void {
        this.dispatchEvent(new CustomEvent<ServerSupervisionEvent>('lifecycle', { detail: event }));
    }

    private failAfterRestartBudget(): CaxriError {
        const failure = new CaxriError(
            'UNAVAILABLE',
            `Runtime failed after ${this.policy.maximumRestartAttempts} restart attempts`,
        );
        this.terminalFailure = failure;
        this.emitLifecycle({
            error: failure,
            restartCount: this.restartCount,
            status: 'failed',
        });
        return failure;
    }

    private scheduleRestart(now: number): void {
        if (this.restartNotBefore > 0 || this.terminalFailure) return;
        if (this.readyAt !== undefined && now - this.readyAt >= this.policy.stabilityWindowMs)
            this.restartCount = 0;
        this.readyAt = undefined;
        if (this.restartCount >= this.policy.maximumRestartAttempts) {
            this.failAfterRestartBudget();
            return;
        }
        this.restartCount += 1;
        const backoffMs = restartBackoffMs(this.policy, this.restartCount);
        this.restartNotBefore = now + backoffMs;
        this.emitLifecycle({ backoffMs, restartCount: this.restartCount, status: 'restarting' });
    }

    private forgetDeadProcess(pid: number): void {
        if (this.activeProcess?.pid === pid) this.activeProcess = undefined;
        if (this.launchedPid === pid) this.launchedPid = undefined;
        this.scheduleRestart(this.adapter.now());
    }

    private async discover(): Promise<ServerManifest | undefined> {
        try {
            return await this.adapter.discover(this.userDataPath);
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    }

    private knownProcessId(): number | undefined {
        return this.launchedPid ?? this.activeProcess?.pid;
    }

    /**
     * Records an observed control-connection loss immediately when the known Core process has exited. Returns true only
     * when the loss consumed restart budget; a live process remains an ordinary transport reconnection.
     */
    reportProcessLoss(pid: number): boolean {
        if (
            this.terminalFailure ||
            this.knownProcessId() !== pid ||
            this.adapter.isProcessAlive(pid)
        )
            return false;
        this.forgetDeadProcess(pid);
        return true;
    }

    /**
     * Excludes an intentional replacement from the crash budget, for example when Desktop replaces a stale build.
     */
    releaseProcess(pid: number): void {
        if (this.knownProcessId() !== pid) return;
        this.activeProcess = undefined;
        this.launchedPid = undefined;
        this.readyAt = undefined;
        this.restartCount = 0;
        this.restartNotBefore = 0;
        this.terminalFailure = undefined;
    }

    isFailed(): boolean {
        return this.terminalFailure !== undefined;
    }

    async ensure(timeoutMs = 15_000): Promise<ServerClient> {
        const deadline = this.adapter.now() + timeoutMs;
        while (this.adapter.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop -- one profile's discovery/readiness attempts must stay ordered.
            let manifest = await this.discover();
            if (
                manifest &&
                manifest.protocolVersion !== CAXRI_PROTOCOL_VERSION &&
                !this.adapter.isProcessAlive(manifest.pid)
            )
                manifest = undefined;

            if (manifest) {
                const connectTimeoutMs = Math.min(2_000, deadline - this.adapter.now());
                try {
                    // eslint-disable-next-line no-await-in-loop -- readiness polling is sequential for one profile lock.
                    const client = await this.adapter.connect(
                        manifest,
                        Math.max(1, connectTimeoutMs),
                    );
                    this.activeProcess = { pid: manifest.pid, startedAt: manifest.startedAt };
                    this.launchedPid = undefined;
                    this.readyAt = this.adapter.now();
                    this.restartNotBefore = 0;
                    this.terminalFailure = undefined;
                    return client;
                } catch (error) {
                    if (!(error instanceof CaxriError) || error.code !== 'UNAVAILABLE') throw error;
                    if (this.adapter.isProcessAlive(manifest.pid))
                        throw new CaxriError(
                            'CONFLICT',
                            'Caxri Server process is alive but its authenticated endpoint is unavailable',
                        );
                    if (this.knownProcessId() === manifest.pid)
                        this.forgetDeadProcess(manifest.pid);
                }
            }

            const knownPid = this.knownProcessId();
            if (knownPid !== undefined) {
                if (!this.adapter.isProcessAlive(knownPid)) this.forgetDeadProcess(knownPid);
            } else if (this.terminalFailure) {
                throw this.terminalFailure;
            } else if (this.restartNotBefore <= this.adapter.now()) {
                // eslint-disable-next-line no-await-in-loop -- one launch contender per profile and restart attempt.
                const receipt = await this.adapter.launch(this.userDataPath, this.launchOptions);
                this.launchedPid = receipt.pid;
                this.restartNotBefore = 0;
            }

            const remainingMs = deadline - this.adapter.now();
            if (remainingMs <= 0) break;
            const untilRestartMs = Math.max(0, this.restartNotBefore - this.adapter.now());
            const waitMs = Math.min(
                remainingMs,
                untilRestartMs > 0 ? untilRestartMs : this.policy.pollingIntervalMs,
            );
            // eslint-disable-next-line no-await-in-loop -- bounded readiness/restart polling by design.
            await this.adapter.wait(waitMs);
        }
        if (this.terminalFailure) throw this.terminalFailure;
        throw new CaxriError('TIMEOUT', 'Caxri Server did not become ready before the deadline');
    }

    onLifecycle(listener: (event: ServerSupervisionEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<ServerSupervisionEvent>).detail);
        this.addEventListener('lifecycle', handler);
        return () => this.removeEventListener('lifecycle', handler);
    }
}

/**
 * One-shot convenience used by clients that only need initial readiness. Long-lived owners should retain a
 * `ServerArtifactSupervisor` so restart budget and the stability window span reconnections.
 */
export function ensureServer(
    userDataPath: string,
    launch: ServerLaunchOptions,
    timeoutMs = 15_000,
): Promise<ServerClient> {
    return new ServerArtifactSupervisor(userDataPath, launch).ensure(timeoutMs);
}
