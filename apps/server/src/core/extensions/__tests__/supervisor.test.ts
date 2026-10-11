import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { toWireError } from '@caxri/protocol';
import type { ExtensionHostProtocolFault } from '@caxri/system';
import {
    currentObservationContext,
    extensionHostProtocolFaults,
    logEventCatalog,
    runWithObservationContext,
    StructuredLogger,
} from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionHostRequest } from '../../../extension-host/protocol';
import { extensionHostParentMessageSchema } from '../../../extension-host/protocol';
import { extensionHostProtocolRejectionReasons } from '../../../extension-host/protocol-diagnostics';
import {
    extensionHostReplyError,
    isExtensionHostMessage,
    isExtensionHostResult,
} from '../host-message-validation';
import { ExtensionHostSupervisor } from '../supervisor';

vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal()),
    fork: vi.fn(),
}));

const observationIdentity = {
    bootId: 'b'.repeat(32),
    buildId: 'build-1',
    serverId: 'c'.repeat(32),
    userDataPath: '/tmp/caxri-extension-supervisor-test',
};

afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});

describe('ExtensionHostSupervisor message boundary', () => {
    it('rejects malformed child messages before Host dispatch', () => {
        for (const message of [
            null,
            {},
            { type: 'reply', id: 'request', ok: false },
            { type: 'event', event: 'treeChanged', viewId: 42 },
            {
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'unknown',
            },
            {
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.getProjectStatus',
                observation: { traceId: '/private/project' },
                params: {},
            },
            {
                type: 'event',
                event: 'treeChanged',
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                handles: Array.from({ length: 1_001 }, () => 'handle'),
            },
            {
                type: 'reply',
                id: 'request',
                ok: false,
                error: { code: 'x', message: 'x'.repeat(2_049) },
            },
        ])
            expect(isExtensionHostMessage(message)).toBe(false);
    });

    it('accepts bounded protocol message shapes', () => {
        expect(isExtensionHostMessage({ type: 'ready' })).toBe(true);
        expect(
            isExtensionHostMessage({
                type: 'reply',
                id: 'request',
                ok: false,
                error: { code: 'PROVIDER_FAILED', message: 'failed' },
            }),
        ).toBe(true);
        expect(
            isExtensionHostMessage({
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.request',
                params: { operation: 'files.list', arguments: {} },
            }),
        ).toBe(false);
        expect(
            isExtensionHostMessage({
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.getProjectStatus',
                observation: {
                    operationId: 'extension-operation',
                    requestId: 'control-request',
                    traceId: 'control-trace',
                },
                params: { refreshToken: 'refresh-1' },
            }),
        ).toBe(true);
        expect(
            isExtensionHostMessage({
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.getProjectStatus',
                params: { refreshToken: 'x'.repeat(201) },
            }),
        ).toBe(false);
        expect(
            isExtensionHostMessage({
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.request',
                params: {
                    operation: 'git.summary',
                    arguments: {},
                    context: {
                        kind: 'session',
                        sessionId: 'session-1',
                        workbenchProjectId: 'project-1',
                    },
                },
            }),
        ).toBe(true);
        expect(
            isExtensionHostMessage({
                type: 'api-request',
                id: 'api',
                extensionId: 'publisher.fixture',
                generation: 1,
                apiToken: 'fixture-token-1',
                method: 'workspace.request',
                params: {
                    operation: 'process.shell',
                    arguments: {},
                    context: { kind: 'no-session' },
                },
            }),
        ).toBe(false);
        for (const change of [{ kind: 'content' }, { kind: 'refresh' }])
            expect(
                isExtensionHostMessage({
                    type: 'event',
                    event: 'viewChanged',
                    extensionId: 'publisher.fixture',
                    generation: 1,
                    viewId: 'publisher.fixture.resource',
                    eventId: 'event-1',
                    context: {
                        kind: 'session',
                        sessionId: 'session-1',
                        workbenchProjectId: 'project-1',
                    },
                    change,
                }),
            ).toBe(true);
        expect(
            isExtensionHostMessage({
                type: 'event',
                event: 'viewChanged',
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.resource',
                change: { kind: 'create', itemKind: 'process' },
            }),
        ).toBe(false);
        expect(
            isExtensionHostMessage({
                type: 'event',
                event: 'treeChanged',
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                eventId: 'event-2',
                context: { kind: 'no-session' },
            }),
        ).toBe(true);
    });

    it('validates successful replies against their request method', () => {
        expect(isExtensionHostResult('activate', { activated: true })).toBe(true);
        expect(isExtensionHostResult('activate', { executed: true })).toBe(false);
        expect(isExtensionHostResult('projectStatusChanged', { notified: 1 })).toBe(true);
        expect(isExtensionHostResult('gitChanged', { notified: 1 })).toBe(true);
        expect(isExtensionHostResult('viewOperation', { entries: [] })).toBe(true);
        expect(isExtensionHostResult('viewOperation', [])).toBe(true);
        expect(isExtensionHostResult('viewOperation', null)).toBe(true);
        expect(isExtensionHostResult('viewOperation', 'github.com')).toBe(true);
        expect(isExtensionHostResult('viewOperation', undefined)).toBe(false);
        expect(isExtensionHostResult('viewOperation', 'x'.repeat(4 * 1024 * 1024 + 1))).toBe(false);
        expect(
            isExtensionHostResult('treeChildren', {
                items: [
                    {
                        handle: '1:1',
                        label: 'Item',
                        accessibilityLabel: 'Item',
                        collapsibleState: 'none',
                    },
                ],
            }),
        ).toBe(true);
        expect(isExtensionHostResult('treeChildren', { items: [{ label: 'unbounded' }] })).toBe(
            false,
        );
    });

    it('preserves public transport errors without converting extension lifecycle errors', () => {
        expect(
            toWireError(
                extensionHostReplyError({
                    code: 'VALIDATION',
                    message: 'Invalid regular expression',
                }),
            ),
        ).toEqual({ code: 'VALIDATION', message: 'Invalid regular expression' });
        expect(
            extensionHostReplyError({
                code: 'GENERATION_EXPIRED',
                message: 'Provider generation expired',
            }),
        ).toMatchObject({ code: 'GENERATION_EXPIRED', message: 'Provider generation expired' });
        expect(
            toWireError(
                extensionHostReplyError({
                    code: 'CANCELLED',
                    message: 'View request was cancelled',
                }),
            ),
        ).toEqual({ code: 'CANCELLED', message: 'View request was cancelled' });
    });

    it('waits for registration configure before admitting requests during startup', async () => {
        const sent: ExtensionHostRequest[] = [];
        const apiObservations: unknown[] = [];
        // ChildProcess uses Node's EventEmitter contract; EventTarget cannot represent its message/exit events.
        // eslint-disable-next-line unicorn/prefer-event-target
        const child = Object.assign(new EventEmitter(), {
            connected: true,
            exitCode: null,
            signalCode: null,
            pid: 123,
            kill: vi.fn(() => true),
            send: vi.fn((message: ExtensionHostRequest) => {
                sent.push(message);
                queueMicrotask(() =>
                    child.emit('message', {
                        type: 'reply',
                        id: message.id,
                        ok: true,
                        result:
                            message.method === 'configure'
                                ? { configured: 1 }
                                : { activated: true },
                    }),
                );
                return true;
            }),
        });
        vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
        const logger = new StructuredLogger(
            '/tmp/caxri-extension-supervisor-test',
            'server-core',
            'error',
        );
        const supervisor = new ExtensionHostSupervisor({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger,
            registrations: () => [],
            requestApi: () => {
                apiObservations.push(currentObservationContext());
                return Promise.resolve({ repositories: [], refreshedAt: Date.now() });
            },
        });

        const started = supervisor.start();
        const activated = runWithObservationContext(
            {
                operationId: 'control-operation',
                requestId: 'control-request',
                traceId: 'control-trace',
            },
            () =>
                supervisor.request('activate', {
                    extensionId: 'publisher.fixture',
                    generation: 1,
                    reason: 'onView:publisher.fixture.tree',
                }),
        );
        child.emit('message', { type: 'ready' });

        await expect(Promise.all([started, activated])).resolves.toEqual([
            undefined,
            { activated: true },
        ]);
        const launchEnvironment = (
            vi.mocked(fork).mock.calls[0][2] as {
                env: NodeJS.ProcessEnv;
            }
        ).env;
        expect(launchEnvironment).toMatchObject({
            CAXRI_BUILD_ID: observationIdentity.buildId,
            CAXRI_SERVER_BOOT_ID: observationIdentity.bootId,
            CAXRI_SERVER_ID: observationIdentity.serverId,
            CAXRI_USER_DATA_PATH: observationIdentity.userDataPath,
        });
        expect(sent.map(({ method }) => method)).toEqual(['configure', 'activate']);
        expect(sent[1].observation).toEqual({
            operationId: sent[1].id,
            requestId: 'control-request',
            traceId: 'control-trace',
        });

        child.emit('message', {
            type: 'api-request',
            id: 'extension-api-request',
            extensionId: 'publisher.fixture',
            generation: 1,
            apiToken: 'fixture-token-1',
            method: 'workspace.getProjectStatus',
            observation: {
                operationId: 'extension-api-request',
                requestId: 'control-request',
                traceId: 'control-trace',
            },
            params: {},
        });
        await vi.waitFor(() => expect(apiObservations).toHaveLength(1));
        expect(apiObservations[0]).toEqual({
            operationId: 'extension-api-request',
            requestId: 'control-request',
            traceId: 'control-trace',
        });
    });

    it('opens a circuit after bounded consecutive crash restarts', async () => {
        vi.useFakeTimers();
        const children: Array<EventEmitter & ChildProcess> = [];
        vi.mocked(fork).mockImplementation(() => {
            // ChildProcess uses Node's EventEmitter contract; this fake exercises only owned IPC lifecycle.
            // eslint-disable-next-line unicorn/prefer-event-target
            const child = Object.assign(new EventEmitter(), {
                connected: true,
                exitCode: null,
                signalCode: null,
                pid: 100 + children.length,
                kill: vi.fn(() => true),
                send: vi.fn((message: ExtensionHostRequest) => {
                    if (message.method === 'configure')
                        queueMicrotask(() =>
                            child.emit('message', {
                                type: 'reply',
                                id: message.id,
                                ok: true,
                                result: { configured: 0 },
                            }),
                        );
                    return true;
                }),
            }) as unknown as EventEmitter & ChildProcess;
            children.push(child);
            return child;
        });
        const logger = new StructuredLogger(
            '/tmp/caxri-extension-supervisor-test',
            'server-core',
            'error',
        );
        const supervisor = new ExtensionHostSupervisor({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger,
            registrations: () => [],
            requestApi: () => Promise.resolve({ repositories: [], refreshedAt: Date.now() }),
        });

        const initialStart = supervisor.start();
        children[0].emit('message', { type: 'ready' });
        await initialStart;
        for (const delay of [250, 500, 1_000, 2_000, 2_000]) {
            children.at(-1)!.emit('exit', 1);
            // Restarts are intentionally serialized so each synthetic child reaches ready before crashing.
            // eslint-disable-next-line no-await-in-loop
            await vi.advanceTimersByTimeAsync(delay);
            children.at(-1)!.emit('message', { type: 'ready' });
            // eslint-disable-next-line no-await-in-loop
            await vi.advanceTimersByTimeAsync(0);
        }

        children.at(-1)!.emit('exit', 1);
        await vi.advanceTimersByTimeAsync(10_000);

        expect(fork).toHaveBeenCalledTimes(6);
        expect(logger.metricSnapshot().series).toContainEqual({
            average: 1,
            count: 5,
            labels: { owner: 'extension-host', phase: 'startup', outcome: 'restart' },
            last: 1,
            maximum: 1,
            minimum: 1,
            name: 'process.restarts',
            total: 5,
        });
        await expect(supervisor.start()).rejects.toMatchObject({
            code: 'EXTENSION_HOST_UNAVAILABLE',
        });
        await supervisor.shutdown();
    });

    it('does not abandon durable view mutations and cancels timed view reads', async () => {
        vi.useFakeTimers();
        // ChildProcess uses Node's EventEmitter contract; this fake exercises the request timeout boundary only.
        // eslint-disable-next-line unicorn/prefer-event-target
        const child = Object.assign(new EventEmitter(), {
            connected: true,
            exitCode: null,
            signalCode: null,
            pid: 321,
            kill: vi.fn(() => true),
            send: vi.fn((message: ExtensionHostRequest) => {
                if (message.method === 'configure')
                    queueMicrotask(() =>
                        child.emit('message', {
                            type: 'reply',
                            id: message.id,
                            ok: true,
                            result: { configured: 0 },
                        }),
                    );
                return true;
            }),
        });
        vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
        const supervisor = new ExtensionHostSupervisor({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger: new StructuredLogger(
                '/tmp/caxri-extension-supervisor-test',
                'server-core',
                'error',
            ),
            registrations: () => [],
            requestApi: () => Promise.resolve({}),
        });
        const started = supervisor.start();
        child.emit('message', { type: 'ready' });
        await started;

        const mutation = supervisor.request('viewOperation', {
            extensionId: 'publisher.git',
            generation: 1,
            viewId: 'publisher.git.sourceControl',
            operation: 'source.action',
            arguments: { actionId: 'action-1', revision: '1' },
            requestId: 'sync-request',
        });
        await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(15_001);
        expect(child.send).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'cancel' }));
        const mutationRequest = child.send.mock.calls.at(-1)?.[0] as { id: string };
        child.emit('message', { type: 'reply', id: mutationRequest.id, ok: true, result: null });
        await expect(mutation).resolves.toBeNull();

        const read = supervisor.request('viewOperation', {
            extensionId: 'publisher.git',
            generation: 1,
            viewId: 'publisher.git.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId: 'summary-request',
        });
        const readFailure = expect(read).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
        await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(3));
        await vi.advanceTimersByTimeAsync(15_000);
        await readFailure;
        const cancelRequest = child.send.mock.calls
            .map(([message]) => message)
            .find((message) => message.method === 'cancel');
        expect(cancelRequest?.id).toBeTypeOf('string');
        expect(cancelRequest).toMatchObject({
            method: 'cancel',
            params: { requestId: 'summary-request' },
        });
    });
});

describe('Acceptance protocol fault injection', () => {
    function createRespondingChild() {
        // ChildProcess uses Node's EventEmitter contract; EventTarget cannot represent its message/exit events.
        // eslint-disable-next-line unicorn/prefer-event-target
        const child = Object.assign(new EventEmitter(), {
            connected: true,
            exitCode: null,
            signalCode: null,
            pid: 321,
            kill: vi.fn(() => true),
            send: vi.fn((message: ExtensionHostRequest | { type: string }) => {
                if (!('method' in message)) return true;
                queueMicrotask(() =>
                    child.emit('message', {
                        type: 'reply',
                        id: message.id,
                        ok: true,
                        result:
                            message.method === 'configure'
                                ? { configured: 1 }
                                : { activated: true },
                    }),
                );
                return true;
            }),
        });
        return child;
    }

    async function startWithFaults(protocolFaults: ExtensionHostProtocolFault[]) {
        const child = createRespondingChild();
        vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
        const logger = new StructuredLogger(
            '/tmp/caxri-extension-supervisor-test',
            'server-core',
            'error',
        );
        const rejectionReasons: string[] = [];
        vi.spyOn(logger, 'write').mockImplementation((_level, event, payload) => {
            if (event !== logEventCatalog.extensionHost.invalidMessage) return;
            rejectionReasons.push((payload as { fields: { reason: string } }).fields.reason);
        });
        const supervisor = new ExtensionHostSupervisor({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger,
            protocolFaults,
            registrations: () => [],
            requestApi: () => Promise.resolve({}),
        });
        const started = supervisor.start();
        child.emit('message', { type: 'ready' });
        await started;
        return { child, rejectionReasons };
    }

    it('records no rejection and sends no fault envelope without an admitted sequence', async () => {
        const { child, rejectionReasons } = await startWithFaults([]);

        expect(rejectionReasons).toEqual([]);
        expect(child.send.mock.calls.some(([message]) => !('method' in (message as object)))).toBe(
            false,
        );
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('classifies an injected malformed child envelope and stops the Host', async () => {
        const { child, rejectionReasons } = await startWithFaults(['child-envelope']);

        expect(rejectionReasons).toEqual(['child-envelope']);
        expect(child.kill).toHaveBeenCalled();
    });

    it('classifies an injected invalid reply payload against a real reply', async () => {
        const { child, rejectionReasons } = await startWithFaults(['reply-result']);

        await vi.waitFor(() => expect(rejectionReasons).toEqual(['reply-result']));
        expect(child.kill).toHaveBeenCalled();
    });

    it('delivers a malformed parent envelope over the live channel for the Host to classify', async () => {
        const { child, rejectionReasons } = await startWithFaults(['parent-envelope']);

        const faultEnvelopes = child.send.mock.calls
            .map(([message]) => message)
            .filter((message) => !('method' in (message as object)));
        expect(faultEnvelopes).toHaveLength(1);
        // The envelope only produces `parent-envelope` if the Host's own parent schema rejects it, so assert that
        // rejection here rather than the weaker claim that some non-request message was sent.
        expect(extensionHostParentMessageSchema.safeParse(faultEnvelopes[0]).success).toBe(false);
        // The Host owns this classification; the supervisor must not log the child's reason for it.
        expect(rejectionReasons).toEqual([]);
    });

    it('corrupts the reply with a payload every request method rejects', () => {
        // `viewOperation` accepts any serializable payload, `null` included, so only `undefined` makes the injected
        // `reply-result` reason independent of which in-flight request answers first.
        for (const method of [
            'configure',
            'activate',
            'treeChildren',
            'viewOperation',
            'executeCommand',
            'activeContextChanged',
            'gitChanged',
            'projectStatusChanged',
            'cancel',
            'shutdown',
        ] as const)
            expect(isExtensionHostResult(method, undefined)).toBe(false);
        expect(isExtensionHostResult('viewOperation', null)).toBe(true);
    });

    it('keeps the Acceptance fault sequence aligned with the logged rejection reasons', () => {
        expect([...extensionHostProtocolFaults]).toEqual([
            ...extensionHostProtocolRejectionReasons,
        ]);
    });
});
