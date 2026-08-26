import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeMethod } from '@caxri/protocol';
import { CaxriError, internalMethods, methods } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';
import type { RuntimeHandlers } from '../dispatch';
import { createDispatcher } from '../dispatch';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

const runtimeMethodNames = [...Object.keys(methods), ...Object.keys(internalMethods)].toSorted(
    (a, b) => a.localeCompare(b),
) as RuntimeMethod[];

/**
 * Handlers whose only job is to observe dispatch behaviour, independent of real Runtime services.
 */
function stubHandlers(overrides: Partial<Record<RuntimeMethod, unknown>> = {}): RuntimeHandlers {
    const table = Object.fromEntries(runtimeMethodNames.map((method) => [method, () => null]));
    return { ...table, ...overrides } as unknown as RuntimeHandlers;
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
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime handler table', () => {
    it('implements every Renderer-callable and internal Runtime method', async () => {
        const directory = await temporaryDirectory('caxri-handler-table-');
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
        });

        try {
            expect(Object.keys(runtime.handlers).toSorted((a, b) => a.localeCompare(b))).toEqual(
                runtimeMethodNames,
            );
            for (const method of runtimeMethodNames)
                expect(runtime.handlers[method]).toBeTypeOf('function');
        } finally {
            await runtime.close();
        }
    });
});

describe('createDispatcher', () => {
    it('revalidates a typed Workbench Root context before invoking a handler', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-context-');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const handler = vi.fn(() => []);
        const validateContext = vi.fn(() => {
            throw new CaxriError('CONFLICT', 'Workbench Root changed');
        });
        const dispatch = createDispatcher(
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
        ).resolves.toMatchObject({
            ok: false,
            error: { code: 'CONFLICT', message: 'Workbench Root changed' },
        });
        expect(validateContext).toHaveBeenCalledWith({
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects an unknown method and invalid parameters as VALIDATION failures', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-validation-');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const dispatch = createDispatcher(stubHandlers(), logger);

        await expect(dispatch({ id: 'r1', method: 'nope', params: {} })).resolves.toEqual({
            id: 'r1',
            ok: false,
            error: { code: 'VALIDATION', message: 'Unknown Runtime method: nope' },
        });
        const invalid = await dispatch({
            id: 'r2',
            method: 'terminal.resize',
            params: { terminalId: 'terminal-1', cols: 0, rows: 24 },
        });
        expect(invalid).toMatchObject({ id: 'r2', ok: false, error: { code: 'VALIDATION' } });
        const pasteEscape = await dispatch({
            id: 'r3',
            method: 'bugReport.send',
            params: {
                report: 'safe\u{1B}[201~unsafe',
                sessionId: 'session-1',
                terminalId: 'terminal-1',
            },
        });
        expect(pasteEscape).toMatchObject({
            id: 'r3',
            ok: false,
            error: { code: 'VALIDATION' },
        });
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

    it('preserves a handler error code and logs a stack only for unclassified faults', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-errors-');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const dispatch = createDispatcher(
            stubHandlers({
                'terminal.attach': () => {
                    throw new CaxriError('NOT_FOUND', 'Terminal not found');
                },
                'terminal.snapshot': () => {
                    throw new Error('unexpected boom');
                },
            }),
            logger,
        );

        await expect(
            dispatch({ id: 'r1', method: 'terminal.attach', params: { terminalId: 'terminal-1' } }),
        ).resolves.toEqual({
            id: 'r1',
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Terminal not found' },
        });
        await expect(
            dispatch({
                id: 'r2',
                method: 'terminal.snapshot',
                params: { terminalId: 'terminal-1' },
            }),
        ).resolves.toMatchObject({
            ok: false,
            error: { code: 'INTERNAL', message: 'unexpected boom' },
        });
        const records = await logRecords(logger);
        expect(records[0].fields?.stack).toBeNull();
        expect(records[1].fields?.stack).toContain('unexpected boom');
    });

    it('records one boundary log per request except for high-frequency PTY traffic', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-logging-');
        const logger = new StructuredLogger(join(directory, 'logs'));
        const dispatch = createDispatcher(
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
            id: 'r1',
            ok: true,
            result: { ready: true, pid: 123, startedAt: 1, activePtyCount: 0 },
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

        const records = await logRecords(logger);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            event: 'ipc.request',
            correlationId: 'r1',
            fields: { method: 'app.health' },
        });
        expect(records[0].durationMs).toBeTypeOf('number');
    });

    it('cancels an admitted handler and rejects cancellation that arrived before registration', async () => {
        const directory = await temporaryDirectory('caxri-dispatch-cancel-');
        const logger = new StructuredLogger(join(directory, 'logs'));
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
        const dispatch = createDispatcher(stubHandlers({ 'app.health': handler }), logger);

        expect(dispatch.cancel('before-registration')).toBe(true);
        await expect(
            dispatch({ id: 'before-registration', method: 'app.health', params: {} }),
        ).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
        expect(handler).not.toHaveBeenCalled();

        const pending = dispatch({ id: 'active-request', method: 'app.health', params: {} });
        await started.promise;
        expect(dispatch.cancel('active-request')).toBe(true);
        await released.promise;
        await expect(pending).resolves.toMatchObject({
            id: 'active-request',
            ok: false,
            error: { code: 'CANCELLED' },
        });
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
