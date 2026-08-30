import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime Agent hook integration', () => {
    it('projects authenticated Codex compaction without turning it into Session attention', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-hook-unread-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const codexHome = join(directory, 'codex');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: new StructuredLogger(join(directory, 'logs')),
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
            expect(rootEnvironment).not.toHaveProperty('CAXRI_HOOK_TERMINAL_ID');
            const launchPlan = start.mock.calls[0]?.[0];
            expect(launchPlan).toMatchObject({
                executable: '/bin/zsh',
                agent: {
                    executable: '/bin/echo',
                    provider: 'codex',
                },
            });
            const environment = launchPlan.agent?.environment;
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
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'compactionStarted',
                    '--schema',
                    '6',
                ],
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
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'compactionFinished',
                    '--schema',
                    '6',
                ],
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
                    '--schema',
                    '6',
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
        } finally {
            await runtime.close();
        }
    });
});
