import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import type { HostClient } from '@caxri/cli';
import { connectDesktopToHost, ensureHost } from '@caxri/cli';

import type { HostDesktopLaunch } from '../shared/ipc/desktop-launch';
import { HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY } from '../shared/ipc/desktop-launch';
import { isDesktopRuntimeMethod } from '../shared/ipc/desktop-runtime';
import { CaxriError } from '../shared/ipc/errors';
import { createRecoveringEventClient } from '../shared/ipc/event-client';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { DesktopOperation, DesktopTargetPayload } from '../shared/ipc/local-transport';
import type {
    CaxriMethod,
    RuntimeMethod,
    RuntimeMethodResult,
    RuntimeParamsArg as RuntimeParametersArgument,
} from '../shared/ipc/methods';
import { isCaxriMethod } from '../shared/ipc/methods';
import type { E2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { e2eAgentPolicyEnvironment } from '../shared/node/e2e-agent-policy';
import type { StructuredLogger } from '../shared/node/logger';

type DesktopCommandHandler = (
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
) => Promise<unknown>;

interface UntypedHostClient {
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown>;
    requestRuntime(
        method: RuntimeMethod,
        parameters?: unknown,
        timeoutMs?: number,
    ): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, parameters?: unknown): Promise<unknown>;
}

export interface DesktopHostConnectionOptions {
    agentHooksPath?: string;
    cliPath: string;
    currentDirectory: string;
    desktopId: string;
    desktopLaunch: HostDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
    handleCommand: DesktopCommandHandler;
    logger: StructuredLogger;
    userDataPath: string;
}

export function resolveDesktopLaunch(options: {
    currentDirectory: string;
    executable: string;
    isPackaged: boolean;
}): HostDesktopLaunch {
    if (options.isPackaged)
        return { executable: options.executable, args: [], cwd: dirname(options.executable) };
    const projectRoot = resolve(options.currentDirectory, '../..');
    return { executable: options.executable, args: [projectRoot], cwd: projectRoot };
}

/**
Desktop-side client facade preserving Main's typed Runtime request call sites during migration.
 */
export class DesktopHostConnection extends EventTarget {
    private client?: HostClient;
    private hostPid?: number;
    private runtimePid?: number;
    private starting?: Promise<void>;

    constructor(private readonly options: DesktopHostConnectionOptions) {
        super();
    }

    private async connect(): Promise<void> {
        const operator = await ensureHost(this.options.userDataPath, {
            executable: process.execPath,
            entryPath: join(this.options.currentDirectory, 'host.js'),
            environment: {
                [HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY]: JSON.stringify(this.options.desktopLaunch),
                ...e2eAgentPolicyEnvironment(this.options.e2eAgentPolicy),
                ...(process.env.CAXRI_E2E_WINDOW_MODE && {
                    CAXRI_E2E_WINDOW_MODE: process.env.CAXRI_E2E_WINDOW_MODE,
                }),
                ...(process.env.CAXRI_E2E_WORKER_NAMESPACE && {
                    CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE,
                }),
                ...(process.env.CAXRI_TEST_ROOT_PATH && {
                    CAXRI_TEST_ROOT_PATH: process.env.CAXRI_TEST_ROOT_PATH,
                }),
                ...(process.env.CAXRI_TEST_ROOT_PATHS && {
                    CAXRI_TEST_ROOT_PATHS: process.env.CAXRI_TEST_ROOT_PATHS,
                }),
                ...(this.options.agentHooksPath && {
                    CAXRI_AGENT_HOOKS_PATH: this.options.agentHooksPath,
                }),
                CAXRI_CLI_PATH: this.options.cliPath,
            },
        });
        try {
            const status = await operator.request('host.status');
            this.hostPid = status.pid;
            this.runtimePid = status.runtimePid;
        } finally {
            operator.close();
        }
        const client = await connectDesktopToHost(
            this.options.userDataPath,
            this.options.desktopId,
            this.options.handleCommand,
        );
        this.client = client;
        const events = createRecoveringEventClient({
            emit: (event) => {
                this.dispatchEvent(new CustomEvent<RuntimeEvent>('event', { detail: event }));
            },
            onError: (error) =>
                this.options.logger.write('error', 'host.event_recovery_failed', {
                    fields: {
                        error: error instanceof Error ? error.message : 'Unknown recovery error',
                    },
                }),
            recover: (afterCursor) => client.request('events.recover', { afterCursor }),
        });
        client.onEvent((event) => events.receive(event));
        await events.start();
    }

    processId(): number | undefined {
        return this.runtimePid;
    }

    hostProcessId(): number | undefined {
        return this.hostPid;
    }

    start(): Promise<void> {
        const starting = this.starting ?? this.connect();
        this.starting = starting;
        // `start()` returns the in-flight connection promise synchronously; resetting
        // `this.starting` on failure so a later caller can retry is deliberately
        // fire-and-forget here rather than awaited.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        starting.catch(() => {
            if (this.starting === starting) this.starting = undefined;
        });
        return starting;
    }

    /**
    Subscribes to Runtime protocol events; returns an unsubscribe function.
     */
    onEvent(listener: (event: RuntimeEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<RuntimeEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    request<M extends RuntimeMethod>(
        method: M,
        ...arguments_: RuntimeParametersArgument<M>
    ): Promise<RuntimeMethodResult<M>> {
        const attached = this.client;
        if (!attached)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        const client = attached as unknown as UntypedHostClient;
        const [parameters, timeoutMs] = arguments_;
        if (isDesktopRuntimeMethod(method))
            return client.requestRuntime(method, parameters, timeoutMs) as Promise<
                RuntimeMethodResult<M>
            >;
        if (!isCaxriMethod(method))
            return Promise.reject(new Error(`Unsupported Desktop Host method: ${method}`));
        return client.request(method, parameters) as Promise<RuntimeMethodResult<M>>;
    }

    forward(method: CaxriMethod, parameters: unknown, requestId: string): Promise<unknown> {
        const attached = this.client;
        if (!attached)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        const client = attached as unknown as UntypedHostClient;
        return client.requestWithId(requestId, method, parameters);
    }

    markDesktopReady(): Promise<void> {
        const client = this.client;
        if (!client)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        return client.markDesktopReady();
    }

    close(): void {
        this.client?.close();
        this.client = undefined;
    }

    /**
    Compatibility name for old Main teardown call sites; it never stops the Host-owned Runtime.
     */
    shutdown(): Promise<void> {
        this.close();
        return Promise.resolve();
    }
}
