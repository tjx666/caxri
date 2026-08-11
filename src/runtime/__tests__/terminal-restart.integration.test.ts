import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';
import { CaxriDatabase } from '../db/repository';

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

function fakeAgentAdapters() {
    const pending = new Promise<never>(() => undefined);
    return {
        claude: { provider: 'claude' as const, snapshot: () => pending },
        codex: { provider: 'codex' as const, snapshot: () => pending },
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
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
            await mkdir(projectRoot);
            const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
            const runtime = await createRuntime({
                userDataPath,
                logger: new StructuredLogger(join(directory, 'logs')),
                send: () => undefined,
                terminal: {
                    resolveExecutable: () => Promise.resolve(`/usr/local/bin/${provider}`),
                    spawn,
                },
                agentAdapters: fakeAgentAdapters(),
            });

            try {
                const project = await runtime.handlers['project.create']({
                    rootPath: projectRoot,
                });
                const created = await runtime.handlers['session.create']({
                    projectId: project.id,
                    defaultAgent: provider,
                });
                const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
                direct.database
                    .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                    .run(sessionId, created.terminal.id);
                direct.close();

                await runtime.handlers['terminal.restart']({
                    terminalId: created.terminal.id,
                    mode: 'resume',
                });

                expect(spawn.mock.calls[1]?.[1]).toEqual(resumeArguments);
                const bootstrap = await runtime.handlers['app.bootstrap']({});
                expect(
                    bootstrap.terminals.find((terminal) => terminal.id === created.terminal.id)
                        ?.agentSessionId,
                ).toBe(sessionId);
            } finally {
                await runtime.close();
            }
        },
    );

    it('starts fresh only when restart explicitly requests it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-fresh-restart-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const runtime = await createRuntime({
            userDataPath,
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/usr/local/bin/codex'),
                spawn,
            },
            agentAdapters: fakeAgentAdapters(),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
            direct.database
                .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                .run('codex-session-old', created.terminal.id);
            direct.close();

            await runtime.handlers['terminal.restart']({
                terminalId: created.terminal.id,
                mode: 'fresh',
            });

            expect(spawn.mock.calls[1]?.[1]).toEqual([]);
            const bootstrap = await runtime.handlers['app.bootstrap']({});
            expect(
                bootstrap.terminals.find((terminal) => terminal.id === created.terminal.id)
                    ?.agentSessionId,
            ).toBeUndefined();
        } finally {
            await runtime.close();
        }
    });
});
