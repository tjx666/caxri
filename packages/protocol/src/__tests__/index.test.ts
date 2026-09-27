import { describe, expect, it, vi } from 'vitest';

import type { CommandAdapter, CommandExecutionContext, ServerEvent } from '../index';
import {
    acceptEventSequence,
    agentSkillHealthSchema,
    capabilityIds,
    CAXRI_PROTOCOL_VERSION,
    createCommandDispatcher,
    createEventJournal,
    createProtocolWelcome,
    errorCodes,
    isNonExpiringServerOperation,
    methods,
    negotiateProtocolVersion,
    parseServerOperationRequest,
    principalProjectionSchemas,
    projectObservableEventRecovery,
    protocolWelcomeSchema,
    requestEnvelopeSchema,
    serverEventSchema,
    serverManifestSchema,
} from '../index';

const desktop = {
    capabilities: ['desktop'],
    principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
} satisfies CommandExecutionContext;
const human = {
    capabilities: ['projects.read'],
    principal: { kind: 'human-cli', id: 'cli-1' },
} satisfies CommandExecutionContext;
const hostOperator = {
    capabilities: ['events.read', 'host.read', 'host.stop'],
    principal: { kind: 'human-cli', id: 'cli-host-operator' },
} satisfies CommandExecutionContext;
const agent = {
    capabilities: ['projects.read'],
    principal: {
        kind: 'agent',
        id: 'agent-1',
        endpointId: 'endpoint-1',
        generation: 2,
        projectIds: ['project-1'],
    },
} satisfies CommandExecutionContext;

const projects = [
    {
        id: 'project-1',
        rootPath: '/private/project-one',
        displayTitle: 'Project One',
        orderIndex: 0,
        createdAt: 1,
        lastOpenedAt: 1,
    },
    {
        id: 'project-2',
        rootPath: '/private/project-two',
        displayTitle: 'Project Two',
        orderIndex: 1,
        createdAt: 2,
        lastOpenedAt: 2,
    },
];

function request(id: string, method: keyof typeof methods, parameters: unknown = {}) {
    return { protocolVersion: CAXRI_PROTOCOL_VERSION, id, method, params: parameters };
}

describe('@caxri/protocol contract', () => {
    it('publishes one stable version, closed errors, principals, and browser-safe capabilities', () => {
        expect(CAXRI_PROTOCOL_VERSION).toBe(2);
        expect(negotiateProtocolVersion([0, 2])).toBe(2);
        expect(() => negotiateProtocolVersion([1])).toThrow();
        expect(errorCodes).toContain('CANCELLED');
        expect(errorCodes).toContain('FORBIDDEN');
        expect(capabilityIds).toContain('desktop.window');
        expect(capabilityIds).toContain('terminals.steer');
        expect(capabilityIds).toContain('terminals.preview');
        const welcome = protocolWelcomeSchema.parse({
            protocolVersion: 2,
            principal: desktop.principal,
            capabilities: desktop.capabilities,
            commands: Object.keys(methods),
        });
        expect(welcome.commands).toContain('app.bootstrap');
        expect(welcome.commands).toContain('project.list');
        expect(
            principalProjectionSchemas.project.safeParse({ id: 'p1', displayTitle: 'P' }).success,
        ).toBe(true);
        expect(
            serverEventSchema.safeParse({
                event: 'files.changed',
                payload: { changes: [], overflow: false, sessionId: 'session-1' },
            }).success,
        ).toBe(false);
        expect(
            serverEventSchema.safeParse({
                event: 'files.changed',
                payload: {
                    changes: [],
                    overflow: false,
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            }).success,
        ).toBe(true);
    });

    it('gives every command one owner, effect, capability set, schemas, and idempotency policy', () => {
        for (const [name, spec] of Object.entries(methods)) {
            expect(['server', 'desktop'], name).toContain(spec.owner);
            expect(['read', 'write', 'control'], name).toContain(spec.effect);
            expect(['none', 'request'], name).toContain(spec.idempotency);
            expect(spec.requiredCapabilities.length, name).toBeGreaterThan(0);
            expect(spec.params.safeParse(undefined), name).toHaveProperty('success');
            expect(spec.result.safeParse(undefined), name).toHaveProperty('success');
        }
        expect(methods['app.bootstrap'].requiredCapabilities).toEqual(['desktop']);
        expect(methods['agentSkills.get'].requiredCapabilities).toEqual(['desktop']);
        expect(methods['app.health'].requiredCapabilities).toEqual(['host.read']);
        expect(methods['host.stop'].requiredCapabilities).toEqual(['host.stop']);
        expect(methods['project.list'].requiredCapabilities).toEqual(['projects.read']);
        expect(methods['agent.dispatch.start'].requiredCapabilities).toEqual(['agents.dispatch']);
        expect(methods['agent.dispatch.status'].requiredCapabilities).toEqual(['agents.read']);
        expect(methods['agent.dispatch.wait'].requiredCapabilities).toEqual(['agents.read']);
        expect(methods['agent.control.stop'].requiredCapabilities).toEqual(['agents.control']);
        expect(methods['terminal.send'].requiredCapabilities).toEqual(['terminals.steer']);
    });

    it('keeps Desktop skill health bounded and path-free', () => {
        const health = agentSkillHealthSchema.parse({
            bundled: {
                bundledVersion: '0.0.6',
                compatibility: { cliVersion: '0.0.6', protocolVersion: 2 },
                contentHash: `sha256:${'a'.repeat(64)}`,
                files: ['SKILL.md', 'agents/openai.yaml'],
                name: 'caxri-cli',
                schemaVersion: 1,
            },
            installations: [
                {
                    action: 'No action is required.',
                    bundledVersion: '0.0.6',
                    compatible: true,
                    contentHash: `sha256:${'a'.repeat(64)}`,
                    installedSchemaVersion: 1,
                    installedVersion: '0.0.6',
                    name: 'caxri-cli',
                    protocolVersion: 2,
                    provider: 'codex',
                    reason: 'matches-bundle',
                    scope: 'local',
                    status: 'compatible',
                    path: '/private/project/.agents/skills/caxri-cli',
                },
            ],
            selectedProjectId: 'project-1',
        });
        expect(health.installations[0]).not.toHaveProperty('path');
    });

    it('rejects opaque task payloads from the text-only Agent Inbox schema', () => {
        expect(
            methods['agent.message.send'].params.safeParse({
                to: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                body: 'plain peer text',
                task: { command: 'session.delete' },
            }).success,
        ).toBe(false);
    });

    it('keeps bounded authoritative Runtime operations alive until their own result', () => {
        expect(isNonExpiringServerOperation('files.copy')).toBe(true);
        expect(isNonExpiringServerOperation('files.write')).toBe(true);
        expect(isNonExpiringServerOperation('agent.dispatch.waitInternal')).toBe(true);
        expect(isNonExpiringServerOperation('terminal.input')).toBe(true);
        expect(isNonExpiringServerOperation('files.read')).toBe(false);
    });

    it('keeps human steer bounded and distinct from peer text', () => {
        expect(
            methods['terminal.send'].params.safeParse({
                terminalId: 'terminal-1',
                text: 'human input',
                enter: true,
            }).success,
        ).toBe(true);
        expect(
            methods['terminal.send'].params.safeParse({
                terminalId: 'terminal-1',
                text: 'unsafe\rinput',
            }).success,
        ).toBe(false);
        expect(
            methods['terminal.send'].params.safeParse({
                terminalId: 'terminal-1',
                text: `unsafe${String.fromCodePoint(0x9b)}input`,
            }).success,
        ).toBe(false);
        expect(
            methods['agent.message.send'].params.parse({
                to: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                body: 'peer text',
            }),
        ).toMatchObject({ wake: false });
    });

    it('negotiates only commands reachable by the authenticated principal', () => {
        const welcome = createProtocolWelcome(
            { server: { invoke: () => null } },
            { supportedVersions: [2] },
            human,
        );
        expect(welcome).toMatchObject({
            protocolVersion: 2,
            principal: human.principal,
            capabilities: ['projects.read'],
        });
        expect(welcome.commands).toContain('project.list');
        expect(welcome.commands).not.toContain('app.bootstrap');
        expect(welcome.commands).not.toContain('processExplorer.open');
    });

    it('does not negotiate or parse the retired raw git.diff command', () => {
        const welcome = createProtocolWelcome(
            { server: { invoke: () => null } },
            { supportedVersions: [2] },
            desktop,
        );

        expect(welcome.commands).not.toContain('git.diff');
        expect(
            requestEnvelopeSchema.safeParse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: 'git-diff-1',
                method: 'git.diff',
                params: { sessionId: 'session-1', repositoryId: 'repository-1', path: 'README.md' },
            }).success,
        ).toBe(false);
        expect(() =>
            parseServerOperationRequest('git.diff', {
                sessionId: 'session-1',
                repositoryId: 'repository-1',
                path: 'README.md',
            }),
        ).toThrow('Unknown Runtime method: git.diff');
    });

    it('keeps Host discovery parseable across protocol versions without exposing credentials', () => {
        const manifest = serverManifestSchema.parse({
            manifestVersion: 2,
            profileId: 'profile-1',
            endpoint: {
                protocol: 'ws',
                host: '127.0.0.1',
                port: 41_337,
                path: '/control',
            },
            pid: 42,
            startedAt: 1,
            processIdentity: '1'.repeat(32),
            protocolVersion: 2,
            version: '2.0.0',
            operatorToken: '2'.repeat(64),
        });
        expect(manifest.protocolVersion).toBe(2);
        expect(Object.keys(methods['host.status'].result.shape)).not.toContain('operatorToken');
    });

    it('negotiates the bounded Host control surface for an authenticated operator', () => {
        const welcome = createProtocolWelcome(
            { server: { invoke: () => null } },
            { supportedVersions: [2] },
            hostOperator,
        );
        expect(welcome.commands).toContain('app.health');
        expect(welcome.commands).toContain('host.status');
        expect(welcome.commands).toContain('host.stop');
        expect(welcome.commands).toContain('events.query');
        expect(welcome.commands).not.toContain('events.recover');
        expect(welcome.commands).not.toContain('project.list');
    });
});

describe('transport-neutral dispatcher', () => {
    const server: CommandAdapter = {
        invoke: (command) => {
            if (command.method === 'project.list') return { view: 'desktop', projects };
            if (command.method === 'session.rename')
                return { renamed: command.params.displayTitle };
            if (command.method === 'app.health')
                return { ready: true, pid: 42, startedAt: 1, activePtyCount: 0 };
            return null;
        },
    };

    it('preserves submission order for overlapping Terminal input', async () => {
        const invoked: string[] = [];
        const dispatch = createCommandDispatcher({
            server: {
                invoke: (command) => {
                    if (command.method === 'terminal.input') invoked.push(command.params.data);
                    return null;
                },
            },
        });
        const firstDigestGate = Promise.withResolvers<void>();
        const releaseFirstDigest = firstDigestGate.resolve;
        let digestCalls = 0;
        const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async () => {
            digestCalls += 1;
            if (digestCalls === 1) await firstDigestGate.promise;
            return new Uint8Array(32).buffer;
        });

        try {
            const first = dispatch(
                request('input-1', 'terminal.input', {
                    terminalId: 'terminal-1',
                    data: 'first',
                }),
                desktop,
            );
            const second = dispatch(
                request('input-2', 'terminal.input', {
                    terminalId: 'terminal-1',
                    data: 'second',
                }),
                desktop,
            );
            await second;
            releaseFirstDigest();
            await first;

            expect(invoked).toEqual(['first', 'second']);
        } finally {
            digest.mockRestore();
        }
    });

    it('preserves submission order for a Terminal detach followed by a reattach', async () => {
        const invoked: string[] = [];
        const dispatch = createCommandDispatcher({
            server: {
                invoke: (command) => {
                    invoked.push(command.method);
                    return null;
                },
            },
        });
        const digestGate = Promise.withResolvers<void>();
        const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async () => {
            await digestGate.promise;
            return new Uint8Array(32).buffer;
        });

        try {
            // A pane remount detaches the outgoing pane and attaches the incoming one back to back; the client's
            // detach fence assumes the Server sees them in that order, so the dispatcher must not let an
            // asynchronous fingerprint delay the detach behind the attach.
            const detach = dispatch(
                request('detach-1', 'terminal.detach', { terminalId: 'terminal-1' }),
                desktop,
            );
            const attach = dispatch(
                request('attach-1', 'terminal.attach', { terminalId: 'terminal-1' }),
                desktop,
            );
            await attach;
            digestGate.resolve();
            await detach;

            expect(invoked).toEqual(['terminal.detach', 'terminal.attach']);
        } finally {
            digest.mockRestore();
        }
    });

    it('projects the same handler result for Desktop, human CLI, and scoped Agent principals', async () => {
        const dispatch = createCommandDispatcher({ server });
        const desktopReply = await dispatch(request('r1', 'project.list'), desktop);
        const humanReply = await dispatch(request('r2', 'project.list'), human);
        const agentReply = await dispatch(request('r3', 'project.list'), agent);

        expect(desktopReply).toMatchObject({
            ok: true,
            result: { view: 'desktop', projects },
        });
        expect(humanReply).toMatchObject({
            ok: true,
            result: {
                view: 'human-cli',
                projects: [
                    {
                        id: 'project-1',
                        displayTitle: 'Project One',
                        rootPath: '/private/project-one',
                    },
                    {
                        id: 'project-2',
                        displayTitle: 'Project Two',
                        rootPath: '/private/project-two',
                    },
                ],
            },
        });
        expect(agentReply).toEqual({
            protocolVersion: 2,
            id: 'r3',
            ok: true,
            result: {
                view: 'agent',
                projects: [{ id: 'project-1', displayTitle: 'Project One' }],
            },
        });
        expect(JSON.stringify(agentReply)).not.toContain('/private/');
        expect(JSON.stringify(agentReply)).not.toContain('project-2');
        const secretFields = { sourceContent: 'must be stripped', token: 'must be stripped' };
        const projections = [
            principalProjectionSchemas.project.parse({
                id: 'project-1',
                displayTitle: 'Project One',
                ...secretFields,
            }),
            principalProjectionSchemas.session.parse({
                attentionEpoch: 0,
                hasUnread: false,
                id: 'session-1',
                projectId: 'project-1',
                displayTitle: 'Session',
                lastOpenedAt: 1,
                lastActivityState: 'running',
                ...secretFields,
            }),
            principalProjectionSchemas.terminal.parse({
                id: 'terminal-1',
                sessionId: 'session-1',
                kind: 'codex',
                lastProcessState: 'running',
                ...secretFields,
            }),
            principalProjectionSchemas.settings.parse({
                'session.defaultAgent': null,
                'terminal.fontSize': 13,
                'terminal.scrollback': 2_000,
                'terminal.copyOnSelect': true,
                'terminal.gpuAcceleration': 'off',
                'terminal.osc52ClipboardWrite': false,
                'files.maxFileBytes': 2_000_000,
                ...secretFields,
            }),
            principalProjectionSchemas.diagnostics.parse({
                appVersion: '1.0.0',
                protocolVersion: 2,
                runtimeStatus: 'ready',
                projectCount: 1,
                sessionCount: 1,
                terminalCount: 1,
                ...secretFields,
            }),
            principalProjectionSchemas.agent.parse({
                provider: 'codex',
                status: 'working',
                available: true,
                ...secretFields,
            }),
        ];
        for (const projected of projections) {
            expect(projected).not.toHaveProperty('sourceContent');
            expect(projected).not.toHaveProperty('token');
        }
    });

    it('enforces capability checks and a stable unavailable Desktop owner', async () => {
        const dispatch = createCommandDispatcher({ server });
        await expect(dispatch(request('r1', 'app.bootstrap'), human)).resolves.toMatchObject({
            ok: false,
            error: { code: 'FORBIDDEN' },
        });
        await expect(dispatch(request('r2', 'processExplorer.open'), desktop)).resolves.toEqual({
            protocolVersion: 2,
            id: 'r2',
            ok: false,
            error: { code: 'UNAVAILABLE', message: 'Desktop is unavailable' },
        });
        await expect(
            dispatch(
                { protocolVersion: 2, id: 'invalid-method', method: 'shell.exec', params: {} },
                desktop,
            ),
        ).resolves.toMatchObject({
            id: 'invalid-method',
            ok: false,
            error: { code: 'VALIDATION' },
        });
    });

    it('coalesces repeated write request IDs and rejects mismatched replay', async () => {
        let writes = 0;
        const gateResolvers = Promise.withResolvers<void>();
        const release = gateResolvers.resolve;
        const gate = gateResolvers.promise;
        const dispatch = createCommandDispatcher({
            server: {
                invoke: async (command, context, invocation) => {
                    if (command.method !== 'session.rename')
                        return server.invoke(command, context, invocation);
                    writes += 1;
                    await gate;
                    return {
                        id: 'session-1',
                        projectId: 'project-1',
                        rootPath: '/private/project-one',
                        displayTitle: command.params.displayTitle,
                        titleMode: 'manual',
                        createdAt: 1,
                        lastOpenedAt: 1,
                        sidebarOrder: 0,
                        lastSessionActivityAt: 1,
                        lastSessionActivityReason: 'created',
                        archivedAt: undefined,
                        primaryAgentTerminalId: undefined,
                        lastActivityState: 'unknown',
                        attentionEpoch: 0,
                        readAttentionEpoch: 0,
                        hasUnread: false,
                    };
                },
            },
        });
        const first = dispatch(
            request('same-id', 'session.rename', {
                sessionId: 'session-1',
                displayTitle: 'Renamed',
            }),
            desktop,
        );
        const duplicate = dispatch(
            request('same-id', 'session.rename', {
                sessionId: 'session-1',
                displayTitle: 'Renamed',
            }),
            desktop,
        );
        await expect.poll(() => writes).toBe(1);
        release();
        await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
        expect(writes).toBe(1);
        await expect(
            dispatch(
                request('same-id', 'session.rename', {
                    sessionId: 'session-1',
                    displayTitle: 'Different',
                }),
                desktop,
            ),
        ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    });
});

describe('recoverable event cursor', () => {
    const changed = (reason: 'project.create' | 'session.create'): ServerEvent => ({
        event: 'state.changed',
        payload: { kind: 'full', reason },
    });

    it('replays an intact suffix, detects gaps, drops duplicates, and bounds snapshots', async () => {
        const journal = createEventJournal({
            maximumEvents: 2,
            snapshot: (cursor) => ({
                cursor,
                projectIds: ['project-1'],
                sessionIds: ['session-1'],
                terminalIds: [],
                settingsRevision: 1,
                diagnosticsRevision: 1,
                agentRevision: 1,
            }),
        });
        const first = journal.publish(changed('project.create'));
        const second = journal.publish(changed('session.create'));
        await expect(journal.recover(1)).resolves.toEqual({
            kind: 'events',
            cursor: 2,
            events: [second],
        });
        const accepted = acceptEventSequence(0, [first, first, second]);
        expect(accepted).toMatchObject({ kind: 'accepted', cursor: 2 });
        expect(acceptEventSequence(0, [second])).toEqual({
            kind: 'gap',
            cursor: 0,
            expectedCursor: 1,
            receivedCursor: 2,
        });
        journal.publish(changed('project.create'));
        await expect(journal.recover(0)).resolves.toMatchObject({
            kind: 'snapshot',
            cursor: 3,
            snapshot: { projectIds: ['project-1'] },
        });
        expect(JSON.stringify(await journal.recover(0))).not.toContain('terminal.output');
        expect(() =>
            journal.publish({
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'secret output' },
            }),
        ).toThrow('Transient events cannot enter durable protocol replay');
        expect(() =>
            journal.publish({
                event: 'command.execute',
                payload: { command: 'session.delete' },
            }),
        ).toThrow('Transient events cannot enter durable protocol replay');
    });

    it('projects CLI recovery to typed names without configuration source or record IDs', () => {
        expect(
            projectObservableEventRecovery({
                kind: 'events',
                cursor: 1,
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
                barrier: { kind: 'live', cursor: 1 },
                events: [
                    {
                        protocolVersion: 2,
                        cursor: 1,
                        serverId: 'a'.repeat(32),
                        stateEpoch: 'b'.repeat(32),
                        event: {
                            event: 'settings.changed',
                            payload: { source: 'secret-sentinel' },
                        },
                    },
                ],
            }),
        ).toEqual({
            kind: 'events',
            cursor: 1,
            events: [{ cursor: 1, event: 'settings.changed' }],
        });
        expect(
            projectObservableEventRecovery({
                kind: 'snapshot',
                cursor: 2,
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
                barrier: { kind: 'live', cursor: 2 },
                snapshot: {
                    cursor: 2,
                    projectIds: ['private-project'],
                    sessionIds: ['private-session'],
                    terminalIds: ['private-terminal'],
                    settingsRevision: 2,
                    diagnosticsRevision: 2,
                    agentRevision: 2,
                },
            }),
        ).toEqual({ kind: 'snapshot', cursor: 2, gap: true });
    });

    it('keeps events published during an asynchronous snapshot behind its frozen cursor', async () => {
        const snapshotBlockedResolvers = Promise.withResolvers<void>();
        const releaseSnapshot = snapshotBlockedResolvers.resolve;
        const snapshotBlocked = snapshotBlockedResolvers.promise;
        const journal = createEventJournal({
            maximumEvents: 1,
            snapshot: async (cursor) => {
                await snapshotBlocked;
                return {
                    cursor,
                    projectIds: [],
                    sessionIds: [],
                    terminalIds: [],
                    settingsRevision: cursor,
                    diagnosticsRevision: cursor,
                    agentRevision: cursor,
                };
            },
        });
        journal.publish(changed('project.create'));
        journal.publish(changed('session.create'));
        const recovering = journal.recover(0);
        const later = journal.publish(changed('project.create'));
        releaseSnapshot();

        await expect(recovering).resolves.toMatchObject({ kind: 'snapshot', cursor: 2 });
        await expect(journal.recover(2)).resolves.toEqual({
            kind: 'events',
            cursor: 3,
            events: [later],
        });
    });
});
