import type { ServerSupervisionEvent } from '@caxri/client/supervise';
import { connectDesktopToServer, ensureServer } from '@caxri/client/supervise';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type {
    DesktopServerConnectionOptions,
    DesktopServerSupervisor,
} from '../../server-attachment';
import { DesktopServerConnection } from '../../server-connection';
import type { ServerBuildIdentity } from '../../server-staleness';

export interface FakeServerClient {
    close: ReturnType<typeof vi.fn>;
    markDesktopReady: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
    onEvent: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    requestServerOperation: ReturnType<typeof vi.fn>;
    triggerClose: (reason?: 'replaced', closeCode?: number) => void;
    triggerEvent: (envelope: unknown) => void;
    welcome: {
        connection: {
            bootId: string;
            clientId: string;
            connectionId: string;
            serverId: string;
            stateEpoch: string;
        };
    };
}

export const defaultRecoveryIdentity = {
    serverId: 'a'.repeat(32),
    stateEpoch: 'b'.repeat(32),
};

export function recoveryRequest(afterCursor: number, identity = defaultRecoveryIdentity) {
    return { afterCursor, ...identity };
}

export function durableEnvelope(
    cursor: number,
    event: unknown,
    identity = defaultRecoveryIdentity,
) {
    return { cursor, event, ...identity };
}

export function recoveryResult(
    cursor: number,
    events: Array<{ cursor: number; event: unknown }> = [],
    identity = defaultRecoveryIdentity,
) {
    return {
        kind: 'events' as const,
        cursor,
        events: events.map((event) => ({ ...event, ...identity })),
        barrier: { kind: 'live' as const, cursor },
        ...identity,
    };
}

export function createFakeServerClient(options: ServerRoundOptions = {}): FakeServerClient {
    const closeListeners: Array<(reason?: 'replaced', closeCode?: number) => void> = [];
    const eventListeners: Array<(envelope: unknown) => void> = [];
    const recoveryIdentity = {
        serverId: options.serverId ?? defaultRecoveryIdentity.serverId,
        stateEpoch: options.stateEpoch ?? defaultRecoveryIdentity.stateEpoch,
    };
    return {
        close: vi.fn(),
        markDesktopReady: vi.fn().mockResolvedValue(undefined),
        onClose: vi.fn((listener: (reason?: 'replaced', closeCode?: number) => void) => {
            closeListeners.push(listener);
            return () => {};
        }),
        onEvent: vi.fn((listener: (envelope: unknown) => void) => {
            eventListeners.push(listener);
            return () => {};
        }),
        request: vi.fn().mockResolvedValue(recoveryResult(0, [], recoveryIdentity)),
        requestServerOperation: vi.fn(),
        triggerClose: (reason, closeCode) => {
            for (const listener of closeListeners) listener(reason, closeCode);
        },
        triggerEvent: (envelope) => {
            for (const listener of eventListeners) listener(envelope);
        },
        welcome: {
            connection: {
                bootId: options.bootId ?? 'c'.repeat(32),
                clientId: 'desktop-1',
                connectionId: 'd'.repeat(32),
                ...recoveryIdentity,
            },
        },
    };
}

interface FakeDesktopServerSupervisor extends DesktopServerSupervisor {
    emit(event: ServerSupervisionEvent): void;
    lossEvent?: ServerSupervisionEvent;
    releaseProcess: Mock<(pid: number) => void>;
    reportProcessLoss: Mock<(pid: number) => boolean>;
}

export interface FakeConnection {
    connection: DesktopServerConnection;
    logger: { write: Mock };
    serverSupervisor: FakeDesktopServerSupervisor;
}

export function createConnection(
    identity: ServerBuildIdentity = {},
    handleCommand: DesktopServerConnectionOptions['handleCommand'] = () => Promise.resolve(null),
): FakeConnection {
    const logger = { write: vi.fn() };
    let serverSupervisor!: FakeDesktopServerSupervisor;
    // Production computes `buildId` by fingerprinting the on-disk bundles; the test seam returns it directly.
    const { buildId, ...buildIdentity } = identity;
    const connection = new DesktopServerConnection({
        buildIdentity,
        computeBuildId: () => Promise.resolve(buildId),
        createServerSupervisor: (userDataPath, launchOptions) => {
            let isFailed = false;
            let listener: ((event: ServerSupervisionEvent) => void) | undefined;
            serverSupervisor = {
                emit(event) {
                    isFailed = event.status === 'failed';
                    listener?.(event);
                },
                ensure: (timeoutMs) => ensureServer(userDataPath, launchOptions, timeoutMs),
                isFailed: () => isFailed,
                onLifecycle: (nextListener) => {
                    listener = nextListener;
                    return () => {
                        if (listener === nextListener) listener = undefined;
                    };
                },
                releaseProcess: vi.fn<(pid: number) => void>(),
                reportProcessLoss: vi.fn<(pid: number) => boolean>(() => {
                    if (!serverSupervisor.lossEvent) return false;
                    serverSupervisor.emit(serverSupervisor.lossEvent);
                    return true;
                }),
            };
            return serverSupervisor;
        },
        currentDirectory: '/app/out/main',
        cliPath: '/app/cli/caxri.cjs',
        desktopId: 'desktop-1',
        desktopLaunch: { executable: '/app/Caxri', args: [], cwd: '/app' },
        handleCommand,
        logger: logger as never,
        serverArtifactRoot: '/app/server',
        userDataPath: '/profile',
    });
    return { connection, logger, serverSupervisor };
}

export interface ServerRoundOptions {
    bootId?: string;
    serverBuildId?: string;
    serverCommit?: string;
    serverVersion?: string;
    pid?: number;
    startedAt?: number;
    serverId?: string;
    stateEpoch?: string;
}

export interface FakeServerOperator {
    close: Mock<() => void>;
    request: Mock<(method: string) => Promise<unknown>>;
}

export function createFakeOperator(options: ServerRoundOptions = {}): FakeServerOperator {
    return {
        close: vi.fn(),
        request: vi.fn((method: string) =>
            method === 'host.stop'
                ? Promise.resolve({ stopping: true, activePtyCount: 0 })
                : Promise.resolve({
                      /**
                       * An impossible pid so the replacement path's liveness poll returns immediately instead of
                       * probing a real process.
                       */
                      pid: options.pid ?? 999_999,
                      startedAt: options.startedAt ?? 1000,
                      version: options.serverVersion ?? '0.0.9',
                      ...(options.serverCommit && { commit: options.serverCommit }),
                      ...(options.serverBuildId && { buildId: options.serverBuildId }),
                  }),
        ),
    };
}

export function mockServerRound(options: ServerRoundOptions = {}): FakeServerClient {
    const client = createFakeServerClient(options);
    vi.mocked(ensureServer).mockResolvedValue(createFakeOperator(options) as never);
    vi.mocked(connectDesktopToServer).mockResolvedValue(client as never);
    return client;
}
