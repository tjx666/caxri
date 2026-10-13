import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { fixture } from './service.fixture';

describe('Agent Commander Agent switch', () => {
    it('starts the first Commander with the stored Agent and trusts its workspace first', async () => {
        const { createAndStartTerminal, database, prepareLaunch, service } = await fixture();

        const snapshot = await service.switchAgent('claude');

        expect(createAndStartTerminal).toHaveBeenCalledOnce();
        expect(createAndStartTerminal.mock.calls[0]?.[1]).toBe('claude');
        expect(prepareLaunch).toHaveBeenCalledWith('claude', snapshot.workspacePath);
        expect(database.getAppState('commanderAgent')).toBe('claude');
        expect(database.getTerminal(snapshot.identity.terminalId)?.provider).toBe('claude');
    });

    it('moves a running Commander to another Agent on a new conversation, keeping its Terminal', async () => {
        const {
            createAndStartTerminal,
            database,
            onStopped,
            relaunchFresh,
            service,
            stopTerminal,
        } = await fixture();
        const { identity } = await service.ensure();
        database.updateTerminalState(identity.terminalId, 'running');
        database.rebindAgentSession(identity.terminalId, 'codex', 'codex-conversation');

        const switched = await service.switchAgent('claude');

        expect(switched.identity).toEqual(identity);
        const terminal = database.getTerminal(identity.terminalId);
        expect(terminal).toMatchObject({ kind: 'claude', provider: 'claude', title: 'Claude' });
        expect(terminal?.agentSessionId).toBeUndefined();
        expect(stopTerminal).toHaveBeenCalledWith(identity.terminalId);
        expect(onStopped).toHaveBeenCalledOnce();
        expect(relaunchFresh).toHaveBeenCalledExactlyOnceWith(identity.terminalId);
        expect(stopTerminal.mock.invocationCallOrder[0]).toBeLessThan(
            relaunchFresh.mock.invocationCallOrder[0],
        );

        await service.ensure();
        expect(createAndStartTerminal).toHaveBeenCalledOnce();
    });

    it('leaves a Commander already running the chosen Agent alone', async () => {
        const { relaunchFresh, service, stopTerminal } = await fixture();
        await service.ensure();

        await service.switchAgent('codex');

        expect(stopTerminal).not.toHaveBeenCalled();
        expect(relaunchFresh).not.toHaveBeenCalled();
    });

    it('makes a reopen during a switch return the switched Commander', async () => {
        const { createAndStartTerminal, database, service } = await fixture();
        const { identity } = await service.ensure();
        database.updateTerminalState(identity.terminalId, 'running');

        const [, reopened] = await Promise.all([service.switchAgent('claude'), service.ensure()]);

        expect(reopened.identity).toEqual(identity);
        expect(database.getTerminal(identity.terminalId)?.provider).toBe('claude');
        expect(createAndStartTerminal).toHaveBeenCalledOnce();
    });

    it('settles a switch, a clear queued behind it, and a stop that arrives during both, in that order', async () => {
        const { database, relaunchFresh, service } = await fixture();
        const { identity } = await service.ensure();
        database.updateTerminalState(identity.terminalId, 'running');
        let finishRelaunch = () => {};
        relaunchFresh.mockImplementationOnce(
            (terminalId: string) =>
                new Promise<void>((resolve) => {
                    finishRelaunch = () => {
                        database.updateTerminalState(terminalId, 'running');
                        resolve();
                    };
                }),
        );
        const switching = service.switchAgent('claude');
        await vi.waitFor(() => expect(relaunchFresh).toHaveBeenCalledOnce());
        const clearing = service.clearData({ conversation: true });
        const stopping = service.stop();
        finishRelaunch();

        await expect(Promise.all([switching, clearing, stopping])).resolves.toHaveLength(3);
        expect(relaunchFresh).toHaveBeenCalledTimes(2);
        expect(database.getTerminal(identity.terminalId)?.lastProcessState).toBe('detached');
    });
});

describe('Clear Commander Data', () => {
    it('reports what there is to clear without reading any content', async () => {
        const { database, inbox, service } = await fixture();
        const { identity, workspacePath } = await service.ensure();
        database.commanderTasks.insert({ title: 'Fix login retry', status: 'dispatched' }, 1);
        database.commanderTasks.insert({ title: 'Old task', status: 'done' }, 2);
        await writeFile(join(workspacePath, 'tasks', 'login.md'), 'brief');
        await mkdir(join(workspacePath, 'reports'));
        await writeFile(join(workspacePath, 'reports', 'login.md'), 'report!');
        await writeFile(
            join(workspacePath, 'memory', 'lessons.md'),
            '# Lessons\n\n- 2026-10-01 wrong repo\n',
        );
        inbox.counts.mockReturnValue({ open: 2, closed: 5 });
        database.rebindAgentSession(identity.terminalId, 'codex', 'codex-conversation');

        const summary = await service.data();

        expect(summary.tasks.map((task) => task.title)).toEqual(['Fix login retry', 'Old task']);
        expect(summary.taskCount).toBe(2);
        expect(summary.taskFiles).toEqual({ count: 2, bytes: 12 });
        expect(summary.memory.map(({ name, isTemplate }) => [name, isTemplate])).toEqual([
            ['repositories.md', true],
            ['preferences.md', true],
            ['lessons.md', false],
        ]);
        expect(summary.inbox).toEqual({ open: 2, closed: 5 });
        expect(summary.conversation).toEqual({ agent: 'codex', isBound: true });
    });

    it('deletes only the selected tasks, and the hand-overs that went with them', async () => {
        const { database, handovers, service } = await fixture();
        await service.ensure();
        const kept = database.commanderTasks.insert({ title: 'Keep', status: 'pending' }, 1);
        const dropped = database.commanderTasks.insert({ title: 'Drop', status: 'done' }, 2);

        const result = await service.clearData({ tasks: [dropped.id] });

        expect(result).toEqual({
            tasksDeleted: 1,
            memoryReset: false,
            taskFilesDeleted: 0,
            inboxItemsDeleted: 0,
            instructionsRewritten: false,
            conversationReset: false,
        });
        expect(database.commanderTasks.list({ includeClosed: true }).map(({ id }) => id)).toEqual([
            kept.id,
        ]);
        expect(handovers.forgetClearedTasks).toHaveBeenCalledOnce();
        await service.clearData({ inbox: true });
        expect(handovers.forgetClearedTasks).toHaveBeenCalledOnce();
    });

    it('deletes every closed task, including those too old for the list, and keeps the open ones', async () => {
        const { database, service } = await fixture();
        await service.ensure();
        const open = database.commanderTasks.insert({ title: 'Open', status: 'waiting_user' }, 1);
        database.commanderTasks.insert({ title: 'Done', status: 'done' }, 2);
        database.commanderTasks.insert({ title: 'Dropped', status: 'dropped' }, 3);

        const result = await service.clearData({ tasks: 'closed' });

        expect(result.tasksDeleted).toBe(2);
        expect(database.commanderTasks.list({ includeClosed: true }).map(({ id }) => id)).toEqual([
            open.id,
        ]);
    });

    it('resets memory and rewrites AGENTS.md without what the Commander had learned', async () => {
        const { service } = await fixture();
        const { workspacePath } = await service.ensure();
        await writeFile(
            join(workspacePath, 'memory', 'lessons.md'),
            '- never touch the billing repo\n',
        );
        await service.ensure();
        expect(await readFile(join(workspacePath, 'AGENTS.md'), 'utf8')).toContain('billing repo');

        const result = await service.clearData({ memory: true });

        expect(result).toMatchObject({ memoryReset: true, instructionsRewritten: true });
        expect(await readFile(join(workspacePath, 'AGENTS.md'), 'utf8')).not.toContain(
            'billing repo',
        );
        expect((await service.data()).memory.every((file) => file.isTemplate)).toBe(true);
    });

    it('unlinks a task directory that is itself a link, leaving the folder it points to alone', async () => {
        const { directory, service } = await fixture();
        const { workspacePath } = await service.ensure();
        const outside = join(directory, 'repository', 'keep.md');
        await writeFile(outside, 'user file');
        await symlink(join(directory, 'repository'), join(workspacePath, 'reports'));

        expect((await service.data()).taskFiles.count).toBe(1);
        const result = await service.clearData({ taskFiles: true });

        expect(result.taskFilesDeleted).toBe(1);
        expect(await readFile(outside, 'utf8')).toBe('user file');
        await expect(lstat(join(workspacePath, 'reports'))).rejects.toThrow();
    });

    it('empties the task directories without following a link out of the workspace', async () => {
        const { directory, service } = await fixture();
        const { workspacePath } = await service.ensure();
        const outside = join(directory, 'repository', 'keep.md');
        await writeFile(outside, 'user file');
        await mkdir(join(workspacePath, 'tasks', 'nested'), { recursive: true });
        await writeFile(join(workspacePath, 'tasks', 'nested', 'brief.md'), 'brief');
        await symlink(join(directory, 'repository'), join(workspacePath, 'tasks', 'linked'));

        const result = await service.clearData({ taskFiles: true });

        expect(result.taskFilesDeleted).toBe(2);
        expect((await service.data()).taskFiles).toEqual({ count: 0, bytes: 0 });
        expect(await readFile(outside, 'utf8')).toBe('user file');
        expect((await stat(join(workspacePath, 'tasks'))).isDirectory()).toBe(true);
    });

    it('clears the Inbox and starts the Commander over on its current Agent', async () => {
        const { database, inbox, onStopped, relaunchFresh, sendFullStateChange, service } =
            await fixture();
        const { identity } = await service.ensure();
        inbox.clear.mockReturnValue(3);

        const result = await service.clearData({ inbox: true, conversation: true });

        expect(result).toMatchObject({ inboxItemsDeleted: 3, conversationReset: true });
        expect(onStopped).toHaveBeenCalledOnce();
        expect(relaunchFresh).toHaveBeenCalledExactlyOnceWith(identity.terminalId);
        expect(database.getTerminal(identity.terminalId)?.provider).toBe('codex');
        expect(sendFullStateChange).toHaveBeenCalled();
    });
});
