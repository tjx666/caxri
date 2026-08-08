import { describe, expect, it } from 'vitest';

import {
    CaxriError,
    createCaxriClient,
    errorCodes,
    fromWireError,
    internalMethods,
    methods,
    parseCaxriResult,
    parseRuntimeMessage,
    parseRuntimeRequest,
    parseRuntimeResult,
    requestEnvelopeSchema,
    runtimeEventPayloads,
    runtimeEventSchema,
    terminalLayoutSchema,
    toWireError,
    type CaxriBridge,
    type CaxriMethod,
} from '..';

describe('method table', () => {
    const allMethods = { ...methods, ...internalMethods };

    it('gives every method a validated owner, params schema, and result schema', () => {
        for (const [name, spec] of Object.entries(allMethods)) {
            expect(['main', 'runtime'], name).toContain(spec.owner);
            expect(spec.params.safeParse(undefined), name).toHaveProperty('success');
            expect(spec.result.safeParse(undefined), name).toHaveProperty('success');
        }
        expect(Object.keys(allMethods).length).toBe(new Set(Object.keys(allMethods)).size);
    });

    it('keeps every internal method out of the Renderer allowlist', () => {
        for (const name of Object.keys(internalMethods)) {
            expect(
                requestEnvelopeSchema.safeParse({ id: 'r1', method: name, params: {} }).success,
            ).toBe(false);
        }
    });

    it('accepts a missing params argument only where the schema supplies a default', () => {
        expect(methods['app.bootstrap'].params.safeParse(undefined).success).toBe(true);
        expect(methods['terminal.runningCount'].params.safeParse(undefined).success).toBe(true);
        expect(methods['files.read'].params.safeParse(undefined).success).toBe(false);
    });

    it('rejects invalid Main and Runtime results as internal contract failures', () => {
        expect(() => parseCaxriResult('terminal.runningCount', '2')).toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
        expect(() => parseRuntimeResult('app.health', { ready: true })).toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
        expect(parseRuntimeResult('terminal.runningCount', 2)).toBe(2);
    });
});

describe('requestEnvelopeSchema', () => {
    it.each(['constructor', 'toString', '__proto__'])('rejects inherited method %s', (method) => {
        expect(
            requestEnvelopeSchema.safeParse({ id: 'request-1', method, params: {} }).success,
        ).toBe(false);
    });
});

describe('error taxonomy', () => {
    it('round-trips every code through the wire representation', () => {
        for (const code of errorCodes) {
            const restored = fromWireError(toWireError(new CaxriError(code, `${code} failed`)));
            expect(restored).toBeInstanceOf(CaxriError);
            expect(restored.code).toBe(code);
            expect(restored.message).toBe(`${code} failed`);
        }
    });

    it('preserves details and classifies unknown or malformed failures as INTERNAL', () => {
        const restored = fromWireError(
            toWireError(new CaxriError('IO', 'disk failed', { path: '/tmp/a' })),
        );
        expect(restored.details).toEqual({ path: '/tmp/a' });
        expect(fromWireError({ code: 'NOT_A_CODE', message: 'x' }).code).toBe('INTERNAL');
        expect(fromWireError(undefined).code).toBe('INTERNAL');
        expect(toWireError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    });

    it('reports rejected Runtime parameters as VALIDATION with a readable message', () => {
        try {
            parseRuntimeRequest('files.read', { sessionId: 'session-1' });
            expect.unreachable('parseRuntimeRequest should reject incomplete params');
        } catch (error) {
            const wire = toWireError(error);
            expect(wire.code).toBe('VALIDATION');
            expect(wire.message).toContain('path');
        }
    });

    it('rejects an unknown Runtime method before it reaches a handler', () => {
        expect(() => parseRuntimeRequest('nope.method', {})).toThrow('Unknown Runtime method');
    });
});

describe('Renderer client', () => {
    /**
     * The preload cannot throw a typed error across `contextBridge`, which copies only `message` and
     * `stack`. The client is what turns the reply envelope back into a `CaxriError`.
     */
    it('unwraps results and rejects failed replies as typed errors', async () => {
        /** A stub cannot satisfy the per-method result union, so the shape is asserted once here. */
        const client = createCaxriClient({
            request: (method: CaxriMethod) =>
                Promise.resolve(
                    method === 'terminal.runningCount'
                        ? { ok: true, result: 2 }
                        : { ok: false, error: { code: 'PATH_DENIED', message: 'outside root' } },
                ),
            onEvent: () => () => undefined,
        } as unknown as CaxriBridge);

        await expect(client.request('terminal.runningCount')).resolves.toBe(2);
        await expect(
            client.request('files.read', { sessionId: 'session-1', path: '/etc/passwd' }),
        ).rejects.toThrow(
            expect.objectContaining({ code: 'PATH_DENIED', message: 'outside root' }) as Error,
        );
    });
});

describe('runtime events', () => {
    it('parses every declared event through the discriminated union', () => {
        expect(Object.keys(runtimeEventPayloads)).toContain('terminal.output');
        expect(
            runtimeEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(true);
        expect(
            runtimeEventSchema.safeParse({ event: 'terminal.output', payload: { data: 'hi' } })
                .success,
        ).toBe(false);
        expect(runtimeEventSchema.safeParse({ event: 'nope', payload: {} }).success).toBe(false);
    });

    it('normalizes an unknown state-change scope to the full convergence path', () => {
        expect(
            runtimeEventSchema.parse({
                event: 'state.changed',
                payload: { kind: 'future-scope', resourceId: 'future-1' },
            }),
        ).toEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
    });

    it('rejects malformed utility-process messages before they reach Main listeners', () => {
        expect(() =>
            parseRuntimeMessage({
                event: 'terminal.output',
                payload: { data: 'missing terminal id' },
            }),
        ).toThrow();
        expect(
            parseRuntimeMessage({
                id: 'request-1',
                ok: false,
                error: { code: 'FUTURE_CODE', message: 'future failure' },
            }),
        ).toEqual({
            id: 'request-1',
            ok: false,
            error: { code: 'INTERNAL', message: 'future failure' },
        });
    });
});

describe('files.write contract', () => {
    it('supports the largest configurable text file without exceeding the IPC boundary', () => {
        const maximum = 16 * 1024 * 1024;
        const base = { sessionId: 'session-1', path: '/project/note.txt' };

        expect(
            methods['files.write'].params.safeParse({ ...base, content: 'x'.repeat(maximum) })
                .success,
        ).toBe(true);
        expect(
            methods['files.write'].params.safeParse({ ...base, content: 'x'.repeat(maximum + 1) })
                .success,
        ).toBe(false);
    });
});

describe('Project and Session contracts', () => {
    it('keeps the selected root on Project creation and requires Sessions to reference it by id', () => {
        expect(methods['project.create'].params.safeParse({ rootPath: '/project' }).success).toBe(
            true,
        );
        expect(
            methods['session.create'].params.safeParse({
                projectId: 'project-1',
                defaultAgent: 'codex',
            }).success,
        ).toBe(true);
        expect(
            methods['session.create'].params.safeParse({
                rootPath: '/project',
                defaultAgent: 'codex',
            }).success,
        ).toBe(false);
    });
});

describe('Terminal layout contract', () => {
    const state = {
        sessionId: 'session-1',
        openTabs: [],
        inspectorMode: 'files',
    };
    const group = {
        type: 'group' as const,
        id: 'group-1',
        terminalIds: ['terminal-1'],
        activeTerminalId: 'terminal-1',
    };
    const split = (overrides: Record<string, unknown> = {}) => ({
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        ratio: 0.5,
        first: group,
        second: { ...group, id: 'group-2', terminalIds: ['terminal-2'] },
        ...overrides,
    });

    it('accepts bounded split trees and rejects duplicate Terminal attachments', () => {
        expect(
            methods['session.updateState'].params.safeParse({
                ...state,
                layout: {
                    activeGroupId: 'group-1',
                    root: split({
                        second: {
                            ...group,
                            id: 'group-2',
                            terminalIds: ['terminal-2'],
                            activeTerminalId: 'terminal-2',
                        },
                    }),
                },
            }).success,
        ).toBe(true);
        expect(
            methods['session.updateState'].params.safeParse({
                ...state,
                layout: { root: split({ second: { ...group, id: 'group-2' } }) },
            }).success,
        ).toBe(false);
    });

    it('keeps every invariant the imperative validator enforced', () => {
        const accepts = (layout: unknown): boolean =>
            terminalLayoutSchema.safeParse(layout).success;

        expect(accepts({})).toBe(true);
        expect(accepts({ activeGroupId: 'group-1' })).toBe(true);
        expect(accepts({ activeGroupId: '', root: group })).toBe(false);
        expect(accepts({ root: group, activeGroupId: 'group-1' })).toBe(true);
        expect(accepts({ root: group, activeGroupId: 'missing-group' })).toBe(false);
        expect(accepts({ root: { ...group, terminalIds: [] } })).toBe(false);
        expect(accepts({ root: { ...group, activeTerminalId: 'terminal-9' } })).toBe(false);
        expect(accepts({ root: split({ id: 'group-1' }) })).toBe(false);
        expect(accepts({ root: split({ direction: 'diagonal' }) })).toBe(false);
        expect(accepts({ root: split({ ratio: 0.05 }) })).toBe(false);
        expect(accepts({ root: split({ ratio: 0.95 }) })).toBe(false);
        expect(accepts({ root: split({ ratio: '0.5' }) })).toBe(false);
        expect(accepts({ root: split({ second: undefined }) })).toBe(false);
        expect(accepts({ root: { type: 'unknown', id: 'node-1' } })).toBe(false);
        expect(accepts({ root: null })).toBe(false);
    });

    it('rejects layouts beyond the node and Terminal ceilings', () => {
        const wideGroup = (index: number, size: number) => ({
            type: 'group',
            id: `group-${index}`,
            terminalIds: Array.from({ length: size }, (_, item) => `terminal-${index}-${item}`),
        });
        expect(
            terminalLayoutSchema.safeParse({
                root: {
                    type: 'split',
                    id: 'split-1',
                    direction: 'vertical',
                    ratio: 0.5,
                    first: wideGroup(1, 8),
                    second: wideGroup(2, 8),
                },
            }).success,
        ).toBe(true);
        expect(
            terminalLayoutSchema.safeParse({
                root: {
                    type: 'split',
                    id: 'split-1',
                    direction: 'vertical',
                    ratio: 0.5,
                    first: wideGroup(1, 9),
                    second: wideGroup(2, 8),
                },
            }).success,
        ).toBe(false);

        let deep: unknown = wideGroup(0, 1);
        for (let index = 1; index <= 16; index += 1) {
            deep = {
                type: 'split',
                id: `split-${index}`,
                direction: 'vertical',
                ratio: 0.5,
                first: deep,
                second: wideGroup(index, 1),
            };
        }
        expect(terminalLayoutSchema.safeParse({ root: deep }).success).toBe(false);
    });
});
