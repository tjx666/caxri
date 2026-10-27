import { describe, expect, it, vi } from 'vitest';

import type { DurableCommandReceiptStore, StoredProtocolCommandReceipt } from '../command-receipts';
import type { CommandAdapter, CommandInvocation, DurableReceiptObservation } from '../dispatcher';
import {
    createCommandDispatcher,
    createProtocolWelcome,
    requestIdFromEnvelope,
} from '../dispatcher';
import { CaxriError } from '../errors';
import type { CommandExecutionContext } from '../principal';

const desktop = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
} as const;

const durableDesktop = {
    ...desktop,
    connection: {
        serverId: 'a'.repeat(32),
        bootId: 'b'.repeat(32),
        stateEpoch: 'c'.repeat(32),
        clientId: 'desktop:workbench-1',
        connectionId: 'd'.repeat(32),
    },
} as const;

function request(id: string, method: string, parameters: unknown = {}) {
    return { protocolVersion: 2, id, method, params: parameters };
}

describe('requestIdFromEnvelope', () => {
    it('echoes a valid request id even when other envelope fields are invalid', () => {
        expect(requestIdFromEnvelope({ id: 'kept-1', method: 'bogus.method' })).toBe('kept-1');
    });

    it('returns null when the id itself is missing or malformed', () => {
        expect(requestIdFromEnvelope({ method: 'app.health' })).toBeNull();
        expect(requestIdFromEnvelope({ id: '', method: 'app.health' })).toBeNull();
        expect(requestIdFromEnvelope(null)).toBeNull();
        expect(requestIdFromEnvelope('not an object')).toBeNull();
    });
});

describe('createCommandDispatcher receipt capacity', () => {
    it('rejects a maximumReceipts value outside the 1..4096 bound', () => {
        const server: CommandAdapter = { invoke: () => null };
        expect(() => createCommandDispatcher({ server, maximumReceipts: 0 })).toThrow(CaxriError);
        expect(() => createCommandDispatcher({ server, maximumReceipts: 4_097 })).toThrow(
            CaxriError,
        );
    });

    it('evicts the oldest settled receipt once at capacity instead of rejecting new idempotent commands', async () => {
        function record(title: string) {
            return {
                id: 'session-1',
                projectId: 'project-1',
                rootPath: '/private/project-one',
                title,
                titleMode: 'manual',
                createdAt: 1,
                lastVisitedAt: 1,
                sidebarOrder: 0,
                sessionActivityAt: 1,
                sessionActivityReason: 'created',
                archivedAt: undefined,
                primaryAgentTerminalId: undefined,
                agentActivityState: 'unknown',
                attentionGeneration: 0,
                acknowledgedAttentionGeneration: 0,
                hasUnread: false,
                workbenchRootProjectId: 'project-1',
            };
        }
        const server: CommandAdapter = {
            invoke: (command) => {
                if (command.method === 'session.rename')
                    return record((command.params as { title: string }).title);
                return null;
            },
        };
        const dispatch = createCommandDispatcher({ server, maximumReceipts: 1 });

        await dispatch(
            request('rename-1', 'session.rename', { sessionId: 's1', title: 'First' }),
            desktop,
        );
        // A second distinct idempotent request must still succeed by evicting the settled first receipt.
        await expect(
            dispatch(
                request('rename-2', 'session.rename', { sessionId: 's1', title: 'Second' }),
                desktop,
            ),
        ).resolves.toMatchObject({ ok: true });
    });
});

describe('createCommandDispatcher paired-device generations', () => {
    it('does not replay an idempotent command receipt across a revoked generation', async () => {
        const invoke = vi.fn(() => ({
            terminalId: 'terminal-1',
            accepted: true as const,
            byteLength: 5,
            enter: true,
        }));
        const dispatch = createCommandDispatcher({ server: { invoke } });
        const command = request('reply-1', 'terminal.send', {
            terminalId: 'terminal-1',
            text: 'Hello',
            enter: true,
        });
        const context = (generation: number): CommandExecutionContext => ({
            capabilities: ['terminals.steer'],
            principal: {
                kind: 'paired-device',
                id: 'paired-device:device-1',
                deviceId: 'device-1',
                generation,
                role: 'control',
                projectIds: ['project-1'],
            },
        });

        await expect(dispatch(command, context(1))).resolves.toMatchObject({ ok: true });
        await expect(dispatch(command, context(1))).resolves.toMatchObject({ ok: true });
        await expect(dispatch(command, context(2))).resolves.toMatchObject({ ok: true });
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('returns only the content-free acknowledgement for a paired-device mark-read command', async () => {
        const dispatch = createCommandDispatcher({
            server: {
                invoke: () => ({
                    acknowledged: true,
                    sessionId: 'session-1',
                    attentionGeneration: 3,
                    hasUnread: false,
                }),
            },
        });

        await expect(
            dispatch(
                request('mark-read-1', 'session.markRead', {
                    sessionId: 'session-1',
                    attentionGeneration: 3,
                }),
                {
                    capabilities: ['sessions.write'],
                    principal: {
                        kind: 'paired-device',
                        id: 'paired-device:device-1',
                        deviceId: 'device-1',
                        generation: 1,
                        role: 'control',
                        projectIds: ['project-1'],
                    },
                },
            ),
        ).resolves.toMatchObject({
            ok: true,
            result: {
                acknowledged: true,
                sessionId: 'session-1',
                attentionGeneration: 3,
                hasUnread: false,
            },
        });
    });
});

describe('createCommandDispatcher durable receipts', () => {
    function session(title: string) {
        return {
            id: 'session-1',
            projectId: 'project-1',
            rootPath: '/private/project-one',
            title,
            titleMode: 'manual' as const,
            createdAt: 1,
            lastVisitedAt: 1,
            sidebarOrder: 0,
            sessionActivityAt: 1,
            sessionActivityReason: 'created' as const,
            archivedAt: undefined,
            primaryAgentTerminalId: undefined,
            agentActivityState: 'unknown' as const,
            attentionGeneration: 0,
            acknowledgedAttentionGeneration: 0,
            hasUnread: false,
            workbenchRootProjectId: 'project-1',
        };
    }

    it('lets an adapter store an atomic receipt and replays it after replacement', async () => {
        const observeDurableReceipt = vi.fn<(observation: DurableReceiptObservation) => void>();
        const stored = new Map<string, StoredProtocolCommandReceipt>();
        const durableReceipts: DurableCommandReceiptStore = {
            getReceipt: (_stateEpoch, _clientId, requestId) => stored.get(requestId),
            saveReceipt: (input) => {
                stored.set(input.requestId, input);
                return input;
            },
        };
        const firstInvoke = vi.fn(
            (
                command: { method: string; params: unknown },
                _context: unknown,
                invocation: CommandInvocation,
            ) => {
                const result =
                    command.method === 'session.rename'
                        ? session((command.params as { title: string }).title)
                        : null;
                invocation.persistDurableResult?.(result);
                return result;
            },
        );
        const command = request('durable-1', 'session.rename', {
            sessionId: 'session-1',
            title: 'Persisted',
        });
        const first = createCommandDispatcher({
            durableReceipts,
            observeDurableReceipt,
            server: { invoke: firstInvoke },
        });

        await expect(first(command, durableDesktop)).resolves.toMatchObject({ ok: true });
        expect(firstInvoke).toHaveBeenCalledOnce();

        const replacementInvoke = vi.fn(() => session('Unexpected duplicate'));
        const replacement = createCommandDispatcher({
            durableReceipts,
            observeDurableReceipt,
            server: { invoke: replacementInvoke },
        });
        await expect(replacement(command, durableDesktop)).resolves.toMatchObject({
            ok: true,
            result: { title: 'Persisted' },
        });
        expect(replacementInvoke).not.toHaveBeenCalled();
        expect(
            observeDurableReceipt.mock.calls.map(([observation]) => observation.outcome),
        ).toEqual(['miss', 'stored', 'hit']);
        await expect(
            replacement(
                request('durable-1', 'session.rename', {
                    sessionId: 'session-1',
                    title: 'Different input',
                }),
                durableDesktop,
            ),
        ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
        expect(replacementInvoke).not.toHaveBeenCalled();
    });

    it('keeps privacy-reviewed memory commands out of the durable store', async () => {
        const getReceipt = vi.fn();
        const saveReceipt = vi.fn();
        const durableReceipts: DurableCommandReceiptStore = {
            getReceipt,
            saveReceipt,
        };
        const invoke = vi.fn(() => ({ stopping: true, activePtyCount: 0 }));
        const dispatch = createCommandDispatcher({ durableReceipts, server: { invoke } });

        await expect(
            dispatch(request('stop-1', 'host.stop', { confirmLivePtys: true }), durableDesktop),
        ).resolves.toMatchObject({ ok: true });
        expect(invoke).toHaveBeenCalledOnce();
        expect(getReceipt).not.toHaveBeenCalled();
        expect(saveReceipt).not.toHaveBeenCalled();
    });
});

describe('createCommandDispatcher admission', () => {
    it('returns after adapter admission while the authoritative reply is pending', async () => {
        const completion = Promise.withResolvers<unknown>();
        let isInvoked = false;
        const dispatch = createCommandDispatcher({
            server: {
                invoke: () => {
                    isInvoked = true;
                    return completion.promise;
                },
            },
        });

        const admission = await dispatch.admit(
            request('write-1', 'files.write', {
                sessionId: 'session-1',
                path: '/project/a.txt',
                content: 'saved',
            }),
            desktop,
        );
        expect(isInvoked).toBe(true);

        completion.resolve({
            path: '/project/a.txt',
            content: 'saved',
            mtimeMs: 1,
            size: 5,
        });
        await expect(admission.reply).resolves.toMatchObject({ ok: true });
    });
});

describe('createCommandDispatcher adapter availability', () => {
    it('reports UNAVAILABLE when the owning adapter is present but reports itself unavailable', async () => {
        const server: CommandAdapter = {
            invoke: () => ({ ready: true, pid: 1, startedAt: 1, activePtyCount: 0 }),
            isAvailable: () => false,
        };
        const dispatch = createCommandDispatcher({ server });
        await expect(dispatch(request('r1', 'app.health'), desktop)).resolves.toMatchObject({
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'Host is unavailable' },
        });
    });

    it('excludes commands owned by an unavailable adapter from the negotiated welcome', () => {
        const server: CommandAdapter = { invoke: () => null, isAvailable: () => false };
        const welcome = createProtocolWelcome({ server }, { supportedVersions: [2] }, desktop);
        expect(welcome.commands).not.toContain('app.health');
    });

    it('negotiates only durable recovery features supported by both peers', () => {
        const server: CommandAdapter = { invoke: () => null };
        const context = {
            ...desktop,
            connection: {
                serverId: 'a'.repeat(32),
                bootId: 'b'.repeat(32),
                stateEpoch: 'c'.repeat(32),
                clientId: 'desktop:workbench-1',
                connectionId: 'd'.repeat(32),
            },
        };
        const welcome = createProtocolWelcome(
            { server, features: ['durable-command-receipts-v1'] },
            {
                supportedVersions: [2],
                features: ['durable-command-receipts-v1', 'durable-changefeed-v1'],
            },
            context,
        );

        expect(welcome.features).toEqual(['durable-command-receipts-v1']);
        expect(welcome.connection).toEqual(context.connection);
    });
});
