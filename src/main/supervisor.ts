import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { utilityProcess, type UtilityProcess } from 'electron';

import { safeProcessEnvironment } from '../runtime/process-environment';
import type { RuntimeEvent, RuntimeMessage, RuntimeMethod } from '../shared/contracts';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface RuntimeReadiness {
    promise: Promise<void>;
    reject: (error: Error) => void;
    resolve: () => void;
}

const RUNTIME_READY_TIMEOUT_MS = 15_000;
const RUNTIME_STABILITY_WINDOW_MS = 30_000;

export class RuntimeSupervisor extends EventEmitter {
    private child?: UtilityProcess;
    private pending = new Map<string, PendingRequest>();
    private restartCount = 0;
    private intentionalStop = false;
    private terminalFailure?: Error;
    private readiness?: RuntimeReadiness;
    private stabilityTimer?: NodeJS.Timeout;

    constructor(
        private readonly runtimeDirectory: string,
        private readonly userDataPath: string,
        private readonly logDirectory: string,
        private readonly logLevel: 'debug' | 'info' = 'debug',
    ) {
        super();
    }

    start(): Promise<void> {
        if (this.child) return this.readiness?.promise ?? Promise.resolve();
        if (this.terminalFailure) return Promise.reject(this.terminalFailure);
        if (this.intentionalStop) return Promise.reject(new Error('Runtime has been stopped'));
        this.readiness ??= this.createReadiness();
        const runtimePath = join(this.runtimeDirectory, 'runtime.js');
        let child: UtilityProcess;
        try {
            child = utilityProcess.fork(runtimePath, [], {
                serviceName: 'Caxri Runtime',
                env: {
                    ...safeProcessEnvironment(),
                    CAXRI_LOG_DIRECTORY: this.logDirectory,
                    CAXRI_LOG_LEVEL: this.logLevel,
                    CAXRI_USER_DATA_PATH: this.userDataPath,
                },
                stdio: 'pipe',
            });
        } catch (error) {
            const failure = error instanceof Error ? error : new Error('Runtime failed to start');
            this.emit('runtime-error', failure);
            this.onExit(-1);
            return this.readiness?.promise ?? Promise.reject(failure);
        }
        this.child = child;
        child.on('message', (message: RuntimeMessage) => {
            if (this.child === child) this.onMessage(message);
        });
        child.on('exit', (code) => {
            if (this.child === child) this.onExit(code);
        });
        child.on('error', (error) => this.emit('runtime-error', error));
        child.stdout?.on('data', (chunk) => this.emit('runtime-log', String(chunk)));
        child.stderr?.on('data', (chunk) => this.emit('runtime-log', String(chunk)));
        return this.readiness.promise;
    }

    private createReadiness(): RuntimeReadiness {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        let settled = false;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
            resolve = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolvePromise();
            };
            reject = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                rejectPromise(error);
            };
        });
        const timer = setTimeout(() => {
            const failure = new Error('Runtime did not become ready within 15 seconds');
            reject(failure);
            this.readiness = undefined;
            this.restartCount = 3;
            this.terminalFailure = failure;
            const child = this.child;
            this.child = undefined;
            child?.kill();
            this.emit('event', {
                event: 'runtime.status',
                payload: { status: 'failed', restartCount: this.restartCount },
            } satisfies RuntimeEvent);
        }, RUNTIME_READY_TIMEOUT_MS);
        return { promise, reject, resolve };
    }

    private onMessage(message: RuntimeMessage): void {
        if ('event' in message) {
            if (message.event === 'runtime.status' && message.payload.status === 'ready') {
                this.readiness?.resolve();
                this.readiness = undefined;
                this.terminalFailure = undefined;
                if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
                this.stabilityTimer = setTimeout(() => {
                    this.restartCount = 0;
                    this.stabilityTimer = undefined;
                }, RUNTIME_STABILITY_WINDOW_MS);
                this.stabilityTimer.unref();
            }
            this.emit('event', message);
            return;
        }
        const response = message;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error?.message ?? 'Runtime request failed'));
    }

    private onExit(code: number): void {
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.child = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Runtime exited with code ${code}`));
        }
        this.pending.clear();
        if (this.intentionalStop || this.terminalFailure) return;
        if (this.restartCount >= 3) {
            const failure = new Error('Runtime failed after 3 restart attempts');
            this.terminalFailure = failure;
            this.readiness?.reject(failure);
            this.readiness = undefined;
            this.emit('event', {
                event: 'runtime.status',
                payload: { status: 'failed', restartCount: this.restartCount },
            } satisfies RuntimeEvent);
            return;
        }
        this.restartCount += 1;
        this.emit('event', {
            event: 'runtime.status',
            payload: { status: 'restarting', restartCount: this.restartCount },
        } satisfies RuntimeEvent);
        setTimeout(
            () => void this.start().catch((error: unknown) => this.emit('runtime-error', error)),
            Math.min(250 * 2 ** (this.restartCount - 1), 2_000),
        );
    }

    async request<T = unknown>(
        method: RuntimeMethod,
        params: unknown = {},
        timeoutMs = 20_000,
    ): Promise<T> {
        await this.start();
        const child = this.child;
        if (!child) throw new Error('Runtime is unavailable');
        const id = randomUUID();
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Runtime request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
                timer,
            });
            child.postMessage({ id, method, params });
        });
    }

    async shutdown(): Promise<void> {
        this.intentionalStop = true;
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = undefined;
        this.readiness?.reject(new Error('Runtime stopped before becoming ready'));
        this.readiness = undefined;
        const child = this.child;
        if (!child) return;
        try {
            await this.request('runtime.shutdown', {}, 5_000);
        } catch {
            // The process may exit after completing shutdown before its reply is observed.
        } finally {
            child.kill();
            this.child = undefined;
        }
    }
}
