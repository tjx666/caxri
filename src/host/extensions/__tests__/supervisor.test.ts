import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionHostRequest } from '../../../shared/extension-host-protocol';
import { StructuredLogger } from '../../../shared/node/logger';
import {
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
                type: 'event',
                event: 'treeChanged',
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
            }),
        ).toBe(true);
    });

    it('validates successful replies against their request method', () => {
        expect(isExtensionHostResult('activate', { activated: true })).toBe(true);
        expect(isExtensionHostResult('activate', { executed: true })).toBe(false);
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
            getProjectStatus: () => Promise.resolve({ repositories: [], refreshedAt: Date.now() }),
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
            getProjectStatus: () => Promise.resolve({ repositories: [], refreshedAt: Date.now() }),
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
});
