import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDomainServices } from '../create-domain-services';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
        const runtime = await createDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: new StructuredLogger(join(directory, 'logs')),
            runtimeExecutable: process.execPath,
            send: () => {},
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/echo'),
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
            const selected = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            expect((await runtime.handlers['app.bootstrap']({})).selectedSessionId).toBe(
                selected.session.id,
            );

            const environment = spawn.mock.calls[0]?.[2].env;
            expect(environment).toMatchObject({
                CAXRI_HOOK_TERMINAL_ID: background.terminal!.id,
            });
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
                    '4',
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
                    '4',
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
                    '4',
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
                });
        } finally {
            await runtime.close();
        }
    });
});
