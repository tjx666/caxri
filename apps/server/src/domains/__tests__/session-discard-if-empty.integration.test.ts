import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDelegationService } from '../agent-delegation';
import { CaxriDatabase } from '../db';
import { createDeletionHandlers } from '../deletion-handlers';
import { MobileTerminalMutationQueue } from '../mobile/terminal-mutation-queue';

const directories: string[] = [];
afterEach(async () => {
    const removed = [...directories];
    directories.length = 0;
    await Promise.all(removed.map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture(untouched: ReadonlySet<string>) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-discard-empty-'));
    directories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(join(directory, 'project'));
    const forgetSessionRuntime = vi.fn();
    const discard = createDeletionHandlers({
        database,
        delegations: {
            deleteSessions: (_ids: readonly string[], remove: () => unknown) =>
                Promise.resolve(remove()),
        } as unknown as AgentDelegationService,
        mobileTerminalMutations: new MobileTerminalMutationQueue(),
        bootstrapState: () => ({}) as BootstrapState,
        forgetSessionRuntime,
        isUntouchedChat: (terminalId) => untouched.has(terminalId),
        evictSessions: vi.fn(),
        projectDeleted: vi.fn(),
        restoreSelection: vi.fn(),
        send: vi.fn(),
    })['session.discardIfEmpty'];
    const chatSession = () => {
        const { session } = database.createSession(project.id, null, project.rootPath);
        const terminal = database.createTerminal(session.id, 'claude', project.rootPath, 'chat');
        return { sessionId: session.id, terminalId: terminal.id };
    };
    return { chatSession, database, discard, forgetSessionRuntime, project };
}

describe('session.discardIfEmpty', () => {
    it('deletes a Session whose only Terminal is an untouched Chat', async () => {
        const untouched = new Set<string>();
        const f = await fixture(untouched);
        const { sessionId, terminalId } = f.chatSession();
        untouched.add(terminalId);

        await expect(f.discard({ sessionId })).resolves.toEqual({ discarded: true });
        expect(f.database.getSession(sessionId)).toBeUndefined();
        expect(f.forgetSessionRuntime).toHaveBeenCalledWith(sessionId);
        f.database.close();
    });

    it('keeps a Session whose Chat received input', async () => {
        const f = await fixture(new Set());
        const { sessionId } = f.chatSession();

        await expect(f.discard({ sessionId })).resolves.toEqual({ discarded: false });
        expect(f.database.getSession(sessionId)).toBeDefined();
        f.database.close();
    });

    it('keeps a Session that also has a Shell or PTY Agent Terminal', async () => {
        const untouched = new Set<string>();
        const f = await fixture(untouched);
        const { sessionId, terminalId } = f.chatSession();
        untouched.add(terminalId);
        const shell = f.database.createTerminal(sessionId, 'shell', f.project.rootPath);
        untouched.add(shell.id);

        await expect(f.discard({ sessionId })).resolves.toEqual({ discarded: false });
        expect(f.database.getSession(sessionId)).toBeDefined();
        f.database.close();
    });

    it('keeps a Session with no Terminal and answers for an unknown one', async () => {
        const f = await fixture(new Set());
        const { session } = f.database.createSession(f.project.id, null, f.project.rootPath);

        await expect(f.discard({ sessionId: session.id })).resolves.toEqual({ discarded: false });
        await expect(f.discard({ sessionId: 'missing' })).resolves.toEqual({ discarded: false });
        expect(f.database.getSession(session.id)).toBeDefined();
        f.database.close();
    });
});
