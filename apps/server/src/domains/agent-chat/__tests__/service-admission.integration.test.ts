import { spawn } from 'node:child_process';
import { mkdir, rm, symlink } from 'node:fs/promises';
import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import { fixture } from './chat-service-fixture';

type ChatFixture = Awaited<ReturnType<typeof fixture>>;

/**
 * The ways a Chat's process is torn down while input waits behind its start, each as its production caller performs it:
 * `terminal.close` stops the Chat without awaiting it and removes the row at once, a surface switch flips the row to a
 * PTY after the stop, archive and detach stop every Chat of the Session.
 */
const teardowns: Record<string, (chat: ChatFixture) => Promise<void>> = {
    'closing the Terminal': async ({ database, service, terminal }) => {
        const closing = service.close(terminal.id);
        database.closeTerminal(terminal.id);
        await closing;
    },
    'switching it to a PTY': async ({ database, service, terminal }) => {
        await service.close(terminal.id);
        database.terminalSurfaces.switch(terminal.id, 'pty');
    },
    'archiving its Session': async ({ database, service, terminal }) => {
        database.archiveSession(terminal.sessionId);
        await service.closeSession(terminal.sessionId);
    },
    'detaching its Session': async ({ service, terminal }) => {
        await service.closeSession(terminal.sessionId, 'detached');
    },
};

async function startingChat(): Promise<ChatFixture> {
    const chat = await fixture();
    chat.service.read(chat.terminal.id);
    await vi.waitFor(() => expect(chat.spawnProcess).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(chat.service.read(chat.terminal.id).status).toBe('starting');
    return chat;
}

describe('Agent Chat input admission', () => {
    it.each(Object.keys(teardowns))(
        'rejects input queued behind a start and never relaunches the provider after %s',
        async (teardown) => {
            const chat = await startingChat();
            const { service, spawnProcess, terminal } = chat;
            const inputs = Promise.allSettled([
                service.send(terminal.id, { text: 'hello one' }),
                service.runCommand(terminal.id, 'compact'),
                service.configure(terminal.id, { effort: 'high' }),
                service.send(terminal.id, { text: 'hello four' }),
            ]);
            await teardowns[teardown](chat);

            const results = await inputs;
            expect(results.map((result) => result.status)).toEqual([
                'rejected',
                'rejected',
                'rejected',
                'rejected',
            ]);
            expect(spawnProcess).toHaveBeenCalledOnce();
            expect(service.liveCount()).toBe(0);
        },
    );

    /**
     * A restart (or a switch to Chat) holds the Session's launch while it stops the old provider; an archive or Project
     * hide that runs meanwhile closes only the Chat state that exists then, so the replacement start must be refused by
     * the admission fence itself.
     */
    it.each([
        ['archiving its Session', 'archive'],
        ['hiding its Project', 'hide'],
    ] as const)(
        'never starts a restarted provider after %s lands mid-restart',
        async (_name, park) => {
            const { database, service, spawnProcess, terminal, until } = await fixture();
            await until((snapshot) => snapshot.status === 'ready');

            const restarting = service.restart(terminal.id, true);
            if (park === 'archive') database.archiveSession(terminal.sessionId);
            else database.hideProject(database.getSession(terminal.sessionId)!.projectId);
            await service.closeSession(terminal.sessionId);
            await restarting;

            expect(spawnProcess).toHaveBeenCalledOnce();
            expect(service.liveCount()).toBe(0);
            expect(service.read(terminal.id).status).toBe('stopped');
            expect(spawnProcess).toHaveBeenCalledOnce();
        },
    );

    it('refuses new input while a close is stopping the provider', async () => {
        const { service, spawnProcess, terminal } = await startingChat();
        const closing = service.close(terminal.id);
        await expect(service.send(terminal.id, { text: 'hello late' })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(service.read(terminal.id).status).not.toBe('ready');
        await closing;
        expect(spawnProcess).toHaveBeenCalledOnce();
        expect(service.liveCount()).toBe(0);
    });
});

/**
 * A Chat's cwd was authorized when its Terminal was created, but the provider starts lazily, much later. The PTY launch
 * path revalidates the directory right before spawn; a Chat start must too, so a Project folder swapped for a link or
 * removed meanwhile fails the start instead of running the Agent somewhere else.
 */
describe('Agent Chat working directory', () => {
    const swaps: Record<string, (cwd: string) => Promise<void>> = {
        'replaced by a symlink to another directory': async (cwd) => {
            const elsewhere = `${cwd}-elsewhere`;
            await mkdir(elsewhere);
            await rm(cwd, { recursive: true });
            await symlink(elsewhere, cwd);
        },
        'removed': (cwd) => rm(cwd, { recursive: true }),
    };

    it.each(Object.keys(swaps))(
        'fails the start without spawning when the folder was %s',
        async (swap) => {
            const { database, service, spawnProcess, terminal, until } = await fixture();
            await swaps[swap](terminal.cwd);

            const snapshot = await until((current) => current.status === 'failed');
            expect(snapshot.failure?.reason).toBe('spawn_failed');
            expect(spawnProcess).not.toHaveBeenCalled();
            expect(service.liveCount()).toBe(0);
            expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('failed');
        },
    );
});

describe('Agent Chat detach', () => {
    it('keeps a detached Chat stopped on read and input until its Session resumes', async () => {
        const { database, service, spawnProcess, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');

        await service.closeSession(terminal.sessionId, 'detached');
        expect(database.getTerminal(terminal.id)).toMatchObject({
            lastProcessState: 'detached',
            lastAgentProcessState: 'detached',
        });
        expect(service.liveCount()).toBe(0);

        // A pane remount or a phone coming to the foreground reads again; neither may take the thread back.
        expect(service.read(terminal.id).status).toBe('stopped');
        expect(service.read(terminal.id).status).toBe('stopped');
        await expect(service.send(terminal.id, { text: 'hello' })).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        await expect(service.readTask(terminal.id, 'task-1')).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(spawnProcess).toHaveBeenCalledOnce();
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('detached');

        // Resume relaunches the thread itself, so a Client holding the detached projection gets patches unasked.
        service.resumeSession(terminal.sessionId);
        expect(database.getTerminal(terminal.id)?.lastProcessState).not.toBe('detached');
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
        service.read(terminal.id);
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('running');
    });

    it('lets an explicit restart take a detached Chat back', async () => {
        const { database, service, spawnProcess, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await service.closeSession(terminal.sessionId, 'detached');

        const restarted = await service.restart(terminal.id);
        expect(restarted.lastProcessState).toBe('running');
        expect(service.read(terminal.id).status).toBe('ready');
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        expect(database.getTerminal(terminal.id)?.lastAgentProcessState).toBe('running');
    });

    it('still starts an archived Chat on its next read', async () => {
        const { database, service, spawnProcess, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await service.closeSession(terminal.sessionId);
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('stopped');

        service.read(terminal.id);
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(spawnProcess).toHaveBeenCalledTimes(2);
    });

    it('marks each Chat detached as soon as it stops, not after its slowest sibling', async () => {
        const { database, service, spawnProcess, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        const sibling = database.createTerminal(terminal.sessionId, 'codex', terminal.cwd, 'chat');
        // The sibling's provider exits before its handshake, so its start fails while the detach stops it.
        spawnProcess.mockImplementationOnce((_executable, _arguments, options) =>
            spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(1), 100)'], options),
        );
        service.read(sibling.id);
        await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
        const close = service.close.bind(service);
        const held = Promise.withResolvers<void>();
        vi.spyOn(service, 'close').mockImplementation(async (terminalId, reason) => {
            await close(terminalId, reason);
            if (terminalId === terminal.id) await held.promise;
        });

        const detaching = service.closeSession(terminal.sessionId, 'detached');
        await vi.waitFor(() =>
            expect(database.getTerminal(sibling.id)?.lastProcessState).toBe('detached'),
        );
        // A read while the first Chat is still stopping must not take the sibling's Agent Session back.
        expect(service.read(sibling.id).status).toBe('stopped');
        held.resolve();
        await detaching;
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('detached');
    });

    it('leaves a Chat that was not running out of the hand-over', async () => {
        const { database, service, terminal } = await fixture();
        await service.closeSession(terminal.sessionId, 'detached');
        expect(database.getTerminal(terminal.id)?.lastProcessState).not.toBe('detached');
    });
});
