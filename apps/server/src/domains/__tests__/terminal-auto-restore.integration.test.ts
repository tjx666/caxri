import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent, TerminalKind } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { CaxriDatabase } from '../db/repository';
import {
    createFakePty,
    createPendingAgentAdapters,
    writeClaudeTranscript,
} from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

describe('Interrupted Terminal auto-restore (GitHub issue #18)', () => {
    it.each([
        {
            provider: 'claude' as const,
            resumeArguments: ['--resume', 'claude-session-1'],
            sessionId: 'claude-session-1',
        },
        {
            provider: 'codex' as const,
            resumeArguments: ['resume', 'codex-session-1'],
            sessionId: 'codex-session-1',
        },
    ])(
        'resumes an interrupted $provider Terminal with its bound Agent session id',
        async ({ provider, resumeArguments, sessionId }) => {
            const directory = await mkdtemp(join(tmpdir(), `caxri-runtime-${provider}-restore-`));
            temporaryDirectories.push(directory);
            const userDataPath = join(directory, 'user-data');
            const projectRoot = join(directory, 'project');
            await mkdir(projectRoot);
            const resolveExecutable = (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : `/usr/local/bin/${provider}`);

            const domainsA = await createTestDomainServices({
                userDataPath,
                logger: new StructuredLogger(join(directory, 'logs-a')),
                send: () => {},
                terminal: { resolveExecutable, spawn: () => createFakePty() },
                agentAdapters: createPendingAgentAdapters(),
            });
            const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
            const created = await domainsA.handlers['session.create']({
                projectId: project.id,
                defaultAgent: provider,
            });
            expect(created.terminal!.provider).toBe(provider);
            /**
             * Orderly close marks the still-running Terminal `interrupted`, not `stopped`/`dead`.
             */
            await domainsA.close();

            /**
             * Simulate a capability-detected Agent session id having been bound before the shutdown; done through the
             * raw better-sqlite3 handle because `updateAgentMetadata` requires a matching provider snapshot, which this
             * hermetic test does not produce.
             */
            const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
            const interrupted = direct.getTerminal(created.terminal!.id);
            expect(interrupted?.lastAgentProcessState).toBe('interrupted');
            direct.database
                .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                .run(sessionId, created.terminal!.id);
            direct.close();
            const homeDirectory = join(directory, 'home');
            if (provider === 'claude')
                await writeClaudeTranscript(homeDirectory, project.rootPath, sessionId);

            const spawnSpy = vi.fn<typeof spawnPty>(() => createFakePty());
            const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
            const domainsB = await createTestDomainServices({
                agentEnvironment: { homeDirectory, variables: {} },
                userDataPath,
                terminalRestoreGridWaitMs: 0,
                logger: new StructuredLogger(join(directory, 'logs-b')),
                send: () => {},
                terminal: { resolveExecutable, spawn: spawnSpy },
                agentAdapters: createPendingAgentAdapters(),
            });
            try {
                await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalled());
                expect(spawnSpy.mock.calls[0]?.[0]).toBe('/bin/zsh');
                const agent = start.mock.calls[0]?.[0].agent;
                expect(agent?.executable).toBe(`/usr/local/bin/${provider}`);
                expect(agent?.args).toEqual([
                    ...(provider === 'codex' ? ['-c', 'tui.auto_recap=false'] : []),
                    ...defaultAgentProviderSettings[provider].launch.args,
                    ...resumeArguments,
                ]);
                const bootstrap = await vi.waitFor(async () => {
                    const state = await domainsB.handlers['app.bootstrap']({});
                    const terminal = state.terminals.find(
                        (entry) => entry.id === created.terminal!.id,
                    );
                    expect(terminal?.lastProcessState).toBe('running');
                    expect(terminal?.lastAgentProcessState).toBe('running');
                    return state;
                });
                const restoredTerminal = bootstrap.terminals.find(
                    (entry) => entry.id === created.terminal!.id,
                );
                expect(restoredTerminal?.agentSessionId).toBe(sessionId);
            } finally {
                await domainsB.close();
            }
        },
    );

    it("restores a Session's interrupted Terminals concurrently", async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-concurrent-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);

        const domainsA = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });
        const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
        const created = await domainsA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        const second = await domainsA.handlers['terminal.create']({
            sessionId: created.session.id,
            kind: 'shell',
        });
        await domainsA.close();

        const { promise: discoveryGate, resolve: releaseDiscovery } = Promise.withResolvers<void>();
        const resolveExecutable = vi.fn(async () => {
            await discoveryGate;
            return '/bin/zsh';
        });
        const spawnSpy = vi.fn(() => createFakePty());
        const events: ServerEvent[] = [];
        const domainsB = await createTestDomainServices({
            userDataPath,
            terminalRestoreGridWaitMs: 0,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: (event) => {
                events.push(event);
            },
            terminal: { resolveExecutable, spawn: spawnSpy },
        });
        try {
            await vi.waitFor(() => expect(resolveExecutable).toHaveBeenCalledTimes(2));
            releaseDiscovery();
            await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => {
                const restored = events.find(
                    (event) =>
                        event.event === 'state.changed' &&
                        event.payload.kind === 'records' &&
                        event.payload.terminalIds.length === 2,
                );
                if (restored?.event !== 'state.changed' || restored.payload.kind !== 'records')
                    throw new Error('Missing scoped restore event');
                expect(new Set(restored.payload.terminalIds)).toEqual(
                    new Set([created.terminal!.id, second.id]),
                );
            });
        } finally {
            releaseDiscovery();
            await domainsB.close();
        }
    });

    it('restarts an interrupted Agent Terminal without a bound session fresh, and never auto-restarts an explicitly terminated one', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-restore-fresh-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const resolveExecutable = (kind: TerminalKind) =>
            Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude');

        const domainsA = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-a')),
            send: () => {},
            terminal: { resolveExecutable, spawn: () => createFakePty() },
            agentAdapters: createPendingAgentAdapters(),
        });
        const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
        const created = await domainsA.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'claude',
        });
        /**
         * No Agent session id was ever bound, so the orderly close leaves `agentSessionId` unset.
         */
        await domainsA.close();
        const freshSpawnSpy = vi.fn<typeof spawnPty>(() => createFakePty());
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const domainsB = await createTestDomainServices({
            userDataPath,
            terminalRestoreGridWaitMs: 0,
            logger: new StructuredLogger(join(directory, 'logs-b')),
            send: () => {},
            terminal: { resolveExecutable, spawn: freshSpawnSpy },
            agentAdapters: createPendingAgentAdapters(),
        });
        try {
            await vi.waitFor(() => expect(freshSpawnSpy).toHaveBeenCalled());
            expect(freshSpawnSpy.mock.calls[0]?.[0]).toBe('/bin/zsh');
            expect(start.mock.calls[0]?.[0].agent?.executable).toBe('/usr/local/bin/claude');
            expect(start.mock.calls[0]?.[0].agent?.args).toEqual(
                defaultAgentProviderSettings.claude.launch.args,
            );
            await domainsB.handlers['terminal.terminateAll']({});
            const afterTerminate = await domainsB.handlers['app.bootstrap']({});
            expect(
                afterTerminate.terminals.find((entry) => entry.id === created.terminal!.id)
                    ?.lastProcessState,
            ).toBe('stopped');
        } finally {
            await domainsB.close();
        }

        const noRestartSpawnSpy = vi.fn();
        noRestartSpawnSpy.mockImplementation(() => createFakePty());
        const domainsC = await createTestDomainServices({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs-c')),
            send: () => {},
            terminal: { resolveExecutable, spawn: noRestartSpawnSpy },
            agentAdapters: createPendingAgentAdapters(),
        });
        try {
            /**
             * Give the fire-and-forget restore a beat to (not) run before asserting it stayed idle.
             */
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(noRestartSpawnSpy).not.toHaveBeenCalled();
        } finally {
            await domainsC.close();
        }
    });
});
