import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { GitService } from '../git';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];

/**
 * An installed executable that makes provider discovery independent of host Codex or Claude installations. The fake
 * Terminal adapter owns launch behavior, so hook integration tests never start this executable.
 */
const installedProviderExecutable = process.execPath;

afterEach(async () => {
    vi.restoreAllMocks();
    await flushLoggers();
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime Agent hook integration', () => {
    it('does not read worktree topology for an Agent launch when provider hooks are disabled', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-hook-disabled-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const topology = vi.spyOn(GitService.prototype, 'worktreeTopology');
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEnvironment: { homeDirectory: directory, variables: {} },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: createLogger(join(directory, 'logs')),
            hookExecutable: process.execPath,
            send: () => {},
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn: vi.fn<typeof spawnPty>(() => createFakePty()),
            },
            userDataPath: join(directory, 'user-data'),
        });

        try {
            // Hooks default to enabled; this case is specifically about the disabled path.
            const currentSettings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'agents.providers': {
                        ...currentSettings.value['agents.providers'],
                        codex: {
                            ...currentSettings.value['agents.providers'].codex,
                            hooks: { enabled: false },
                        },
                    },
                }),
            });
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            topology.mockClear();

            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });

            expect(created.terminal).toMatchObject({ lastProcessState: 'running' });
            expect(topology).not.toHaveBeenCalled();
        } finally {
            await runtime.close();
        }
    });

    it('projects authenticated Codex compaction without turning it into Session attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-hook-unread-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const codexHome = join(directory, 'codex');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const execution = new LocalTerminalExecution({
            logger: createLogger(join(directory, 'logs')),
            spawn,
        });
        const runtime = await createTestDomainServices({
            terminalExecution: execution,
            agentAdapters: createPendingAgentAdapters(),
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: createLogger(join(directory, 'logs')),
            hookExecutable: process.execPath,
            send: () => {},
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn,
            },
            userDataPath: join(directory, 'user-data'),
        });

        try {
            const currentSettings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'agents.providers': {
                        ...currentSettings.value['agents.providers'],
                        codex: {
                            ...currentSettings.value['agents.providers'].codex,
                            hooks: { enabled: true },
                            launch: {
                                ...currentSettings.value['agents.providers'].codex.launch,
                                executable: installedProviderExecutable,
                            },
                        },
                    },
                }),
            });
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const background = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const backgroundCreatedAt = background.session.lastSessionActivityAt;
            const selected = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect((await runtime.handlers['app.bootstrap']({})).selectedSessionId).toBe(
                selected.session.id,
            );

            expect(background.terminal).toMatchObject({
                lastProcessState: 'running',
                lastAgentProcessState: 'running',
            });
            expect(spawn.mock.calls[0]?.[0]).toBe('/bin/zsh');
            const rootEnvironment = spawn.mock.calls[0]?.[2].env;
            expect(rootEnvironment).toHaveProperty(
                'CAXRI_HOOK_TERMINAL_ID',
                background.terminal!.id,
            );
            expect(rootEnvironment).not.toHaveProperty('CAXRI_AGENT_ENDPOINT_TOKEN');
            const launchPlan = start.mock.calls[0]?.[0];
            expect(launchPlan).toMatchObject({
                executable: '/bin/zsh',
                agent: {
                    executable: '/bin/echo',
                    provider: 'codex',
                },
            });
            const environment = launchPlan.agent?.environment;
            expect(rootEnvironment?.CAXRI_HOOK_TOKEN).not.toBe(environment?.CAXRI_HOOK_TOKEN);
            expect(rootEnvironment?.CAXRI_HOOK_LAUNCH_ID).not.toBe(
                environment?.CAXRI_HOOK_LAUNCH_ID,
            );
            expect(environment).toMatchObject({
                CAXRI_HOOK_TERMINAL_ID: background.terminal!.id,
            });
            expect(
                [
                    'CAXRI_HOOK_LAUNCH_ID',
                    'CAXRI_HOOK_RECEIPTS',
                    'CAXRI_HOOK_RUNTIME',
                    'CAXRI_HOOK_SOCKET',
                    'CAXRI_HOOK_TERMINAL_ID',
                    'CAXRI_HOOK_TOKEN',
                ].every((key) => typeof environment?.[key] === 'string' && environment[key] !== ''),
            ).toBe(true);
            const bridge = join(directory, 'shared-hooks', 'bin', 'caxri-agent-hook-bridge');
            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: { ...process.env, ...rootEnvironment } },
            );
            expect(
                (
                    await runtime.handlers['app.records']({
                        sessionIds: [background.session.id],
                        terminalIds: [],
                    })
                ).sessions[0]?.lastActivityState,
            ).toBe('idle');
            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'compactionStarted'],
                { env: { ...process.env, ...environment } },
            );
            await expect
                .poll(async () => {
                    const records = await runtime.handlers['app.records']({
                        sessionIds: [background.session.id],
                        terminalIds: [background.terminal!.id],
                    });
                    return { session: records.sessions[0], terminal: records.terminals[0] };
                })
                .toMatchObject({
                    session: { attentionEpoch: 0, hasUnread: false },
                    terminal: { agentOperation: 'compacting' },
                });
            expect(
                (await runtime.handlers['app.bootstrap']({})).terminals.find(
                    (terminal) => terminal.id === background.terminal!.id,
                ),
            ).toMatchObject({ agentOperation: 'compacting' });

            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'compactionFinished'],
                { env: { ...process.env, ...environment } },
            );
            await expect
                .poll(async () => {
                    const records = await runtime.handlers['app.records']({
                        sessionIds: [],
                        terminalIds: [background.terminal!.id],
                    });
                    return records.terminals[0]?.agentOperation;
                })
                .toBeUndefined();

            const result = await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'turnFinished',
                    '--reply',
                    'empty-json',
                ],
                { env: { ...process.env, ...environment } },
            );
            expect(result.stdout).toBe('{}\n');
            await expect
                .poll(async () => {
                    const records = await runtime.handlers['app.records']({
                        sessionIds: [background.session.id],
                        terminalIds: [],
                    });
                    return records.sessions[0];
                })
                .toMatchObject({
                    hasUnread: true,
                    lastActivityState: 'completed',
                    lastAttentionKind: 'completed',
                    lastSessionActivityReason: 'agent_completed',
                });
            expect(
                (
                    await runtime.handlers['app.records']({
                        sessionIds: [background.session.id],
                        terminalIds: [],
                    })
                ).sessions[0]?.lastSessionActivityAt,
            ).toBeGreaterThan(backgroundCreatedAt);

            /**
             * The managed token dies with its child; only the independent Shell observer resumes.
             */
            expect(execution.emitAgentExit(background.terminal!.id, 0)).toBe(true);
            await expect
                .poll(
                    async () =>
                        (
                            await runtime.handlers['app.records']({
                                sessionIds: [],
                                terminalIds: [background.terminal!.id],
                            })
                        ).terminals[0]?.lastAgentProcessState,
                )
                .toBe('stopped');
            const retired = await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: { ...process.env, ...environment } },
            );
            expect(retired.stderr).toBe('caxri-hook: signal_rejected\n');
            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: { ...process.env, ...rootEnvironment } },
            );
            expect(
                (
                    await runtime.handlers['app.records']({
                        sessionIds: [background.session.id],
                        terminalIds: [],
                    })
                ).sessions[0]?.lastActivityState,
            ).toBe('running');
            await runtime.handlers['terminal.close']({ terminalId: background.terminal!.id });
            const closed = await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: { ...process.env, ...rootEnvironment } },
            );
            expect(closed.stderr).toBe('caxri-hook: signal_rejected\n');
        } finally {
            await runtime.close();
        }
    });

    it('keeps a Claude Session running when only a subagent finishes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-claude-subagent-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const claudeHome = join(directory, 'claude');
        await mkdir(projectRoot);
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const send = vi.fn();
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CLAUDE_CONFIG_DIR: claudeHome },
            },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: createLogger(join(directory, 'logs')),
            hookExecutable: process.execPath,
            send,
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn: vi.fn<typeof spawnPty>(() => createFakePty()),
            },
            userDataPath: join(directory, 'user-data'),
        });

        try {
            const currentSettings = await runtime.handlers['settings.get']({});
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'agents.providers': {
                        ...currentSettings.value['agents.providers'],
                        claude: {
                            ...currentSettings.value['agents.providers'].claude,
                            hooks: { enabled: true },
                            launch: {
                                ...currentSettings.value['agents.providers'].claude.launch,
                                executable: installedProviderExecutable,
                            },
                        },
                    },
                }),
            });
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'claude',
            });
            const environment = start.mock.calls[0]?.[0].agent?.environment;
            expect(environment).toMatchObject({
                CAXRI_HOOK_TERMINAL_ID: created.terminal!.id,
            });
            const bridge = join(directory, 'shared-hooks', 'bin', 'caxri-agent-hook-bridge');

            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'claude', '--phase', 'turnStarted'],
                { env: { ...process.env, ...environment } },
            );
            await expect
                .poll(async () => {
                    const records = await runtime.handlers['app.records']({
                        sessionIds: [created.session.id],
                        terminalIds: [],
                    });
                    return records.sessions[0];
                })
                .toMatchObject({
                    attentionEpoch: 0,
                    hasUnread: false,
                    lastActivityState: 'running',
                });

            const subagentStarted = execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'claude', '--phase', 'subagentStarted'],
                { env: { ...process.env, ...environment } },
            );
            subagentStarted.child.stdin?.end(JSON.stringify({ agent_id: 'subagent-1' }));
            await subagentStarted;

            send.mockClear();
            const parentFinished = await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'claude',
                    '--phase',
                    'turnFinished',
                    '--reply',
                    'empty-json',
                ],
                { env: { ...process.env, ...environment } },
            );
            expect(parentFinished.stdout).toBe('{}\n');

            expect(
                await runtime.handlers['app.records']({
                    sessionIds: [created.session.id],
                    terminalIds: [created.terminal!.id],
                }),
            ).toMatchObject({
                sessions: [
                    {
                        attentionEpoch: 0,
                        hasUnread: false,
                        lastActivityState: 'running',
                    },
                ],
                terminals: [{ agentSessionId: undefined, agentOperation: 'background' }],
            });
            // The only event is the record refresh that shows the background sub-mode: no attention or completion.
            expect(send.mock.calls).toEqual([
                [
                    {
                        event: 'state.changed',
                        payload: {
                            kind: 'records',
                            sessionIds: [created.session.id],
                            terminalIds: [created.terminal!.id],
                        },
                    },
                ],
            ]);

            const subagentFinished = execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'claude',
                    '--phase',
                    'turnFinished',
                    '--reply',
                    'empty-json',
                ],
                { env: { ...process.env, ...environment } },
            );
            subagentFinished.child.stdin?.end(
                JSON.stringify({ agent_id: 'subagent-1', session_id: 'claude-session' }),
            );
            expect((await subagentFinished).stdout).toBe('{}\n');
            /**
             * Claude resumes the parent turn on its own once the last background subagent stops, so the deferred
             * completion must not settle here; the resumed turn's own `Stop` ends the work.
             */
            expect(
                await runtime.handlers['app.records']({
                    sessionIds: [created.session.id],
                    terminalIds: [],
                }),
            ).toMatchObject({
                sessions: [{ attentionEpoch: 0, hasUnread: false, lastActivityState: 'running' }],
            });

            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'claude', '--phase', 'turnStarted'],
                { env: { ...process.env, ...environment } },
            );
            const resumedFinished = await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'claude',
                    '--phase',
                    'turnFinished',
                    '--reply',
                    'empty-json',
                ],
                { env: { ...process.env, ...environment } },
            );
            expect(resumedFinished.stdout).toBe('{}\n');
            await expect
                .poll(async () => {
                    const records = await runtime.handlers['app.records']({
                        sessionIds: [created.session.id],
                        terminalIds: [],
                    });
                    return records.sessions[0];
                })
                .toMatchObject({
                    attentionEpoch: 1,
                    hasUnread: true,
                    lastActivityState: 'completed',
                    lastAttentionKind: 'completed',
                });
        } finally {
            await runtime.close();
        }
    });
});
