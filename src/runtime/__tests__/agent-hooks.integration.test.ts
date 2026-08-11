import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import type { AgentAdapter } from '../agents/service';
import { createRuntime } from '../bootstrap';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function createFakePty(): IPty {
    return {
        pid: 4242,
        kill: vi.fn(),
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        write: vi.fn(),
    } as unknown as IPty;
}

function pendingAgentAdapters(): Record<'claude' | 'codex', AgentAdapter> {
    const pending = new Promise<never>(() => undefined);
    return {
        claude: { provider: 'claude', snapshot: () => pending },
        codex: { provider: 'codex', snapshot: () => pending },
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Runtime Agent hook integration', () => {
    it('marks a background Session unread when its authenticated Codex turn finishes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-hook-unread-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        const codexHome = join(directory, 'codex');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            agentAdapters: pendingAgentAdapters(),
            agentEnvironment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            agentHooksPath: join(directory, 'shared-hooks'),
            logger: new StructuredLogger(join(directory, 'logs')),
            runtimeExecutable: process.execPath,
            send: () => undefined,
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
                CAXRI_HOOK_TERMINAL_ID: background.terminal.id,
            });
            const result = await execFileAsync(
                join(directory, 'shared-hooks', 'bin', 'caxri-agent-hook-bridge'),
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'turnFinished',
                    '--schema',
                    '1',
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
