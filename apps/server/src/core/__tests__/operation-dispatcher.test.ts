import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerOperation } from '@caxri/protocol';
import { CaxriError, desktopServerOperationIds, internalMethods, methods } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import type { DomainHandlers, DomainOperation } from '../../domains/domain-services';
import { createOperationDispatcher } from '../operation-dispatcher';
import { runAsControlLoggedRequest } from '../request-observability';

const loggers: StructuredLogger[] = [];
const temporaryDirectories: string[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

const delegatedByMain = new Set<string>(desktopServerOperationIds);

/**
 * Runtime mirror of `DomainOperation`: Server-owned and internal methods plus the Desktop-owned ones Main delegates.
 */
const domainOperationNames = [
    ...Object.entries(methods)
        .filter(([method, spec]) => spec.owner === 'server' || delegatedByMain.has(method))
        .map(([method]) => method),
    ...Object.keys(internalMethods),
].toSorted((a, b) => a.localeCompare(b)) as DomainOperation[];

/**
 * Handlers whose only job is to observe dispatch behaviour, independent of real domain services.
 */
function stubHandlers(overrides: Partial<Record<ServerOperation, unknown>> = {}): DomainHandlers {
    const table = Object.fromEntries(domainOperationNames.map((method) => [method, () => null]));
    return { ...table, ...overrides } as unknown as DomainHandlers;
}

/**
 * Request completion does not imply that buffered log records are durable yet.
 */
async function logRecords(logger: StructuredLogger) {
    await logger.flush();
    const source = (await readFile(logger.path, 'utf8')).trim();
    return source
        ? source.split('\n').map(
              (line) =>
                  JSON.parse(line) as {
                      event: string;
                      correlationId?: string;
                      durationMs?: number;
                      fields?: Record<string, string | number | boolean | null>;
                  },
          )
        : [];
}

afterEach(async () => {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('domain handler table', () => {
    it('implements every domain operation and no Main-answered method', async () => {
        const directory = await temporaryDirectory('caxri-handler-table-');
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: createLogger(join(directory, 'logs')),
            send: () => {},
        });

        try {
            expect(Object.keys(runtime.handlers).toSorted((a, b) => a.localeCompare(b))).toEqual(
                domainOperationNames,
            );
            for (const method of domainOperationNames)
                expect(runtime.handlers[method]).toBeTypeOf('function');
            expect(Object.hasOwn(runtime.handlers, 'external.open')).toBe(false);
        } finally {
            await runtime.close();
        }
    });
});

describe('createOperationDispatcher', () => {
    it('exposes stable direct-call results without a wire response envelope', async () => {
        const directory = await temporaryDirectory('caxri-operation-dispatch-');
        const logger = createLogger(join(directory, 'logs'));
        const dispatch = createOperationDispatcher(
            stubHandlers({
                'app.health': () => ({
                    ready: true,
                    pid: 123,
                    startedAt: 1,
                    activePtyCount: 0,
                }),
                'terminal.attach': () => {
                    throw new CaxriError('NOT_FOUND', 'Terminal not found');
                },
            }),
            logger,
        );

        await expect(
            dispatch({ id: 'direct-1', method: 'app.health', params: {} }),
        ).resolves.toEqual({ ready: true, pid: 123, startedAt: 1, activePtyCount: 0 });
        await expect(
            dispatch({
                id: 'direct-2',
                method: 'terminal.attach',
                params: { terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Terminal not found' });
    });

    it('revalidates a typed Workbench Root context before invoking a handler', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-context-');
        const logger = createLogger(join(directory, 'logs'));
        const handler = vi.fn(() => []);
        const validateContext = vi.fn(() => {
            throw new CaxriError('CONFLICT', 'Workbench Root changed');
        });
        const dispatch = createOperationDispatcher(
            stubHandlers({ 'files.list': handler }),
            logger,
            validateContext,
        );

        await expect(
            dispatch({
                context: { sessionId: 'session-1', workbenchProjectId: 'project-1' },
                id: 'r-context',
                method: 'files.list',
                params: { sessionId: 'session-1' },
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Workbench Root changed' });
        expect(validateContext).toHaveBeenCalledWith({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects an unknown method and invalid parameters as VALIDATION failures', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-validation-');
        const logger = createLogger(join(directory, 'logs'));
        const dispatch = createOperationDispatcher(stubHandlers(), logger);

        await expect(dispatch({ id: 'r1', method: 'nope', params: {} })).rejects.toMatchObject({
            code: 'VALIDATION',
            message: 'Unknown Runtime method: nope',
        });
        await expect(
            dispatch({
                id: 'r2',
                method: 'terminal.resize',
                params: { terminalId: 'terminal-1', cols: 0, rows: 24 },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(
            dispatch({
                id: 'r3',
                method: 'bugReport.send',
                params: {
                    report: 'safe\u{1B}[201~unsafe',
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        const records = await logRecords(logger);
        expect(records.map((record) => record.event)).toEqual([
            'ipc.request_failed',
            'ipc.request_failed',
            'ipc.request_failed',
        ]);
        expect(records[0]).toMatchObject({
            correlationId: 'r1',
            fields: { method: 'nope', code: 'VALIDATION', stack: null },
        });
        expect(records[0].durationMs).toBeTypeOf('number');
    });

    it('rejects a Main-answered method with a clear CONFLICT instead of crashing', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-main-owned-');
        const logger = createLogger(join(directory, 'logs'));
        const dispatch = createOperationDispatcher(stubHandlers(), logger);

        await expect(
            dispatch({ id: 'r-main', method: 'updates.getState', params: {} }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
            message: 'updates.getState must be handled by Electron Main',
        });
        const [record] = await logRecords(logger);
        expect(record).toMatchObject({
            event: 'ipc.request_failed',
            correlationId: 'r-main',
            fields: { method: 'updates.getState', code: 'CONFLICT', stack: null },
        });
    });

    it('preserves handler error codes and logs a stack only for unclassified faults', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-errors-');
        const logger = createLogger(join(directory, 'logs'));
        const dispatch = createOperationDispatcher(
            stubHandlers({
                'terminal.attach': () => {
                    throw new CaxriError('NOT_FOUND', 'Terminal not found');
                },
                'terminal.snapshot': () => {
                    throw new Error('unexpected boom');
                },
                'logs.query': () => {
                    throw new CaxriError('IO', 'Log query failed');
                },
                'files.read': () => {
                    throw new CaxriError('NOT_FOUND', 'Requested path no longer exists');
                },
            }),
            logger,
        );

        await expect(
            dispatch({ id: 'r1', method: 'terminal.attach', params: { terminalId: 'terminal-1' } }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Terminal not found' });
        await expect(
            dispatch({
                id: 'r2',
                method: 'terminal.snapshot',
                params: { terminalId: 'terminal-1' },
            }),
        ).rejects.toMatchObject({ code: 'INTERNAL', message: 'unexpected boom' });
        await expect(
            dispatch({ id: 'r3', method: 'logs.query', params: { limit: 100 } }),
        ).rejects.toMatchObject({ code: 'IO', message: 'Log query failed' });
        await expect(
            dispatch({
                id: 'r4',
                method: 'files.read',
                params: { sessionId: 'session-1', path: 'a.ts' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const records = await logRecords(logger);
        expect(records[0]).toMatchObject({ level: 'error', fields: { code: 'NOT_FOUND' } });
        expect(records[3]).toMatchObject({
            level: 'warn',
            correlationId: 'r4',
            fields: { method: 'files.read', code: 'NOT_FOUND' },
        });
        expect(records[0].fields?.stack).toBeNull();
        expect(records[1].fields?.stack).toContain('unexpected boom');
        expect(records[2]).toMatchObject({
            event: 'ipc.request_failed',
            correlationId: 'r3',
            fields: { method: 'logs.query', code: 'IO' },
        });
    });

    it('records one boundary log except for high-frequency traffic and self-observing log reads', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-logging-');
        const logger = createLogger(join(directory, 'logs'));
        const dispatch = createOperationDispatcher(
            stubHandlers({
                'app.health': () => ({
                    ready: true,
                    pid: 123,
                    startedAt: 1,
                    activePtyCount: 0,
                }),
            }),
            logger,
        );

        await expect(dispatch({ id: 'r1', method: 'app.health', params: {} })).resolves.toEqual({
            ready: true,
            pid: 123,
            startedAt: 1,
            activePtyCount: 0,
        });
        await dispatch({
            id: 'r2',
            method: 'terminal.input',
            params: { terminalId: 'terminal-1', data: 'ls\r' },
        });
        await dispatch({
            id: 'r3',
            method: 'terminal.resize',
            params: { terminalId: 'terminal-1', cols: 100, rows: 30 },
        });
        await dispatch({ id: 'r4', method: 'logs.query', params: { limit: 100 } });

        const records = await logRecords(logger);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            event: 'ipc.request',
            correlationId: 'r1',
            fields: { method: 'app.health' },
        });
        expect(records[0].durationMs).toBeTypeOf('number');
    });

    it("leaves a control request's success to the control boundary but logs a nested different method", async () => {
        const directory = await temporaryDirectory('caxri-dispatch-control-logged-');
        const logger = createLogger(join(directory, 'logs'));
        const health = { ready: true, pid: 123, startedAt: 1, activePtyCount: 0 };
        const dispatch = createOperationDispatcher(
            stubHandlers({ 'app.health': () => health }),
            logger,
        );

        await runAsControlLoggedRequest('app.health', () =>
            dispatch({ id: 'control-owned', method: 'app.health', params: {} }),
        );
        await runAsControlLoggedRequest('session.select', () =>
            dispatch({ id: 'nested', method: 'app.health', params: {} }),
        );

        expect(await logRecords(logger)).toEqual([
            expect.objectContaining({ event: 'ipc.request', correlationId: 'nested' }),
        ]);
    });

    it('cancels an admitted handler and rejects cancellation that arrived before registration', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-cancel-');
        const logger = createLogger(join(directory, 'logs'));
        const started = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const handler = vi.fn(async (_parameters: unknown, signal: AbortSignal) => {
            started.resolve();
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
            });
            released.resolve();
            signal.throwIfAborted();
        });
        const dispatch = createOperationDispatcher(stubHandlers({ 'app.health': handler }), logger);

        expect(dispatch.cancel('before-registration')).toBe(true);
        await expect(
            dispatch({ id: 'before-registration', method: 'app.health', params: {} }),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(handler).not.toHaveBeenCalled();

        const pending = dispatch({ id: 'active-request', method: 'app.health', params: {} });
        await started.promise;
        expect(dispatch.cancel('active-request')).toBe(true);
        await released.promise;
        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(await logRecords(logger)).toEqual([
            expect.objectContaining({
                event: 'ipc.request',
                correlationId: 'before-registration',
                fields: { method: 'app.health', code: 'CANCELLED' },
            }),
            expect.objectContaining({
                event: 'ipc.request',
                correlationId: 'active-request',
                fields: { method: 'app.health', code: 'CANCELLED' },
            }),
        ]);
    });
});

describe('delegation request correlation', () => {
    it('names the delegation in ipc.request fields without logging the task input', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-delegation-');
        const logger = createLogger(join(directory, 'logs'));
        const principal = { kind: 'human-cli', id: 'synthetic-owner' };
        const dispatch = createOperationDispatcher(
            stubHandlers({
                'agent.delegation.stopInternal': () => {
                    throw new CaxriError('NOT_FOUND', 'Agent delegation is unavailable');
                },
            }),
            logger,
        );

        await dispatch({
            id: 'create-request',
            method: 'agent.delegation.createInternal',
            params: {
                principal,
                delegationId: 'delegation-created',
                input: {
                    projectId: 'project-1',
                    sessionId: 'session-1',
                    provider: 'claude',
                    prompt: 'synthetic-private-prompt',
                },
            },
        });
        await dispatch({
            id: 'status-request',
            method: 'agent.delegation.statusInternal',
            params: { principal, delegationId: 'delegation-read' },
        });
        /**
         * The failure below is an `error` record, which flushes synchronously; draining first keeps this test about
         * request fields rather than the ordering of an async drain racing that synchronous flush.
         */
        await logger.flush();
        await expect(
            dispatch({
                id: 'stop-request',
                method: 'agent.delegation.stopInternal',
                params: { principal, delegationId: 'delegation-missing' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await dispatch({ id: 'health-request', method: 'app.health', params: {} });

        const records = await logRecords(logger);
        expect(
            records.map(({ correlationId, event, fields }) => [correlationId, event, fields]),
        ).toEqual([
            [
                'create-request',
                'ipc.request',
                { method: 'agent.delegation.createInternal', delegationId: 'delegation-created' },
            ],
            [
                'status-request',
                'ipc.request',
                { method: 'agent.delegation.statusInternal', delegationId: 'delegation-read' },
            ],
            [
                'stop-request',
                'ipc.request_failed',
                expect.objectContaining({
                    method: 'agent.delegation.stopInternal',
                    code: 'NOT_FOUND',
                    delegationId: 'delegation-missing',
                }),
            ],
            ['health-request', 'ipc.request', { method: 'app.health' }],
        ]);
        expect(JSON.stringify(records)).not.toContain('synthetic-private-prompt');
    });
});
