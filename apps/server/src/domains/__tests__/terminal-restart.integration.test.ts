import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createTestTerminalExecution } from '../../__tests__/support/terminal';
import { CaxriDatabase } from '../db/repository';
import {
    createFakePty,
    createPendingAgentAdapters,
    writeClaudeTranscript,
} from './create-test-domain-services';

const temporaryDirectories: string[] = [];

/**
 * Seeds the bound Terminal before Runtime opens the database. A second live connection would run startup recovery and
 * turn the fixture's active Agent state into `failed`, hiding what the restart handler itself changed.
 */
function seedStoppedAgentSession(
    userDataPath: string,
    projectRoot: string,
    provider: AgentProvider,
    agentSessionId: string,
) {
    const database = new CaxriDatabase(join(userDataPath, 'caxri.db'));
    const created = database.createSession(database.createProject(projectRoot).id, provider);
    database.database
        .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
        .run(agentSessionId, created.terminal!.id);
    database.updateTerminalState(created.terminal!.id, 'stopped');
    database.close();
    return created;
}

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent Terminal restart', () => {
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
        'resumes a bound $provider session by default',
        async ({ provider, resumeArguments, sessionId }) => {
            const directory = await mkdtemp(join(tmpdir(), `caxri-runtime-${provider}-restart-`));
            temporaryDirectories.push(directory);
            const userDataPath = join(directory, 'user-data');
            const projectRoot = join(directory, 'project');
            await Promise.all([mkdir(projectRoot), mkdir(userDataPath)]);
            const canonicalProjectRoot = await realpath(projectRoot);
            const created = seedStoppedAgentSession(
                userDataPath,
                canonicalProjectRoot,
                provider,
                sessionId,
            );
            const homeDirectory = join(directory, 'home');
            if (provider === 'claude')
                await writeClaudeTranscript(homeDirectory, canonicalProjectRoot, sessionId);
            const createdActivityAt = created.session.lastSessionActivityAt;
            const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
            const logger = new StructuredLogger(join(directory, 'logs'));
            const execution = createTestTerminalExecution(logger, { spawn });
            const start = vi.spyOn(execution, 'start');
            const runtime = await createTestDomainServices({
                agentEnvironment: { homeDirectory, variables: {} },
                userDataPath,
                logger,
                send: () => {},
                terminal: {
                    execution,
                    resolveExecutable: (kind) =>
                        Promise.resolve(
                            kind === 'shell' ? '/bin/zsh' : `/usr/local/bin/${provider}`,
                        ),
                },
                agentAdapters: createPendingAgentAdapters(),
            });

            try {
                await runtime.handlers['terminal.restart']({
                    terminalId: created.terminal!.id,
                    mode: 'resume',
                });

                expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
                expect(spawn.mock.calls[0]?.[1]).toEqual(['-l']);
                expect(start.mock.calls[0]?.[0]).toMatchObject({
                    executable: '/bin/zsh',
                    args: ['-l'],
                    agent: {
                        provider,
                        executable: `/usr/local/bin/${provider}`,
                        args: [
                            ...(provider === 'codex' ? ['-c', 'tui.auto_recap=false'] : []),
                            ...defaultAgentProviderSettings[provider].launch.args,
                            ...resumeArguments,
                        ],
                    },
                });
                const bootstrap = await runtime.handlers['app.bootstrap']({});
                const restartedSession = bootstrap.sessions.find(
                    (session) => session.id === created.session.id,
                )!;
                expect(restartedSession.lastSessionActivityAt).toBeGreaterThan(createdActivityAt);
                expect(restartedSession.lastSessionActivityReason).toBe('agent_started');
                expect(restartedSession.lastActivityState).toBe('idle');
                expect(
                    bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id),
                ).toMatchObject({
                    agentSessionId: sessionId,
                    lastProcessState: 'running',
                    lastAgentProcessState: 'running',
                });
            } finally {
                await runtime.close();
            }
        },
    );

    it('starts the Agent on a fresh restart even after it exited on its own', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-fresh-exited-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await Promise.all([mkdir(projectRoot), mkdir(userDataPath)]);
        const created = seedStoppedAgentSession(
            userDataPath,
            await realpath(projectRoot),
            'codex',
            'codex-session-old',
        );
        const seeded = new CaxriDatabase(join(userDataPath, 'caxri.db'));
        seeded.updateAgentProcessState(created.terminal!.id, 'stopped');
        seeded.close();
        const logger = new StructuredLogger(join(directory, 'logs'));
        const execution = createTestTerminalExecution(logger, { spawn: () => createFakePty() });
        const start = vi.spyOn(execution, 'start');
        const runtime = await createTestDomainServices({
            userDataPath,
            logger,
            send: () => {},
            terminal: {
                execution,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            await runtime.handlers['terminal.restart']({
                terminalId: created.terminal!.id,
                mode: 'fresh',
            });

            expect(start.mock.calls[0]?.[0].agent).toMatchObject({ provider: 'codex' });
        } finally {
            await runtime.close();
        }
    });

    it('starts fresh only when restart explicitly requests it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-fresh-restart-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await Promise.all([mkdir(projectRoot), mkdir(userDataPath)]);
        const canonicalProjectRoot = await realpath(projectRoot);
        const created = seedStoppedAgentSession(
            userDataPath,
            canonicalProjectRoot,
            'codex',
            'codex-session-old',
        );
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const logger = new StructuredLogger(join(directory, 'logs'));
        const execution = createTestTerminalExecution(logger, { spawn });
        const start = vi.spyOn(execution, 'start');
        const runtime = await createTestDomainServices({
            userDataPath,
            logger,
            send: () => {},
            terminal: {
                execution,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/codex'),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            await runtime.handlers['terminal.restart']({
                terminalId: created.terminal!.id,
                mode: 'fresh',
            });

            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
            expect(spawn.mock.calls[0]?.[1]).toEqual(['-l']);
            expect(start.mock.calls[0]?.[0]).toMatchObject({
                executable: '/bin/zsh',
                args: ['-l'],
                agent: {
                    provider: 'codex',
                    executable: '/usr/local/bin/codex',
                    args: [
                        '-c',
                        'tui.auto_recap=false',
                        ...defaultAgentProviderSettings.codex.launch.args,
                    ],
                },
            });
            const bootstrap = await runtime.handlers['app.bootstrap']({});
            expect(
                bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id),
            ).toMatchObject({
                agentSessionId: undefined,
                lastProcessState: 'running',
                lastAgentProcessState: 'running',
            });
        } finally {
            await runtime.close();
        }
    });

    it.each([
        { launchedInYolo: true, settingsArgs: [] as string[] },
        { launchedInYolo: false, settingsArgs: ['--dangerously-skip-permissions'] },
    ])(
        'keeps the replaced Agent Run in YOLO=$launchedInYolo when resuming after Settings changed',
        async ({ launchedInYolo, settingsArgs }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-claude-yolo-restart-'));
            temporaryDirectories.push(directory);
            const userDataPath = join(directory, 'user-data');
            const projectRoot = join(directory, 'project');
            await Promise.all([mkdir(projectRoot), mkdir(userDataPath)]);
            const canonicalProjectRoot = await realpath(projectRoot);
            const sessionId = 'claude-session-yolo';
            const created = seedStoppedAgentSession(
                userDataPath,
                canonicalProjectRoot,
                'claude',
                sessionId,
            );
            const homeDirectory = join(directory, 'home');
            await writeClaudeTranscript(homeDirectory, canonicalProjectRoot, sessionId);
            const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
            const logger = new StructuredLogger(join(directory, 'logs'));
            const execution = createTestTerminalExecution(logger, { spawn });
            const start = vi.spyOn(execution, 'start');
            let launchArguments = launchedInYolo
                ? ['--dangerously-skip-permissions', '--verbose']
                : ['--verbose'];
            const runtime = await createTestDomainServices({
                agentEnvironment: { homeDirectory, variables: {} },
                userDataPath,
                logger,
                send: () => {},
                terminal: {
                    agentLaunchSettings: () => ({ executable: 'claude', args: launchArguments }),
                    execution,
                    resolveExecutable: (kind) =>
                        Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude'),
                },
                agentAdapters: createPendingAgentAdapters(),
            });
            const terminalId = created.terminal!.id;
            const launchedArguments = (call: number) => start.mock.calls[call]?.[0].agent?.args;

            try {
                await runtime.handlers['terminal.restart']({ terminalId, mode: 'resume' });
                expect(launchedArguments(0)).toEqual([...launchArguments, '--resume', sessionId]);

                launchArguments = [...settingsArgs, '--verbose'];
                await runtime.handlers['terminal.restart']({ terminalId, mode: 'resume' });
                expect(launchedArguments(1)).toEqual([
                    ...(launchedInYolo ? ['--dangerously-skip-permissions'] : []),
                    '--verbose',
                    '--resume',
                    sessionId,
                ]);

                await runtime.handlers['terminal.restart']({ terminalId, mode: 'fresh' });
                expect(launchedArguments(2)).toEqual(launchArguments);
            } finally {
                await runtime.close();
            }
        },
    );

    it('starts a Claude Code Agent fresh when its conversation was never written', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-claude-unwritten-restart-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await Promise.all([mkdir(projectRoot), mkdir(userDataPath)]);
        const created = seedStoppedAgentSession(
            userDataPath,
            await realpath(projectRoot),
            'claude',
            'claude-session-unwritten',
        );
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const logger = new StructuredLogger(join(directory, 'logs'));
        const execution = createTestTerminalExecution(logger, { spawn });
        const start = vi.spyOn(execution, 'start');
        const runtime = await createTestDomainServices({
            agentEnvironment: { homeDirectory: join(directory, 'home'), variables: {} },
            userDataPath,
            logger,
            send: () => {},
            terminal: {
                execution,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude'),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            await runtime.handlers['terminal.restart']({
                terminalId: created.terminal!.id,
                mode: 'resume',
            });

            expect(start.mock.calls[0]?.[0]).toMatchObject({
                agent: {
                    provider: 'claude',
                    args: [...defaultAgentProviderSettings.claude.launch.args],
                },
            });
            const bootstrap = await runtime.handlers['app.bootstrap']({});
            expect(
                bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id),
            ).toMatchObject({ agentSessionId: undefined, lastAgentProcessState: 'running' });
        } finally {
            await runtime.close();
        }
    });
});
