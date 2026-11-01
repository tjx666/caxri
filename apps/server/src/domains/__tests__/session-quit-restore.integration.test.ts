import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalKind } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { CaxriDatabase } from '../db/repository';
import {
    createFakePty,
    createPendingAgentAdapters,
    writeClaudeTranscript,
} from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

it('relaunches the Agent a quit stopped on its bound conversation, once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-quit-restore-'));
    temporaryDirectories.push(directory);
    const userDataPath = join(directory, 'user-data');
    const homeDirectory = join(directory, 'home');
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const resolveExecutable = (kind: TerminalKind) =>
        Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude');
    const open = (name: string, spawn: typeof spawnPty = () => createFakePty()) =>
        createTestDomainServices({
            agentEnvironment: { homeDirectory, variables: {} },
            userDataPath,
            terminalRestoreGridWaitMs: 0,
            logger: new StructuredLogger(join(directory, `logs-${name}`)),
            send: () => {},
            terminal: { resolveExecutable, spawn },
            agentAdapters: createPendingAgentAdapters(),
        });

    const domainsA = await open('a');
    const project = await domainsA.handlers['project.create']({ rootPath: projectRoot });
    const created = await domainsA.handlers['session.create']({
        projectId: project.id,
        defaultAgent: 'claude',
    });
    const terminalId = created.terminal!.id;
    await domainsA.close();
    // Bind a written conversation, as `terminal-auto-restore.integration.test.ts` does, so a relaunch resumes it.
    const direct = new CaxriDatabase(join(userDataPath, 'caxri.db'));
    direct.database
        .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
        .run('claude-session-1', terminalId);
    direct.close();
    await writeClaudeTranscript(homeDirectory, project.rootPath, 'claude-session-1');

    const terminalState = async (domains: Awaited<ReturnType<typeof open>>) =>
        (await domains.handlers['app.bootstrap']({})).terminals.find(({ id }) => id === terminalId);

    // The orderly close left it `interrupted`, so this start restores it; then the user quits with "Stop Tasks".
    const domainsB = await open('b');
    try {
        await vi.waitFor(async () =>
            expect((await terminalState(domainsB))?.lastProcessState).toBe('running'),
        );
        await domainsB.handlers['terminal.terminateAll']({ reason: 'serverStop' });
        expect((await terminalState(domainsB))?.lastProcessState).toBe('stopped');
    } finally {
        await domainsB.close();
    }

    const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
    const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
    const domainsC = await open('c', spawn);
    try {
        // `stopped` is final: the next start does not relaunch it on its own.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(spawn).not.toHaveBeenCalled();

        await expect(domainsC.handlers['session.restoreQuitStopped']({})).resolves.toEqual({
            restored: 1,
            skipped: 0,
        });
        await vi.waitFor(async () => {
            const terminal = await terminalState(domainsC);
            expect(terminal?.lastProcessState).toBe('running');
            expect(terminal?.lastAgentProcessState).toBe('running');
        });
        expect(start.mock.calls.at(-1)?.[0].agent?.args).toEqual(
            expect.arrayContaining(['--resume', 'claude-session-1']),
        );
        // The record was consumed.
        await expect(domainsC.handlers['session.restoreQuitStopped']({})).resolves.toEqual({
            restored: 0,
            skipped: 0,
        });
    } finally {
        await domainsC.close();
    }
});

it('records nothing for Terminate and Close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-quit-restore-close-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const domains = await createTestDomainServices({
        userDataPath: join(directory, 'user-data'),
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: {
            resolveExecutable: (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude'),
            spawn: () => createFakePty(),
        },
        agentAdapters: createPendingAgentAdapters(),
    });
    try {
        const project = await domains.handlers['project.create']({ rootPath: projectRoot });
        await domains.handlers['session.create']({ projectId: project.id, defaultAgent: 'claude' });
        await domains.handlers['terminal.terminateAll']({ reason: 'windowClose' });
        await expect(domains.handlers['session.restoreQuitStopped']({})).resolves.toEqual({
            restored: 0,
            skipped: 0,
        });
    } finally {
        await domains.close();
    }
});
