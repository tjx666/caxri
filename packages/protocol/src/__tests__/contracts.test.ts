import { describe, expect, it } from 'vitest';

import type { CaxriBridge, CaxriMethod } from '../index';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    createCaxriClient,
    errorCodes,
    fromWireError,
    internalMethods,
    MAX_CONFIGURATION_SOURCE_BYTES,
    MAX_FILE_BROWSE_ENTRIES,
    MAX_KEYBINDINGS,
    MAX_TERMINAL_INPUT_LENGTH,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH,
    methods,
    parseCaxriRequest,
    parseCaxriResult,
    parseServerOperationRequest,
    parseServerOperationResult,
    requestEnvelopeSchema,
    serverEventPayloads,
    serverEventSchema,
    toWireError,
} from '../index';

describe('method table', () => {
    const allMethods = { ...methods, ...internalMethods };

    it('registers mobile-only Terminal control methods', () => {
        expect(Object.hasOwn(methods, 'mobile.terminal.takeOver')).toBe(true);
        expect(Object.hasOwn(methods, 'mobile.terminal.release')).toBe(true);
        expect(Object.hasOwn(methods, 'mobile.terminal.input')).toBe(true);
        expect(
            methods['mobile.terminal.takeOver'].params.safeParse({
                terminalId: 'terminal-1',
                subscriptionId: 'subscription-1',
                expectedGeneration: 2,
                cols: 80,
                rows: 24,
            }).success,
        ).toBe(true);
        expect(
            methods['mobile.terminal.takeOver'].params.safeParse({
                terminalId: 'terminal-1',
                subscriptionId: 'subscription-1',
                expectedGeneration: 0,
                cols: 80,
                rows: 24,
            }).success,
        ).toBe(false);
        expect(
            methods['mobile.terminal.input'].params.safeParse({
                terminalId: 'terminal-1',
                subscriptionId: 'subscription-1',
                expectedGeneration: 2,
                data: '\u{1B}[A',
            }).success,
        ).toBe(true);
        expect(
            methods['mobile.terminal.input'].params.safeParse({
                terminalId: 'terminal-1',
                subscriptionId: 'subscription-1',
                expectedGeneration: 2,
                data: 'x'.repeat(9 * 1_024),
            }).success,
        ).toBe(false);
    });

    it('gives every method a validated owner, params schema, and result schema', () => {
        for (const [name, spec] of Object.entries(allMethods)) {
            expect(['desktop', 'server'], name).toContain(spec.owner);
            expect(['read', 'write', 'control'], name).toContain(spec.effect);
            expect(spec.requiredCapabilities.length, name).toBeGreaterThan(0);
            expect(spec.params.safeParse(undefined), name).toHaveProperty('success');
            expect(spec.result.safeParse(undefined), name).toHaveProperty('success');
        }
        expect(Object.keys(allMethods).length).toBe(new Set(Object.keys(allMethods)).size);
    });

    it('keeps every internal method out of the Renderer allowlist', () => {
        for (const name of Object.keys(internalMethods)) {
            expect(
                requestEnvelopeSchema.safeParse({
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'r1',
                    method: name,
                    params: {},
                }).success,
            ).toBe(false);
        }
    });

    it('accepts a missing params argument only where the schema supplies a default', () => {
        expect(methods['app.bootstrap'].params.safeParse(undefined).success).toBe(true);
        expect(methods['terminal.runningCount'].params.safeParse(undefined).success).toBe(true);
        expect(methods['files.read'].params.safeParse(undefined).success).toBe(false);
    });

    it('accepts one bounded paste larger than a private Terminal Host input frame', () => {
        expect(() =>
            parseCaxriRequest('terminal.input', {
                terminalId: 'terminal-1',
                data: 'x'.repeat(MAX_TERMINAL_INPUT_LENGTH + 1),
            }),
        ).not.toThrow();
        expect(() =>
            parseCaxriRequest('terminal.input', {
                terminalId: 'terminal-1',
                data: 'x'.repeat(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH + 1),
            }),
        ).toThrow();
    });

    it('accepts the largest native paste with the complete bracketed-paste envelope', () => {
        const content = 'x'.repeat(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH - 12);
        expect(() =>
            parseCaxriRequest('terminal.prepareLongPaste', { terminalId: 'terminal-1', content }),
        ).not.toThrow();
        expect(() =>
            parseCaxriRequest('terminal.input', {
                terminalId: 'terminal-1',
                data: `\u{1B}[200~${content}\u{1B}[201~`,
            }),
        ).not.toThrow();
    });

    it('defaults Terminal restart to resuming the bound Agent session', () => {
        expect(methods['terminal.restart'].params.parse({ terminalId: 'terminal-1' })).toEqual({
            terminalId: 'terminal-1',
            mode: 'resume',
        });
    });

    it('requires both grid dimensions when attaching a live Terminal', () => {
        expect(
            methods['terminal.attach'].params.safeParse({ terminalId: 'terminal-1', cols: 80 })
                .success,
        ).toBe(false);
        expect(
            methods['terminal.attach'].params.safeParse({
                terminalId: 'terminal-1',
                cols: 80,
                rows: 24,
            }).success,
        ).toBe(true);
    });

    it('bounds external URLs and accepts only the declared open outcomes', () => {
        expect(methods['external.open'].params.safeParse({ url: '' }).success).toBe(false);
        expect(
            methods['external.open'].params.safeParse({ url: 'https://example.com' }).success,
        ).toBe(true);
        expect(methods['external.open'].params.safeParse({ url: 'x'.repeat(16_385) }).success).toBe(
            false,
        );
        expect(methods['external.open'].result.safeParse({ status: 'canceled' }).success).toBe(
            true,
        );
        expect(
            methods['external.open'].result.safeParse({
                status: 'rejected',
                reason: 'unsupported_protocol',
            }).success,
        ).toBe(true);
        expect(
            methods['external.open'].result.safeParse({ status: 'rejected', reason: 'unknown' })
                .success,
        ).toBe(false);
    });

    it('rejects agent provider settings that omit a catalog provider', () => {
        const entry = {
            hooks: { enabled: false },
            launch: { executable: 'claude', args: [] },
            messaging: { enabled: true },
        };
        expect(
            methods['settings.get'].result.shape.value.shape['agents.providers'].safeParse({
                claude: entry,
            }).success,
        ).toBe(false);
        expect(
            methods['settings.get'].result.shape.value.shape['agents.providers'].safeParse({
                claude: entry,
                codex: entry,
                grok: entry,
            }).success,
        ).toBe(true);
    });

    it('rejects invalid Desktop and Server results as internal contract failures', () => {
        expect(() => parseCaxriResult('terminal.runningCount', 2)).toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
        expect(() => parseServerOperationResult('app.health', { ready: true })).toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
    });
});

describe('requestEnvelopeSchema', () => {
    it.each(['constructor', 'toString', '__proto__'])('rejects inherited method %s', (method) => {
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'request-1',
                method,
                params: {},
            }).success,
        ).toBe(false);
    });

    it('requires the declared protocol version', () => {
        expect(
            requestEnvelopeSchema.safeParse({
                id: 'request-1',
                method: 'app.health',
                params: {},
            }).success,
        ).toBe(false);
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION + 1,
                id: 'request-1',
                method: 'app.health',
                params: {},
            }).success,
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

    it('preserves a classified error created by another bundled protocol copy', () => {
        class ForeignCaxriError extends Error {
            override readonly name = 'CaxriError';

            constructor(
                readonly code: 'VALIDATION',
                message: string,
                readonly details?: Record<string, unknown>,
            ) {
                super(message);
            }
        }

        expect(
            toWireError(
                new ForeignCaxriError('VALIDATION', 'foreign validation failed', {
                    method: 'terminal.input',
                }),
            ),
        ).toEqual({
            code: 'VALIDATION',
            message: 'foreign validation failed',
            details: { method: 'terminal.input' },
        });
    });

    it('reports rejected Runtime parameters as VALIDATION with a readable message', () => {
        try {
            parseServerOperationRequest('files.read', { sessionId: 'session-1' });
            expect.unreachable('parseServerOperationRequest should reject incomplete params');
        } catch (error) {
            const wire = toWireError(error);
            expect(wire.code).toBe('VALIDATION');
            expect(wire.message).toContain('path');
        }
    });

    it('rejects an unknown Runtime method before it reaches a handler', () => {
        expect(() => parseServerOperationRequest('nope.method', {})).toThrow(
            'Unknown Runtime method',
        );
    });
});

describe('Renderer client', () => {
    /**
     * The preload cannot throw a typed error across `contextBridge`, which copies only `message` and `stack`. The
     * client is what turns the reply envelope back into a `CaxriError`.
     */
    it('unwraps results and rejects failed replies as typed errors', async () => {
        /**
         * A stub cannot satisfy the per-method result union, so the shape is asserted once here.
         */
        const running = { terminals: 2, chats: 0 };
        const client = createCaxriClient({
            request: (method: CaxriMethod) =>
                Promise.resolve(
                    method === 'terminal.runningCount'
                        ? {
                              protocolVersion: CAXRI_PROTOCOL_VERSION,
                              id: 'request-1',
                              ok: true,
                              result: running,
                          }
                        : {
                              protocolVersion: CAXRI_PROTOCOL_VERSION,
                              id: 'request-2',
                              ok: false,
                              error: { code: 'PATH_DENIED', message: 'outside root' },
                          },
                ),
            onEvent: () => () => {},
        } as unknown as CaxriBridge);

        await expect(client.request('terminal.runningCount')).resolves.toEqual(running);
        await expect(
            client.request('files.read', { sessionId: 'session-1', path: '/etc/passwd' }),
        ).rejects.toThrow(
            expect.objectContaining({ code: 'PATH_DENIED', message: 'outside root' }) as Error,
        );
    });

    it('rejects a successful reply whose result does not match the method schema', async () => {
        const client = createCaxriClient({
            request: () =>
                Promise.resolve({
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'request-1',
                    ok: true,
                    result: '2',
                }),
            onEvent: () => () => {},
        } as unknown as CaxriBridge);

        await expect(client.request('terminal.runningCount')).rejects.toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
    });
});

describe('runtime events', () => {
    it('parses every declared event through the discriminated union', () => {
        expect(Object.keys(serverEventPayloads)).toContain('terminal.output');
        expect(
            serverEventSchema.safeParse({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'hi' },
            }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({ event: 'terminal.output', payload: { data: 'hi' } })
                .success,
        ).toBe(false);
        expect(serverEventSchema.safeParse({ event: 'nope', payload: {} }).success).toBe(false);
    });

    it('normalizes an unknown state-change scope to the full convergence path', () => {
        expect(
            serverEventSchema.parse({
                event: 'state.changed',
                payload: { kind: 'future-scope', resourceId: 'future-1' },
            }),
        ).toEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
    });
});

describe('configuration contracts', () => {
    const multibyteSourceAtLimit = '界'.repeat(Math.floor(MAX_CONFIGURATION_SOURCE_BYTES / 3));
    const oversizedMultibyteSource = `${multibyteSourceAtLimit}界`;

    it('uses the same UTF-8 byte ceiling for update, result, and event sources', () => {
        for (const kind of ['settings', 'keybindings', 'theme'] as const) {
            expect(
                methods[`${kind}.update`].params.shape.source.safeParse(multibyteSourceAtLimit)
                    .success,
            ).toBe(true);
            expect(
                methods[`${kind}.update`].params.shape.source.safeParse(oversizedMultibyteSource)
                    .success,
            ).toBe(false);
            expect(
                methods[`${kind}.get`].result.shape.source.safeParse(oversizedMultibyteSource)
                    .success,
            ).toBe(false);
            expect(
                serverEventPayloads[`${kind}.changed`].shape.source.safeParse(
                    oversizedMultibyteSource,
                ).success,
            ).toBe(false);
        }
    });

    it('bounds keybinding arrays in configuration and bootstrap results', () => {
        const binding = { command: 'terminal.new', key: 'cmd+t' };
        const oversizedKeybindings = Array.from({ length: MAX_KEYBINDINGS + 1 }, () => binding);

        expect(
            methods['keybindings.get'].result.shape.value.safeParse(oversizedKeybindings).success,
        ).toBe(false);
        expect(
            methods['app.bootstrap'].result.shape.keybindings.safeParse(oversizedKeybindings)
                .success,
        ).toBe(false);
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

describe('files.browse contract', () => {
    it('bounds both the refinement query and returned directory entries', () => {
        const base = { sessionId: 'session-1', directory: '/project' };
        expect(
            methods['files.browse'].params.safeParse({ ...base, query: 'x'.repeat(255) }).success,
        ).toBe(true);
        expect(
            methods['files.browse'].params.safeParse({ ...base, query: 'x'.repeat(256) }).success,
        ).toBe(false);

        const entries = Array.from({ length: MAX_FILE_BROWSE_ENTRIES + 1 }, (_, index) => ({
            kind: 'file' as const,
            name: `file-${index}`,
            path: `/project/file-${index}`,
            size: 1,
        }));
        expect(methods['files.browse'].result.safeParse({ entries, truncated: true }).success).toBe(
            false,
        );
    });
});

describe('file mutation contracts', () => {
    const base = {
        operationId: 'operation-1',
        sessionId: 'session-1',
        path: '/project/note.txt',
    };

    it('keeps filesystem mutations narrow and gives Trash to Main only', () => {
        expect(methods['files.create'].owner).toBe('server');
        expect(methods['files.copy'].owner).toBe('server');
        expect(methods['files.rename'].owner).toBe('server');
        expect(methods['files.move'].owner).toBe('server');
        expect(methods['files.reveal'].owner).toBe('server');
        expect(methods['files.openWithDefaultApp'].owner).toBe('server');
        expect(methods['files.trash'].owner).toBe('desktop');
        expect(internalMethods['files.authorizeOpen'].owner).toBe('server');
        expect(internalMethods['files.authorizeTrash'].owner).toBe('server');
    });

    it('defaults creation to a file and drag movement to conflict rejection', () => {
        expect(
            methods['files.create'].params.parse({
                operationId: 'operation-1',
                sessionId: 'session-1',
                directory: '/project',
                name: 'note.txt',
            }),
        ).toMatchObject({ kind: 'file' });
        expect(
            methods['files.move'].params.parse({
                operationId: 'operation-2',
                sessionId: 'session-1',
                path: '/project/note.txt',
                directory: '/project/archive',
            }),
        ).toMatchObject({ conflict: 'reject' });
    });

    it('requires a durable operation ID for mutations that may outlive their IPC waiter', () => {
        expect(
            methods['files.create'].params.safeParse({
                sessionId: 'session-1',
                directory: '/project',
                name: 'note.txt',
            }).success,
        ).toBe(false);
        expect(methods['files.operation.list'].params.safeParse(undefined).success).toBe(false);
        expect(
            methods['files.operation.list'].params.safeParse({ sessionId: 'session-1' }).success,
        ).toBe(true);
    });

    it.each(['', '.', '..', '../escape', 'nested/file', String.raw`nested\file`, 'null\0byte'])(
        'rejects invalid item name %j',
        (name) => {
            expect(methods['files.rename'].params.safeParse({ ...base, name }).success).toBe(false);
        },
    );

    it('trims a valid leaf name and keeps Trash authorization off the Renderer bridge', () => {
        expect(methods['files.rename'].params.parse({ ...base, name: ' note.md ' }).name).toBe(
            'note.md',
        );
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'r1',
                method: 'files.authorizeTrash',
                params: base,
            }).success,
        ).toBe(false);
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'r2',
                method: 'files.authorizeOpen',
                params: base,
            }).success,
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

    it('keeps Project reorder requests scalar and validates their target', () => {
        expect(
            methods['project.reorder'].params.safeParse({
                projectId: 'project-1',
                targetIndex: 1,
            }).success,
        ).toBe(true);
        expect(
            methods['project.reorder'].params.safeParse({
                projectIds: Array.from({ length: 129 }, (_, index) => `project-${index}`),
            }).success,
        ).toBe(false);
        expect(
            methods['project.reorder'].params.safeParse({
                projectId: '',
                targetIndex: 0,
            }).success,
        ).toBe(false);
        expect(
            methods['project.reorder'].params.safeParse({
                projectId: 'project-1',
                targetIndex: -1,
            }).success,
        ).toBe(false);
    });

    it('accepts only controlled Project icons and semantic colors', () => {
        const valid = { projectId: 'project-1', icon: { name: 'code-2', color: 'success' } };
        expect(methods['project.setIcon'].params.safeParse(valid).success).toBe(true);
        expect(methods['project.setIcon'].params.safeParse({ ...valid, icon: null }).success).toBe(
            true,
        );
        expect(
            methods['project.setIcon'].params.safeParse({
                ...valid,
                icon: { name: 'user-supplied-icon', color: 'success' },
            }).success,
        ).toBe(false);
        expect(
            methods['project.setIcon'].params.safeParse({
                ...valid,
                icon: { name: 'code-2', color: '#ff00ff' },
            }).success,
        ).toBe(false);
        expect(
            methods['project.setIcon'].params.safeParse({ ...valid, rootPath: '/other' }).success,
        ).toBe(false);
    });
});

describe('Terminal creation contract', () => {
    it('accepts only a bounded optional cwd alongside the owning Session', () => {
        expect(
            methods['terminal.create'].params.safeParse({
                sessionId: 'session-1',
                kind: 'shell',
                cwd: '/project/folder',
            }).success,
        ).toBe(true);
        expect(
            methods['terminal.create'].params.safeParse({
                sessionId: 'session-1',
                kind: 'shell',
                cwd: '',
            }).success,
        ).toBe(false);
    });
});

describe('Pane layout contract', () => {
    const state = {
        sessionId: 'session-1',
        revision: 0,
        workbenchProjectId: 'project-1',
        desiredSecondarySidebarViewContainerId: 'caxri.files' as const,
    };
    const pane = (id: string, terminalId: string) => ({
        type: 'pane' as const,
        id,
        tabs: [{ id: `tab-${id}`, resource: { kind: 'terminal' as const, terminalId } }],
        activeTabId: `tab-${id}`,
    });

    it('wires session.updateState to the pane layout schema and rejects a duplicate Terminal attachment', () => {
        expect(
            methods['session.updateState'].params.safeParse({
                ...state,
                editorRemapOperationId: 'operation-1',
                paneLayout: {
                    root: {
                        type: 'split',
                        id: 'split-1',
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: pane('pane-1', 'terminal-1'),
                        second: pane('pane-2', 'terminal-2'),
                    },
                    activePaneId: 'pane-1',
                },
            }).success,
        ).toBe(true);
        expect(
            methods['session.updateState'].params.safeParse({
                ...state,
                paneLayout: {
                    root: {
                        type: 'split',
                        id: 'split-1',
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: pane('pane-1', 'terminal-1'),
                        second: pane('pane-2', 'terminal-1'),
                    },
                    activePaneId: 'pane-1',
                },
            }).success,
        ).toBe(false);
    });
});
