import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { createFakePty } from './create-test-domain-services';

const FAKE_APP_SERVER = join(
    import.meta.dirname,
    '..',
    'agent-chat',
    '__tests__',
    'fixtures',
    'fake-codex-app-server.ts',
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Behaves like the private Terminal Host supervisor, which refuses every launch once it was shut down (`Terminal Host
 * is stopped`). The in-process adapter alone would keep launching after a shutdown and hide the failure a reopened
 * window hit.
 */
class SupervisedHostExecution extends LocalTerminalExecution {
    private isStopped = false;

    override reserve(record: TerminalRecord): Promise<void> {
        if (this.isStopped)
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Terminal Host is stopped'));
        return super.reserve(record);
    }

    override shutdown(): ReturnType<LocalTerminalExecution['shutdown']> {
        this.isStopped = true;
        return super.shutdown();
    }
}

it('keeps Server Core serving Terminals and Chats after Terminate and Close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminate-all-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    // Server Core spawns the resolved executable directly, so the fake app-server sits behind a launcher script.
    const launcher = join(directory, 'codex');
    await writeFile(
        launcher,
        `#!/bin/sh\nFAKE_CODEX_STATE_DIR='${join(directory, 'codex-state')}' exec '${process.execPath}' '${FAKE_APP_SERVER}' "$@"\n`,
    );
    await chmod(launcher, 0o755);
    const logger = new StructuredLogger(join(directory, 'logs'));
    const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
    const domains = await createTestDomainServices({
        agentEnvironment: { homeDirectory: join(directory, 'home'), variables: {} },
        userDataPath: join(directory, 'user-data'),
        logger,
        send: () => {},
        terminal: {
            resolveExecutable: (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : launcher),
            spawn,
        },
        terminalExecution: new SupervisedHostExecution({ logger, spawn }),
        terminalRestoreGridWaitMs: 0,
    });
    const record = async (terminalId: string) =>
        (await domains.handlers['app.bootstrap']({})).terminals.find(
            (terminal) => terminal.id === terminalId,
        );

    try {
        const project = await domains.handlers['project.create']({ rootPath: projectRoot });
        // A Session whose Shell is parked and resumes when it is selected again.
        const parked = await domains.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        await domains.handlers['session.archive']({ sessionId: parked.session.id });
        await domains.handlers['session.unarchive']({
            sessionId: parked.session.id,
            placement: 'top',
        });
        expect((await record(parked.terminal!.id))?.lastProcessState).toBe('suspended');
        const working = await domains.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        const shellId = working.terminal!.id;
        const chat = await domains.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'codex',
            surface: 'chat',
        });
        const chatId = chat.terminal!.id;
        const readChat = () => domains.handlers['agentChat.read']({ terminalId: chatId });
        await vi.waitFor(async () => expect((await readChat()).status).toBe('ready'), {
            timeout: 5_000,
        });
        expect(await domains.handlers['terminal.runningCount']({})).toBe(2);

        await domains.handlers['terminal.terminateAll']({});
        expect(await domains.handlers['terminal.runningCount']({})).toBe(0);
        expect(await record(shellId)).toMatchObject({ lastProcessState: 'stopped' });
        expect(await record(chatId)).toMatchObject({
            lastProcessState: 'stopped',
            lastAgentProcessState: 'stopped',
        });

        // A terminated Terminal stays stopped when its Session is selected again.
        await domains.handlers['session.select']({ sessionId: working.session.id });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await record(shellId))?.lastProcessState).toBe('stopped');

        // Selection still restores the work it parked before the terminate.
        await domains.handlers['session.select']({ sessionId: parked.session.id });
        await vi.waitFor(async () =>
            expect((await record(parked.terminal!.id))?.lastProcessState).toBe('running'),
        );

        const created = await domains.handlers['terminal.create']({
            sessionId: working.session.id,
            kind: 'shell',
        });
        expect(created.lastProcessState).toBe('running');
        const restarted = await domains.handlers['terminal.restart']({
            terminalId: shellId,
            mode: 'resume',
        });
        expect(restarted.lastProcessState).toBe('running');
        await vi.waitFor(async () => expect((await readChat()).status).toBe('ready'), {
            timeout: 5_000,
        });
        expect((await record(chatId))?.lastProcessState).toBe('running');
    } finally {
        await domains.close();
    }
});
