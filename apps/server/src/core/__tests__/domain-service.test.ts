import type { ServerOperation } from '@caxri/protocol';
import { CaxriError, internalMethods, methods } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import type { DomainHandlers, DomainServices } from '../../domains/domain-services';
import type { TerminalExecutionPort } from '../../domains/terminal';
import { ServerDomainService } from '../domain-service';

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
});
