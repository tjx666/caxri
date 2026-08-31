import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('Server Agent input policy', () => {
    it('rejects real Agent E2E input at every Server request boundary', async () => {
        vi.stubEnv('CAXRI_E2E', '1');
        vi.stubEnv('CAXRI_E2E_AGENT_MODE', 'real');
        vi.stubEnv('CAXRI_E2E_AGENT_PROVIDER', 'codex');
        const directory = await mkdtemp(join(tmpdir(), 'caxri-server-agent-input-policy-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const pty = createFakePty();
        const terminalWrite = vi.fn();
        pty.write = terminalWrite;
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/bin/codex'),
                spawn: () => pty,
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const currentSettings = await runtime.handlers['settings.get']({});
            const prompt = 'Read README.md and report its heading. Do not modify any files.';
            await runtime.handlers['settings.update']({
                source: JSON.stringify({
                    ...currentSettings.value,
                    'agents.providers': {
                        ...currentSettings.value['agents.providers'],
                        codex: {
                            launch: {
                                executable: 'codex',
                                args: [
                                    'exec',
                                    '--sandbox',
                                    'read-only',
                                    '--skip-git-repo-check',
                                    '--ephemeral',
                                    '--ignore-rules',
                                    '--color',
                                    'never',
                                    prompt,
                                ],
                            },
                        },
                    },
                }),
            });
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            await vi.waitFor(async () => {
                const bootstrap = await runtime.handlers['app.bootstrap']({});
                expect(
                    bootstrap.terminals.find((terminal) => terminal.id === created.terminal!.id),
                ).toMatchObject({
                    lastProcessState: 'running',
                    lastAgentProcessState: 'running',
                });
            });

            await expect(
                runtime.handlers['terminal.input']({
                    terminalId: created.terminal!.id,
                    data: '\u{3}',
                }),
            ).rejects.toThrow('Real Agent E2E does not accept interactive Terminal input');
            expect(() =>
                runtime.handlers['terminal.sendInternal']({
                    terminalId: created.terminal!.id,
                    text: 'continue',
                    enter: true,
                }),
            ).toThrow('Real Agent E2E does not accept interactive Terminal input');
            expect(() =>
                runtime.handlers['bugReport.deliver']({
                    pasteImage: false,
                    report: '# Bug report',
                    sessionId: created.session.id,
                    terminalId: created.terminal!.id,
                }),
            ).toThrow('Real Agent E2E does not accept interactive Terminal input');
            expect(terminalWrite).not.toHaveBeenCalled();
        } finally {
            await runtime.close();
        }
    });
});
