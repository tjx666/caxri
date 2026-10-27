import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerOperation, ServerOperationParameters } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, CaxriError, internalMethods, methods } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import { CaxriDatabase } from '../../domains/db';
import type { DomainHandlers, DomainServices } from '../../domains/domain-services';
import type { TerminalExecutionPort } from '../../domains/terminal';
import { ServerDomainService } from '../domain-service';
import { createMemoryCredentialStores } from './credential-stores.fixture';

const serverOperationNames = [
    ...Object.keys(methods),
    ...Object.keys(internalMethods),
] as ServerOperation[];

function handlers(overrides: Partial<Record<ServerOperation, unknown>> = {}): DomainHandlers {
    return {
        ...Object.fromEntries(serverOperationNames.map((method) => [method, () => null])),
        ...overrides,
    } as unknown as DomainHandlers;
}

function dependencies() {
    return {
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        terminalExecution: {} as TerminalExecutionPort,
        userDataPath: '/profile',
    };
}

afterEach(() => vi.useRealTimers());

describe('ServerDomainService', () => {
    it('invokes domain handlers directly and publishes readiness once', async () => {
        const close = vi.fn(async () => {});
        const createServices = vi.fn((): Promise<DomainServices> =>
            Promise.resolve({
                close,
                handlers: handlers({
                    'app.health': () => ({
                        activePtyCount: 0,
                        pid: 42,
                        ready: true,
                        startedAt: 1,
                    }),
                }),
                credentials: createMemoryCredentialStores(),
                protocolRecovery: createTestProtocolRecoveryState(),
                validateRequestContext: vi.fn(),
            }),
        );
        const service = new ServerDomainService(dependencies(), createServices);
        const events: unknown[] = [];
        service.onEvent((event) => events.push(event));

        await expect(service.request('app.health')).resolves.toEqual({
            activePtyCount: 0,
            pid: 42,
            ready: true,
            startedAt: 1,
        });
        await expect(service.start()).resolves.toBeUndefined();
        expect(createServices).toHaveBeenCalledOnce();
        expect(events).toEqual([
            { event: 'runtime.status', payload: { status: 'ready', restartCount: 0 } },
        ]);
        await service.shutdown();
        expect(close).toHaveBeenCalledOnce();
    });

    it('settles cancellation immediately while aborting the admitted handler', async () => {
        const started = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const service = new ServerDomainService(dependencies(), () =>
            Promise.resolve({
                close: async () => {},
                handlers: handlers({
                    'files.list': async (_parameters: unknown, signal: AbortSignal) => {
                        started.resolve();
                        await new Promise<void>((resolve) =>
                            signal.addEventListener('abort', () => resolve(), { once: true }),
                        );
                        aborted.resolve();
                        signal.throwIfAborted();
                        return [];
                    },
                }),
                credentials: createMemoryCredentialStores(),
                protocolRecovery: createTestProtocolRecoveryState(),
                validateRequestContext: () => {},
            }),
        );
        const controller = new AbortController();
        const pending = service.requestWithSignal(
            'files.list',
            { sessionId: 'session-1' },
            controller.signal,
        );
        await started.promise;

        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        await aborted.promise;
        await service.shutdown();
    });

    it('preserves stable direct-call failures and request timeouts', async () => {
        vi.useFakeTimers();
        const service = new ServerDomainService(dependencies(), () =>
            Promise.resolve({
                close: async () => {},
                handlers: handlers({
                    'terminal.attach': () => {
                        throw new CaxriError('NOT_FOUND', 'Terminal not found');
                    },
                    'terminal.snapshot': async (_parameters: unknown, signal: AbortSignal) => {
                        await new Promise<void>((resolve) =>
                            signal.addEventListener('abort', () => resolve(), { once: true }),
                        );
                        signal.throwIfAborted();
                        return null;
                    },
                }),
                credentials: createMemoryCredentialStores(),
                protocolRecovery: createTestProtocolRecoveryState(),
                validateRequestContext: () => {},
            }),
        );

        await expect(
            service.request('terminal.attach', { terminalId: 'terminal-1' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Terminal not found' });
        const timedOut = service.request('terminal.snapshot', { terminalId: 'terminal-1' }, 10);
        const rejected = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(10);
        await rejected;
        await service.shutdown();
    });

    it('commits structural state, changefeed, and receipt together or rolls all of them back', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-atomic-domain-command-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject('/private/project-one');
        const identity = database.protocolState.identity();
        const service = new ServerDomainService(dependencies(), (domainDependencies) =>
            Promise.resolve({
                close: () => {
                    database.close();
                    return Promise.resolve();
                },
                handlers: handlers({
                    'project.setIcon': ({
                        projectId,
                        icon,
                    }: ServerOperationParameters<'project.setIcon'>) => {
                        const updated = database.setProjectIcon(projectId, icon);
                        domainDependencies.send({
                            event: 'state.changed',
                            payload: { kind: 'full', reason: 'project.setIcon' },
                        });
                        return updated;
                    },
                }),
                credentials: createMemoryCredentialStores(),
                protocolRecovery: database.protocolState,
                validateRequestContext: () => {},
            }),
        );
        const deliveries: unknown[] = [];
        service.onEvent((event, persistedEnvelope) =>
            deliveries.push({ event, persistedEnvelope }),
        );

        try {
            await service.start();
            expect(() =>
                service.forwardAtomically(
                    {
                        method: 'project.setIcon',
                        params: {
                            projectId: project.id,
                            icon: { name: 'database', color: 'warning' },
                        },
                    },
                    'icon-rollback',
                    () => {
                        throw new Error('receipt write failed');
                    },
                ),
            ).toThrow('receipt write failed');
            expect(database.getProject(project.id)?.icon).toBeUndefined();
            expect(database.protocolState.changefeedBounds(identity.stateEpoch).count).toBe(0);
            expect(database.protocolState.inspect().commandReceipts).toBe(0);

            const result = service.forwardAtomically(
                {
                    method: 'project.setIcon',
                    params: {
                        projectId: project.id,
                        icon: { name: 'database', color: 'warning' },
                    },
                },
                'icon-commit',
                (updated) => {
                    database.protocolState.saveReceipt({
                        stateEpoch: identity.stateEpoch,
                        clientId: 'desktop:workbench-1',
                        requestId: 'icon-commit',
                        requestFingerprint: 'a'.repeat(64),
                        method: 'project.setIcon',
                        reply: {
                            protocolVersion: CAXRI_PROTOCOL_VERSION,
                            id: 'icon-commit',
                            ok: true,
                            result: updated,
                        },
                        createdAt: 1,
                    });
                },
            );

            expect(result).toMatchObject({ icon: { name: 'database', color: 'warning' } });
            expect(database.getProject(project.id)?.icon).toEqual({
                name: 'database',
                color: 'warning',
            });
            expect(database.protocolState.changefeedBounds(identity.stateEpoch).count).toBe(1);
            expect(database.protocolState.inspect().commandReceipts).toBe(1);
            expect(deliveries.at(-1)).toMatchObject({
                event: { event: 'state.changed' },
                persistedEnvelope: { cursor: 1, ...identity },
            });
        } finally {
            await service.shutdown();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('atomically finalizes an asynchronous provider rename with its receipt', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-provider-domain-command-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject('/private/provider-project');
        const created = database.createSession(project.id, 'shell', project.rootPath);
        const identity = database.protocolState.identity();
        const providerRename = vi.fn((title: string) => Promise.resolve(`${title} (provider)`));
        const service = new ServerDomainService(dependencies(), (domainDependencies) =>
            Promise.resolve({
                close: () => {
                    database.close();
                    return Promise.resolve();
                },
                handlers: handlers({
                    'session.rename': async (
                        { sessionId, title }: ServerOperationParameters<'session.rename'>,
                        _signal: AbortSignal,
                        finalizeDurably?: <Result>(commit: () => Result) => Result,
                    ) => {
                        const appliedTitle = await providerRename(title);
                        const commit = () => {
                            const updated = database.renameSession(sessionId, appliedTitle);
                            domainDependencies.send({
                                event: 'state.changed',
                                payload: {
                                    kind: 'records',
                                    sessionIds: [sessionId],
                                    terminalIds: [],
                                },
                            });
                            return updated;
                        };
                        return finalizeDurably ? finalizeDurably(commit) : commit();
                    },
                }),
                credentials: createMemoryCredentialStores(),
                protocolRecovery: database.protocolState,
                validateRequestContext: () => {},
            }),
        );
        const deliveries: unknown[] = [];
        service.onEvent((event, persistedEnvelope) =>
            deliveries.push({ event, persistedEnvelope }),
        );

        try {
            await service.start();
            await expect(
                service.forwardWithDurableFinalizer(
                    {
                        method: 'session.rename',
                        params: { sessionId: created.session.id, title: 'Focused work' },
                    },
                    'rename-rollback',
                    () => {
                        throw new Error('receipt write failed');
                    },
                ),
            ).rejects.toThrow('receipt write failed');
            expect(providerRename).toHaveBeenCalledOnce();
            expect(database.getSession(created.session.id)).toMatchObject({
                title: 'Untitled',
                titleMode: 'automatic',
            });
            expect(database.protocolState.changefeedBounds(identity.stateEpoch).count).toBe(0);
            expect(deliveries).toHaveLength(1);

            const result = await service.forwardWithDurableFinalizer(
                {
                    method: 'session.rename',
                    params: { sessionId: created.session.id, title: 'Focused work' },
                },
                'rename-commit',
                (updated) => {
                    database.protocolState.saveReceipt({
                        stateEpoch: identity.stateEpoch,
                        clientId: 'desktop:workbench-1',
                        requestId: 'rename-commit',
                        requestFingerprint: 'b'.repeat(64),
                        method: 'session.rename',
                        reply: {
                            protocolVersion: CAXRI_PROTOCOL_VERSION,
                            id: 'rename-commit',
                            ok: true,
                            result: updated,
                        },
                        createdAt: 1,
                    });
                },
            );

            expect(providerRename).toHaveBeenCalledTimes(2);
            expect(result).toMatchObject({
                title: 'Focused work (provider)',
                titleMode: 'manual',
            });
            expect(database.protocolState.changefeedBounds(identity.stateEpoch).count).toBe(1);
            expect(database.protocolState.inspect().commandReceipts).toBe(1);
            expect(deliveries.at(-1)).toMatchObject({
                event: { event: 'state.changed' },
                persistedEnvelope: { cursor: 1, ...identity },
            });
        } finally {
            await service.shutdown();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
