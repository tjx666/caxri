import { CAXRI_PROTOCOL_VERSION, CaxriError, logEventCatalog } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import type { ControlServerOptions } from '../control-server-support';
import {
    executeReply,
    fileSystemCode,
    isTokenMatch,
    logControlRequestOutcome,
    observationContextForRequest,
    operatorContext,
    terminateSocket,
} from '../control-server-support';

type ControlRequestLogEvent = Parameters<NonNullable<ControlServerOptions['logger']>['write']>[1];
type ControlRequestLogWrite = Parameters<NonNullable<ControlServerOptions['logger']>['write']>;

describe('Host request log sink', () => {
    it('accepts only registered event names', () => {
        const registeredEvent: ControlRequestLogEvent = logEventCatalog.ipc.request;
        // @ts-expect-error -- Server log sinks must reject events outside the canonical registry.
        const unregisteredEvent: ControlRequestLogEvent = 'ipc.request_typo';

        expect(registeredEvent).toBe('ipc.request');
        expect(unregisteredEvent).toBe('ipc.request_typo');
    });

    it('records request cancellation as non-fault control flow', () => {
        const writes: ControlRequestLogWrite[] = [];

        logControlRequestOutcome(
            {
                logger: {
                    write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
                },
            },
            { id: 'cancelled-view', method: 'viewContainers.viewOperation' },
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'cancelled-view',
                ok: false,
                error: { code: 'CANCELLED', message: 'View request was cancelled' },
            },
            operatorContext('profile-1'),
            performance.now(),
            undefined,
        );

        expect(writes).toHaveLength(1);
        expect(writes[0]?.[0]).toBe('debug');
        expect(writes[0]?.[1]).toBe(logEventCatalog.ipc.request);
        expect(writes[0]?.[2]?.fields).toMatchObject({ code: 'CANCELLED' });
    });

    it('logs a noticeable queue wait at info and names the blocking request', () => {
        const writes: ControlRequestLogWrite[] = [];
        const request = { id: 'select-1', method: 'session.select' };

        logControlRequestOutcome(
            {
                logger: {
                    write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
                },
            },
            request,
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: request.id,
                ok: true,
                result: {},
            },
            operatorContext('profile-1'),
            performance.now(),
            {
                enqueuedAt: performance.now() - 400,
                queueDepth: 3,
                blockedBy: { method: 'git.sync', overlapMs: 380.4, requestId: 'sync-9' },
            },
        );

        expect(writes).toHaveLength(1);
        expect(writes[0]?.[0]).toBe('info');
        expect(writes[0]?.[2]?.fields).toMatchObject({
            blockedByMethod: 'git.sync',
            blockedByRequestId: 'sync-9',
            blockedByOverlapMs: 380,
        });
    });

    it('keeps a short queue wait at debug without blocker fields', () => {
        const writes: ControlRequestLogWrite[] = [];
        const request = { id: 'select-2', method: 'session.select' };

        logControlRequestOutcome(
            {
                logger: {
                    write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
                },
            },
            request,
            { protocolVersion: CAXRI_PROTOCOL_VERSION, id: request.id, ok: true, result: {} },
            operatorContext('profile-1'),
            performance.now(),
            { enqueuedAt: performance.now() - 20, queueDepth: 1 },
        );

        expect(writes[0]?.[0]).toBe('debug');
        expect(writes[0]?.[2]?.fields).not.toHaveProperty('blockedByMethod');
    });

    it('keeps successful log reads out of their own source while retaining metrics and failures', () => {
        const writes: ControlRequestLogWrite[] = [];
        const metrics: unknown[][] = [];
        const options = {
            logger: {
                write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
                recordMetric: (...arguments_: unknown[]) => metrics.push(arguments_),
            },
        };
        const request = { id: 'logs-query', method: 'logs.query' };
        const context = operatorContext('profile-1');

        logControlRequestOutcome(
            options,
            request,
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: request.id,
                ok: true,
                result: { records: [], gap: false, truncated: false },
            },
            context,
            performance.now(),
            undefined,
        );
        expect(writes).toEqual([]);
        expect(metrics).toEqual([
            [
                'logs.query_latency',
                expect.any(Number),
                { owner: 'control', phase: 'execute', outcome: 'success' },
            ],
            [
                'queue.wait',
                expect.any(Number),
                { owner: 'control', phase: 'admission', outcome: 'success' },
            ],
        ]);

        logControlRequestOutcome(
            options,
            request,
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: request.id,
                ok: false,
                error: { code: 'IO', message: 'Log query failed' },
            },
            context,
            performance.now(),
            undefined,
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]?.[1]).toBe(logEventCatalog.ipc.requestFailed);
        expect(writes[0]?.[2]?.fields).toMatchObject({ method: 'logs.query', code: 'IO' });
        expect(metrics.slice(2)).toEqual([
            [
                'logs.query_latency',
                expect.any(Number),
                { owner: 'control', phase: 'execute', outcome: 'failure' },
            ],
            [
                'queue.wait',
                expect.any(Number),
                { owner: 'control', phase: 'admission', outcome: 'failure' },
            ],
        ]);
    });

    it('derives opaque correlation and bounded metrics without retaining command content', () => {
        const writes: ControlRequestLogWrite[] = [];
        const metrics: unknown[][] = [];
        const context = {
            ...operatorContext('profile-1'),
            connection: {
                serverId: 'a'.repeat(32),
                bootId: 'b'.repeat(32),
                stateEpoch: 'c'.repeat(32),
                clientId: 'client-1',
                connectionId: 'd'.repeat(32),
            },
        };
        const request = {
            id: 'request-1',
            method: 'files.write',
            params: {
                content: 'do-not-log-source',
                path: '/private/project/secret.ts',
                sessionId: 'session-1',
            },
        };

        expect(observationContextForRequest(request, context)).toEqual({
            bootId: 'b'.repeat(32),
            clientId: 'client-1',
            connectionId: 'd'.repeat(32),
            requestId: 'request-1',
            serverId: 'a'.repeat(32),
            sessionId: 'session-1',
            traceId: 'request-1',
        });

        logControlRequestOutcome(
            {
                logger: {
                    write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
                    recordMetric: (...arguments_: unknown[]) => metrics.push(arguments_),
                },
            },
            request,
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'request-1',
                ok: false,
                error: { code: 'UNAVAILABLE', message: 'Server Core is unavailable' },
            },
            context,
            performance.now(),
            { enqueuedAt: performance.now(), queueDepth: 3 },
        );

        expect(writes[0]?.[2]).toMatchObject({
            context: { requestId: 'request-1', sessionId: 'session-1' },
            failure: {
                owner: 'control',
                reason: 'core-unavailable',
                remediation: 'restart-core',
            },
        });
        expect(metrics).toHaveLength(2);
        expect(JSON.stringify(writes)).not.toContain('do-not-log-source');
        expect(JSON.stringify(writes)).not.toContain('/private/project/secret.ts');
    });
});

describe('delegation request correlation', () => {
    it('names the delegation a Commander CLI call concerns in ipc.request fields', () => {
        const writes: ControlRequestLogWrite[] = [];
        const options = {
            logger: { write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_) },
        };
        const context = operatorContext('profile-1');
        const receipt = {
            delegationId: 'delegation-created',
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'claude',
            status: 'requested',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        };

        logControlRequestOutcome(
            options,
            {
                id: 'create-request',
                method: 'agent.delegation.create',
                params: {
                    projectId: 'project-1',
                    sessionId: 'session-1',
                    provider: 'claude',
                    prompt: 'synthetic-private-prompt',
                },
            },
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'create-request',
                ok: true,
                result: receipt,
            },
            context,
            performance.now(),
            undefined,
        );
        logControlRequestOutcome(
            options,
            {
                id: 'wait-request',
                method: 'agent.delegation.wait',
                params: { delegationId: 'delegation-waited', timeoutMs: 1_000 },
            },
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'wait-request',
                ok: true,
                result: {
                    outcome: 'settled',
                    receipt: { ...receipt, delegationId: 'delegation-other' },
                    answer: { text: 'synthetic-private-answer' },
                },
            },
            context,
            performance.now(),
            undefined,
        );
        logControlRequestOutcome(
            options,
            {
                id: 'stop-request',
                method: 'agent.delegation.stop',
                params: { delegationId: 'delegation-missing' },
            },
            {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'stop-request',
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Agent delegation is unavailable' },
            },
            context,
            performance.now(),
            undefined,
        );

        expect(writes.map(([, event, entry]) => [event, entry?.fields?.delegationId])).toEqual([
            [logEventCatalog.ipc.request, 'delegation-created'],
            [logEventCatalog.ipc.request, 'delegation-waited'],
            [logEventCatalog.ipc.requestFailed, 'delegation-missing'],
        ]);
        expect(JSON.stringify(writes)).not.toContain('synthetic-private-prompt');
        expect(JSON.stringify(writes)).not.toContain('synthetic-private-answer');
    });
});

describe('terminateSocket', () => {
    it('terminates the socket and logs the given reason', () => {
        const writes: ControlRequestLogWrite[] = [];
        // `socket` is typed as `WebSocket`, so referencing `socket.terminate` directly trips
        // `@typescript-eslint/unbound-method`; assert on the mock function itself instead.
        const terminate = vi.fn();
        const socket = { terminate } as unknown as WebSocket;

        terminateSocket(socket, 'handshake-timeout', {
            write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_),
        });

        expect(terminate).toHaveBeenCalledTimes(1);
        expect(writes).toHaveLength(1);
        expect(writes[0]?.[0]).toBe('info');
        expect(writes[0]?.[1]).toBe(logEventCatalog.serverCore.socketTerminated);
        expect(writes[0]?.[2]?.fields).toEqual({ reason: 'handshake-timeout' });
    });

    it('terminates the socket without logging when no logger is given', () => {
        const terminate = vi.fn();
        const socket = { terminate } as unknown as WebSocket;

        expect(() => terminateSocket(socket, 'server-closing')).not.toThrow();
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('attaches the connection identity as context when the caller has one', () => {
        const writes: ControlRequestLogWrite[] = [];
        const socket = { terminate: vi.fn() } as unknown as WebSocket;
        const context = {
            ...operatorContext('profile-1'),
            connection: {
                serverId: 'a'.repeat(32),
                bootId: 'b'.repeat(32),
                stateEpoch: 'c'.repeat(32),
                clientId: 'client-1',
                connectionId: 'd'.repeat(32),
            },
        };

        terminateSocket(
            socket,
            'invalid-message',
            { write: (...arguments_: ControlRequestLogWrite) => writes.push(arguments_) },
            context,
        );

        expect(writes[0]?.[2]?.context).toEqual({
            bootId: 'b'.repeat(32),
            clientId: 'client-1',
            connectionId: 'd'.repeat(32),
            serverId: 'a'.repeat(32),
        });
    });
});

describe('isTokenMatch', () => {
    it('accepts two equal tokens', () => {
        expect(isTokenMatch('shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects tokens of the same length that differ', () => {
        expect(isTokenMatch('shared-secreu', 'shared-secret')).toBe(false);
    });

    it('rejects tokens of different lengths without throwing', () => {
        expect(isTokenMatch('short', 'a-much-longer-candidate-token')).toBe(false);
    });

    it('rejects an empty candidate against a real token', () => {
        expect(isTokenMatch('', 'shared-secret')).toBe(false);
    });
});

describe('operatorContext', () => {
    it('grants the fixed operator capability set for the authenticated profile', () => {
        const context = operatorContext('profile-1');

        expect(context.principal).toEqual({ kind: 'human-cli', id: 'human-cli:profile-1' });
        expect(context.capabilities).toEqual(
            expect.arrayContaining([
                'desktop.window',
                'diagnostics.read',
                'agents.read',
                'agents.control',
                'agents.dispatch',
                'agents.delegate',
                'agents.grant',
                'events.read',
                'host.read',
                'host.stop',
                'projects.read',
                'projects.write',
                'sessions.read',
                'settings.read',
                'settings.write',
                'terminals.read',
                'terminals.steer',
            ]),
        );
        /**
         * Every capability in the list is intentional; an unexpected extra would silently widen what a human-CLI
         * connection can do.
         */
        expect(context.capabilities).toContain('settings.delegation.write');
        expect(context.capabilities).toContain('agents.delegation.access');
        expect(context.capabilities).toContain('commander');
        expect(context.capabilities).toHaveLength(20);
    });

    it('derives the principal id from the profile id it is given', () => {
        expect(operatorContext('another-profile').principal).toEqual({
            kind: 'human-cli',
            id: 'human-cli:another-profile',
        });
    });
});

describe('executeReply', () => {
    it('wraps a resolved action as a successful reply envelope', async () => {
        await expect(executeReply('req-1', () => Promise.resolve({ value: 42 }))).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-1',
            ok: true,
            result: { value: 42 },
        });
    });

    it('reports a successful action that resolves to undefined', async () => {
        await expect(executeReply('req-2', () => Promise.resolve(undefined))).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-2',
            ok: true,
            result: undefined,
        });
    });

    it('shapes a rejected CaxriError into the wire error format', async () => {
        await expect(
            executeReply('req-3', () =>
                Promise.reject(
                    new CaxriError('NOT_FOUND', 'Session not found', { sessionId: 's1' }),
                ),
            ),
        ).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-3',
            ok: false,
            error: {
                code: 'NOT_FOUND',
                message: 'Session not found',
                details: { sessionId: 's1' },
            },
        });
    });

    it('decays an unrecognized failure into an INTERNAL wire error', async () => {
        await expect(
            executeReply('req-4', () => Promise.reject(new Error('boom'))),
        ).resolves.toEqual({
            protocolVersion: CAXRI_PROTOCOL_VERSION,
            id: 'req-4',
            ok: false,
            error: { code: 'INTERNAL', message: 'boom' },
        });
    });
});

describe('fileSystemCode', () => {
    it('reads the code property off a Node.js filesystem error', () => {
        expect(fileSystemCode({ code: 'ENOENT' })).toBe('ENOENT');
    });

    it('stringifies a non-string code value', () => {
        expect(fileSystemCode({ code: 404 })).toBe('404');
    });

    it('returns undefined for an error object without a code', () => {
        expect(fileSystemCode(new Error('plain failure'))).toBeUndefined();
    });

    it('returns undefined for non-object thrown values', () => {
        expect(fileSystemCode('a string error')).toBeUndefined();
        expect(fileSystemCode(null)).toBeUndefined();
        expect(fileSystemCode(undefined)).toBeUndefined();
    });
});
