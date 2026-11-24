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

/**
 * Holds every deletion at the delegation fence, where the real service waits for in-flight creations and private files,
 * until `release` runs; `entered` settles once a deletion is waiting.
 */
function heldFence() {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    return {
        entered: entered.promise,
        gate: gate.promise,
        release: () => gate.resolve(),
        signalEntered: () => entered.resolve(),
    };
}

async function fixture(untouched: ReadonlySet<string>, fence?: ReturnType<typeof heldFence>) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-discard-empty-'));
    directories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.createProject(join(directory, 'project'));
    const forgetSessionRuntime = vi.fn();
    const evictSessions = vi.fn();
    const deletedDelegationSessions: Array<readonly string[]> = [];
    const forgottenDelegationSessions: Array<readonly string[]> = [];
    const handlers = createDeletionHandlers({
        database,
        delegations: {
            deleteSessions: async (ids: readonly string[], remove: () => unknown) => {
                deletedDelegationSessions.push(ids);
                fence?.signalEntered();
                await fence?.gate;
                const removed = await remove();
                // The real service forgets pending questions and approvals only after the removal succeeded.
                forgottenDelegationSessions.push(ids);
                return removed;
            },
        } as unknown as AgentDelegationService,
        mobileTerminalMutations: new MobileTerminalMutationQueue(),
        bootstrapState: () => ({}) as BootstrapState,
        forgetSessionRuntime,
        isUntouchedChat: (terminalId) => untouched.has(terminalId),
        evictSessions,
        projectDeleted: vi.fn(),
        restoreSelection: vi.fn(),
        send: vi.fn(),
    });
    const discard = handlers['session.discardIfEmpty'];
    const chatSession = () => {
        const { session } = database.createSession(project.id, null, project.rootPath);
        const terminal = database.createTerminal(session.id, 'claude', project.rootPath, 'chat');
        return { sessionId: session.id, terminalId: terminal.id };
    };
    return {
        chatSession,
        database,
        deletedDelegationSessions,
        discard,
        forgottenDelegationSessions,
        evictSessions,
        forgetSessionRuntime,
        handlers,
        project,
    };
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

    it('keeps a Session whose Chat received input while the deletion waited on the delegation fence', async () => {
        const untouched = new Set<string>();
        const fence = heldFence();
        const f = await fixture(untouched, fence);
        const { sessionId, terminalId } = f.chatSession();
        untouched.add(terminalId);

        const discarded = f.discard({ sessionId });
        await fence.entered;
        // Another connection sends the first message after the decision to discard was made.
        untouched.delete(terminalId);
        fence.release();

        await expect(discarded).resolves.toEqual({ discarded: false });
        expect(f.database.getSession(sessionId)).toBeDefined();
        expect(f.forgetSessionRuntime).not.toHaveBeenCalled();
        expect(f.evictSessions).not.toHaveBeenCalled();
        f.database.close();
    });
});

describe('project.delete', () => {
    it('retires the runtime of a Session created while the deletion waited', async () => {
        const fence = heldFence();
        const f = await fixture(new Set(), fence);
        const { sessionId: early } = f.chatSession();

        const deleted = f.handlers['project.delete']({ projectId: f.project.id });
        await fence.entered;
        const { sessionId: late } = f.chatSession();
        fence.release();
        await deleted;

        expect(f.database.getSession(late)).toBeUndefined();
        expect(f.forgetSessionRuntime).toHaveBeenCalledWith(early);
        expect(f.forgetSessionRuntime).toHaveBeenCalledWith(late);
        expect(f.evictSessions).toHaveBeenCalledWith(expect.arrayContaining([early, late]));
        f.database.close();
    });

    it('fences and forgets a Session created while the deletion waited', async () => {
        const fence = heldFence();
        const f = await fixture(new Set(), fence);
        const { sessionId: early } = f.chatSession();

        const deleted = f.handlers['project.delete']({ projectId: f.project.id });
        await fence.entered;
        const { sessionId: late } = f.chatSession();
        fence.release();
        await deleted;

        expect(f.deletedDelegationSessions).toEqual([[early], [late]]);
        expect(f.forgottenDelegationSessions).toEqual([[late], [early]]);
        expect(f.database.getSession(late)).toBeUndefined();
        f.database.close();
    });
});
