import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionHostRequest } from '../../../shared/extension-host-protocol';
import { toWireError } from '../../../shared/ipc/errors';
import { StructuredLogger } from '../../../shared/node/logger';
import {
    extensionHostReplyError,
    ExtensionHostSupervisor,
    isExtensionHostMessage,
    isExtensionHostResult,
} from '../supervisor';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));

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
                    operation: 'files.list',
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
        for (const change of [
            { kind: 'content' },
            { kind: 'operation' },
            { kind: 'refresh' },
            { kind: 'create', itemKind: 'file' },
            { kind: 'collapse' },
            { kind: 'search' },
            { kind: 'mode', mode: 'pull-request' },
        ])
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
        expect(isExtensionHostResult('filesChanged', { notified: 1 })).toBe(true);
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
        const supervisor = new ExtensionHostSupervisor({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger: new StructuredLogger('/tmp/caxri-extension-supervisor-test', 'host', 'error'),
            registrations: () => [],
            requestApi: () => Promise.resolve({ repositories: [], refreshedAt: Date.now() }),
        });

        const started = supervisor.start();
        const activated = supervisor.request('activate', {
            extensionId: 'publisher.fixture',
            generation: 1,
            reason: 'onView:publisher.fixture.tree',
        });
        child.emit('message', { type: 'ready' });

        await expect(Promise.all([started, activated])).resolves.toEqual([
            undefined,
            { activated: true },
        ]);
        expect(sent.map(({ method }) => method)).toEqual(['configure', 'activate']);
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
        const supervisor = new ExtensionHostSupervisor({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger: new StructuredLogger('/tmp/caxri-extension-supervisor-test', 'host', 'error'),
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
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            logger: new StructuredLogger('/tmp/caxri-extension-supervisor-test', 'host', 'error'),
            registrations: () => [],
            requestApi: () => Promise.resolve({}),
        });
        const started = supervisor.start();
        child.emit('message', { type: 'ready' });
        await started;

        const mutation = supervisor.request('viewOperation', {
            extensionId: 'publisher.files',
            generation: 1,
            viewId: 'publisher.files.tree',
            operation: 'files.copy',
            arguments: { path: '/project/a.txt', directory: '/project' },
            requestId: 'copy-request',
        });
        await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2));
        await vi.advanceTimersByTimeAsync(15_001);
        expect(child.send).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'cancel' }));
        const mutationRequest = child.send.mock.calls.at(-1)?.[0] as { id: string };
        child.emit('message', { type: 'reply', id: mutationRequest.id, ok: true, result: null });
        await expect(mutation).resolves.toBeNull();

        const read = supervisor.request('viewOperation', {
            extensionId: 'publisher.files',
            generation: 1,
            viewId: 'publisher.files.tree',
            operation: 'files.list',
            arguments: {},
            requestId: 'list-request',
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
            params: { requestId: 'list-request' },
        });
    });
});
