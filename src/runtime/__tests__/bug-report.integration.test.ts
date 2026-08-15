import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../shared/node/logger';
import { createRuntime } from '../bootstrap';

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

describe('Runtime bug report delivery', () => {
    it('revalidates the target and drives only supported Agent image input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-bug-report-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const pty = createFakePty();
        const write = vi.spyOn(pty, 'write');
        const runtime = await createRuntime({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => undefined,
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/echo'),
                spawn: () => pty,
            },
            agentAdapters: fakeAgentAdapters(),
        });

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

            expect(
                runtime.handlers['bugReport.deliver']({
                    pasteImage: false,
                    report,
                    sessionId: claude.session.id,
                    terminalId: claude.terminal!.id,
                }),
            ).toBeNull();
            expect(write).toHaveBeenCalledWith(`\u001B[200~${report}\u001B[201~\r`);
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
            write.mockClear();
            expect(
                runtime.handlers['bugReport.deliver']({
                    pasteImage: true,
                    report,
                    sessionId: codex.session.id,
                    terminalId: codex.terminal!.id,
                }),
            ).toBeNull();
            expect(write.mock.calls).toEqual([['\x16'], [`\u001B[200~${report}\u001B[201~\r`]]);
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
