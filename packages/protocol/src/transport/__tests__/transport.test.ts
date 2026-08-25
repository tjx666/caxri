import { describe, expect, it, vi } from 'vitest';

import type { CaxriMethod } from '../../registry/methods';
import { CaxriError } from '../errors';
import type { CaxriBridge, MethodReply } from '../transport';
import {
    commandReplyEnvelopeSchema,
    createCaxriClient,
    parseCaxriRequest,
    parseCaxriResult,
    parseRuntimeMessage,
    parseRuntimeRequest,
    parseRuntimeResult,
    wireErrorSchema,
} from '../transport';

describe('parseCaxriRequest / parseRuntimeRequest', () => {
    it('validates params and pairs them with their method for a bounded Caxri command', () => {
        const request = parseCaxriRequest('app.health', {});
        expect(request).toEqual({ method: 'app.health', params: {} });
    });

    it('rejects an unknown method with a typed VALIDATION error', () => {
        expect(() => parseRuntimeRequest('does.not.exist', {})).toThrow(CaxriError);
        let caught: unknown;
        try {
            parseRuntimeRequest('does.not.exist', {});
        } catch (error) {
            caught = error;
        }
        expect((caught as CaxriError).code).toBe('VALIDATION');
    });

    it('recognizes an internal Main-to-Runtime method absent from the public Caxri method table', () => {
        // The method is resolved (a params schema is found), so failure comes from validating an
        // intentionally incomplete payload rather than from an "Unknown Runtime method" lookup miss.
        let caught: unknown;
        try {
            parseRuntimeRequest('agent.dispatch.cancelWaitInternal', {});
        } catch (error) {
            caught = error;
        }
        expect((caught as CaxriError).message).not.toContain('Unknown Runtime method');
        const request = parseRuntimeRequest('agent.dispatch.cancelWaitInternal', {
            waitId: 'wait-1',
        });
        expect(request).toEqual({
            method: 'agent.dispatch.cancelWaitInternal',
            params: { waitId: 'wait-1' },
        });
    });
});

describe('parseCaxriResult / parseRuntimeResult', () => {
    it('returns a validated result for a well-formed payload', () => {
        const result = parseCaxriResult('app.health', {
            ready: true,
            pid: 1,
            startedAt: 1,
            activePtyCount: 0,
        });
        expect(result).toEqual({ ready: true, pid: 1, startedAt: 1, activePtyCount: 0 });
    });

    it('raises an INTERNAL error carrying bounded issue details for a malformed result', () => {
        let caught: unknown;
        try {
            parseCaxriResult('app.health', { ready: 'not-a-boolean' });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CaxriError);
        const error = caught as CaxriError;
        expect(error.code).toBe('INTERNAL');
        expect(error.message).toContain('app.health');
        expect(Array.isArray(error.details?.issues)).toBe(true);
    });

    it('rejects an unknown Runtime result method distinctly from a malformed result', () => {
        // Widened intentionally: this exercises the runtime lookup-miss branch for an untrusted
        // method string, which `parseRuntimeResult`'s generic signature otherwise rejects statically.
        const unknownMethod = 'does.not.exist' as Parameters<typeof parseRuntimeResult>[0];
        let caught: unknown;
        try {
            parseRuntimeResult(unknownMethod, {});
        } catch (error) {
            caught = error;
        }
        expect((caught as CaxriError).message).toContain('Unknown Runtime result method');
    });
});

describe('parseRuntimeMessage', () => {
    it('recognizes a declared Runtime event ahead of the response shape', () => {
        const message = parseRuntimeMessage({
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
        expect(message).toEqual({
            event: 'runtime.status',
            payload: { status: 'ready', restartCount: 0 },
        });
    });

    it('parses a successful and a failed Runtime response', () => {
        expect(parseRuntimeMessage({ id: 'r1', ok: true, result: { anything: 1 } })).toEqual({
            id: 'r1',
            ok: true,
            result: { anything: 1 },
        });
        const failure = parseRuntimeMessage({
            id: 'r2',
            ok: false,
            error: { code: 'NOT_FOUND', message: 'missing' },
        });
        expect(failure).toEqual({
            id: 'r2',
            ok: false,
            error: { code: 'NOT_FOUND', message: 'missing' },
        });
    });

    it('throws when a payload matches neither the event nor the response shape', () => {
        expect(() => parseRuntimeMessage({ unrelated: true })).toThrow();
    });
});

describe('wireErrorSchema', () => {
    it('decays an unrecognized wire code to INTERNAL while preserving the message', () => {
        expect(wireErrorSchema.parse({ code: 'NOT_A_REAL_CODE', message: 'oops' })).toEqual({
            code: 'INTERNAL',
            message: 'oops',
        });
    });

    it('omits details entirely rather than keeping an empty or absent details field', () => {
        expect(wireErrorSchema.parse({ code: 'IO', message: 'disk' })).toEqual({
            code: 'IO',
            message: 'disk',
        });
        expect(
            wireErrorSchema.parse({ code: 'IO', message: 'disk', details: { path: 'x' } }),
        ).toEqual({ code: 'IO', message: 'disk', details: { path: 'x' } });
    });
});

describe('createCaxriClient', () => {
    /**
     * Mocks always answer the single `app.health` call made below; the generic signature only exists to satisfy
     * `CaxriBridge['request']`, so the fixed payload is cast per-call to `M`.
     */
    function mockRequest<M extends CaxriMethod>(payload: unknown): CaxriBridge['request'] {
        return () => Promise.resolve(commandReplyEnvelopeSchema.parse(payload) as MethodReply<M>);
    }

    it('unwraps a successful reply into the bare result', async () => {
        const client = createCaxriClient({
            negotiate: () => Promise.reject(new Error('not exercised')),
            request: mockRequest<'app.health'>({
                protocolVersion: 2,
                id: 'r1',
                ok: true,
                result: { ready: true, pid: 1, startedAt: 1, activePtyCount: 0 },
            }),
            requestWithId: (_requestId, method, ...arguments_) =>
                mockRequest<'app.health'>({
                    protocolVersion: 2,
                    id: 'r1',
                    ok: true,
                    result: { ready: true, pid: 1, startedAt: 1, activePtyCount: 0 },
                })(method, ...arguments_),
            onEvent: () => () => {},
        });
        await expect(client.request('app.health')).resolves.toEqual({
            ready: true,
            pid: 1,
            startedAt: 1,
            activePtyCount: 0,
        });
    });

    it('rejects a failed reply with a rebuilt typed CaxriError instead of the raw envelope', async () => {
        const client = createCaxriClient({
            negotiate: () => Promise.reject(new Error('not exercised')),
            request: mockRequest<'app.health'>({
                protocolVersion: 2,
                id: 'r1',
                ok: false,
                error: { code: 'FORBIDDEN', message: 'no capability' },
            }),
            requestWithId: (_requestId, method, ...arguments_) =>
                mockRequest<'app.health'>({
                    protocolVersion: 2,
                    id: 'r1',
                    ok: false,
                    error: { code: 'FORBIDDEN', message: 'no capability' },
                })(method, ...arguments_),
            onEvent: () => () => {},
        });
        await expect(client.request('app.health')).rejects.toBeInstanceOf(CaxriError);
        await expect(client.request('app.health')).rejects.toMatchObject({
            code: 'FORBIDDEN',
            message: 'no capability',
        });
    });

    it('rejects a malformed successful result instead of forwarding it to the caller', async () => {
        const client = createCaxriClient({
            negotiate: () => Promise.reject(new Error('not exercised')),
            request: mockRequest<'app.health'>({
                protocolVersion: 2,
                id: 'r1',
                ok: true,
                result: { ready: 'not-a-boolean' },
            }),
            requestWithId: (_requestId, method, ...arguments_) =>
                mockRequest<'app.health'>({
                    protocolVersion: 2,
                    id: 'r1',
                    ok: true,
                    result: { ready: 'not-a-boolean' },
                })(method, ...arguments_),
            onEvent: () => () => {},
        });
        await expect(client.request('app.health')).rejects.toBeInstanceOf(CaxriError);
    });

    it('cancels a caller-owned request identity when its AbortSignal fires', async () => {
        const reply = Promise.withResolvers<MethodReply<'app.health'>>();
        let requestId = '';
        const cancel = vi.fn((parameters: unknown) => {
            expect(parameters).toEqual({ requestId });
            reply.resolve({
                protocolVersion: 2,
                id: requestId,
                ok: false,
                error: { code: 'CANCELLED', message: 'Request was canceled' },
            });
            return Promise.resolve({
                protocolVersion: 2,
                id: 'cancel-1',
                ok: true as const,
                result: { cancelled: true },
            });
        });
        const client = createCaxriClient({
            negotiate: () => Promise.reject(new Error('not exercised')),
            request: ((method: CaxriMethod, parameters?: unknown) =>
                method === 'requests.cancel'
                    ? cancel(parameters)
                    : Promise.reject(new Error('unexpected request'))) as CaxriBridge['request'],
            requestWithId: ((id: string) => {
                requestId = id;
                return reply.promise;
            }) as CaxriBridge['requestWithId'],
            onEvent: () => () => {},
        });
        const controller = new AbortController();
        const pending = client.requestWithSignal('app.health', controller.signal);

        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(cancel).toHaveBeenCalledWith({ requestId });
    });
});
