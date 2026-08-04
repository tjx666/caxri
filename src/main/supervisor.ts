import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { utilityProcess, type UtilityProcess } from 'electron';

import type { RuntimeEvent, RuntimeMessage, RuntimeMethod } from '../shared/contracts';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

export class RuntimeSupervisor extends EventEmitter {
    private child?: UtilityProcess;
    private pending = new Map<string, PendingRequest>();
    private restartCount = 0;
    private intentionalStop = false;
    private readyPromise?: Promise<void>;
    private resolveReady?: () => void;

    constructor(
        private readonly runtimeDirectory: string,
        private readonly userDataPath: string,
        private readonly logDirectory: string,
    ) {
        super();
    }

    start(): Promise<void> {
        if (this.child) return this.readyPromise ?? Promise.resolve();
        this.intentionalStop = false;
        this.readyPromise = new Promise<void>((resolve) => {
            this.resolveReady = resolve;
        });
        const runtimePath = join(this.runtimeDirectory, 'runtime.js');
        const child = utilityProcess.fork(runtimePath, [], {
            serviceName: 'Caxri Runtime',
            env: {
                ...process.env,
                CAXRI_LOG_DIRECTORY: this.logDirectory,
                CAXRI_USER_DATA_PATH: this.userDataPath,
            },
            stdio: 'pipe',
        });
        this.child = child;
        child.on('message', (message: RuntimeMessage) => this.onMessage(message));
        child.on('exit', (code) => this.onExit(code));
        child.on('error', (error) => this.emit('runtime-error', error));
        child.stdout?.on('data', (chunk) => this.emit('runtime-log', String(chunk)));
        child.stderr?.on('data', (chunk) => this.emit('runtime-log', String(chunk)));
        return this.readyPromise;
    }

    private onMessage(message: RuntimeMessage): void {
        if ('event' in message) {
            if (message.event === 'runtime.status' && message.payload.status === 'ready') {
                this.resolveReady?.();
                this.resolveReady = undefined;
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
        this.child = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Runtime exited with code ${code}`));
        }
        this.pending.clear();
        if (this.intentionalStop) return;
        if (this.restartCount >= 3) {
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
        setTimeout(() => void this.start(), Math.min(250 * 2 ** (this.restartCount - 1), 2_000));
    }

    async request<T = unknown>(
        method: RuntimeMethod,
        params: unknown = {},
        timeoutMs = 20_000,
    ): Promise<T> {
        if (!this.child) await this.start();
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
