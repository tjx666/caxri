import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime bug report delivery', () => {
    it('revalidates the target and drives only supported Agent image input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-bug-report-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const pty = createFakePty();
        const write = vi.spyOn(pty, 'write');
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/echo'),
                spawn: () => pty,
            },
            agentAdapters: createPendingAgentAdapters(),
        });
        const waitForAgentRunning = async (terminalId: string): Promise<void> => {
            await vi.waitFor(async () => {
                const state = await runtime.handlers['app.bootstrap']({});
                const terminal = state.terminals.find((entry) => entry.id === terminalId);
                expect(terminal?.lastProcessState).toBe('running');
                expect(terminal?.lastAgentProcessState).toBe('running');
            });
        };

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const claude = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'claude',
            });
            const shell = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const report = '# Bug report\n\nLine one\nLine two';
            await waitForAgentRunning(claude.terminal!.id);

            expect(
                runtime.handlers['bugReport.deliver']({
                    pasteImage: false,
                    report,
                    sessionId: claude.session.id,
                    terminalId: claude.terminal!.id,
                }),
            ).toBeNull();
            expect(write).toHaveBeenCalledWith(`\u{1B}[200~${report}\u{1B}[201~\r`);
            expect(() =>
                runtime.handlers['bugReport.deliver']({
                    pasteImage: false,
                    report,
                    sessionId: shell.session.id,
                    terminalId: claude.terminal!.id,
                }),
            ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
            expect(() =>
                runtime.handlers['bugReport.deliver']({
                    pasteImage: true,
                    report,
                    sessionId: claude.session.id,
                    terminalId: claude.terminal!.id,
                }),
            ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));

            const codex = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            await waitForAgentRunning(codex.terminal!.id);
            write.mockClear();
            expect(
                runtime.handlers['bugReport.deliver']({
                    pasteImage: true,
                    report,
                    sessionId: codex.session.id,
                    terminalId: codex.terminal!.id,
                }),
            ).toBeNull();
            expect(write.mock.calls).toEqual([['\u{16}'], [`\u{1B}[200~${report}\u{1B}[201~\r`]]);
            await runtime.handlers['terminal.close']({ terminalId: claude.terminal!.id });
            expect(() =>
                runtime.handlers['bugReport.deliver']({
                    pasteImage: false,
                    report,
                    sessionId: claude.session.id,
                    terminalId: claude.terminal!.id,
                }),
            ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        } finally {
            await runtime.close();
        }
    });
});
