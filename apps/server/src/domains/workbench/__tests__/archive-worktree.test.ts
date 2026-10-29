import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    FullStateChangeReason,
    SessionPullRequest,
    SessionPullRequestState,
} from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import type { GitWorktreeTopology, LinkedWorktreeRemoval } from '../../git/index';
import { ArchivedWorktreeCleanup } from '../archive-worktree';

async function fixture(options: { isEnabled?: boolean; state?: SessionPullRequestState } = {}) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-archive-worktree-'));
    const directory = await realpath(created);
    const ownerRoot = join(directory, 'owner');
    const worktreeRoot = join(directory, 'worktree');
    await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const owner = database.createProject(ownerRoot);
    const worktree = database.createProject(worktreeRoot, owner.id);
    const { session } = database.createSession(owner.id, 'codex');
    database.selectWorkbenchProject(session.id, worktree.id);
    let topology: GitWorktreeTopology = {
        repositoryKey: join(ownerRoot, '.git'),
        worktrees: [
            { branch: 'main', isMain: true, rootPath: ownerRoot },
            { branch: 'feat/x', isMain: false, rootPath: worktreeRoot },
        ],
    };
    const isEnabled = options.isEnabled ?? true;
    const state = options.state;
    const removeLinkedWorktree = vi.fn((): Promise<LinkedWorktreeRemoval> =>
        Promise.resolve({ outcome: 'removed', isBackupCommitted: false }),
    );
    const stateChanges: FullStateChangeReason[] = [];
    const cleanup = new ArchivedWorktreeCleanup({
        database,
        delayMs: 0,
        git: { worktreeTopology: () => Promise.resolve(topology) },
        isEnabled: () => isEnabled,
        logger,
        removeWorktree: removeLinkedWorktree,
        sendFullStateChange: (reason) => stateChanges.push(reason),
    });
    cleanup.useSessionPullRequests(() =>
        Promise.resolve(state && { value: { state } as SessionPullRequest }),
    );
    onTestFinished(async () => {
        await cleanup.close();
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    });
    /**
     * The archive handler's order: decide while the Session is open, archive, then schedule.
     */
    const archive = async (choice?: 'keep' | 'remove') => {
        const target = await cleanup.prepare(session.id, choice);
        database.archiveSession(session.id);
        if (target) cleanup.schedule(session.id, target);
        return target;
    };
    const settle = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await cleanup.close();
    };
    return {
        archive,
        cleanup,
        database,
        owner,
        ownerRoot,
        removeLinkedWorktree,
        session,
        setTopology: (worktrees: GitWorktreeTopology['worktrees']) => {
            topology = { ...topology, worktrees };
        },
        settle,
        stateChanges,
        worktree,
        worktreeRoot,
    };
}

describe('ArchivedWorktreeCleanup', () => {
    it('leaves every worktree alone while the setting is off', async () => {
        const context = await fixture({ isEnabled: false, state: 'merged' });
        expect(await context.cleanup.plan(context.session.id)).toEqual({ worktree: null });
        expect(await context.archive('remove')).toBeUndefined();
        await context.settle();
        expect(context.removeLinkedWorktree).not.toHaveBeenCalled();
    });

    it('removes a merged pull request worktree without asking and returns the Session to its Project', async () => {
        const context = await fixture({ state: 'merged' });
        expect(await context.cleanup.plan(context.session.id)).toEqual({
            worktree: {
                branch: 'feat/x',
                pullRequestState: 'merged',
                removal: 'automatic',
                rootPath: context.worktreeRoot,
            },
        });
        await context.archive();
        await context.settle();
        expect(context.removeLinkedWorktree.mock.calls).toHaveLength(1);
        expect(context.removeLinkedWorktree.mock.calls[0]).toMatchObject([
            { ownerRoot: context.ownerRoot, rootPath: context.worktreeRoot },
        ]);
        expect(context.database.getSession(context.session.id)?.workbenchRootProjectId).toBe(
            context.owner.id,
        );
        expect(context.stateChanges).toEqual(['session.workbenchRoot']);
    });

    it('asks before removing a worktree whose pull request is not merged, and keeps it by default', async () => {
        const context = await fixture({ state: 'open' });
        expect((await context.cleanup.plan(context.session.id)).worktree?.removal).toBe('confirm');
        expect(await context.archive()).toBeUndefined();
        await context.settle();
        expect(context.removeLinkedWorktree).not.toHaveBeenCalled();
    });

    it('removes an unmerged worktree once the user confirms, and keeps it when they decline', async () => {
        const removed = await fixture();
        expect((await removed.cleanup.plan(removed.session.id)).worktree).toMatchObject({
            removal: 'confirm',
        });
        await removed.archive('remove');
        await removed.settle();
        expect(removed.removeLinkedWorktree).toHaveBeenCalledOnce();

        const kept = await fixture({ state: 'merged' });
        await kept.archive('keep');
        await kept.settle();
        expect(kept.removeLinkedWorktree).not.toHaveBeenCalled();
    });

    it('never removes a main checkout, a detached worktree, a folder the user added, or one another open Session uses', async () => {
        const main = await fixture({ state: 'merged' });
        main.setTopology([{ branch: 'feat/x', isMain: true, rootPath: main.worktreeRoot }]);
        expect(await main.cleanup.plan(main.session.id)).toEqual({ worktree: null });

        const detached = await fixture({ state: 'merged' });
        detached.setTopology([
            { branch: 'main', isMain: true, rootPath: detached.ownerRoot },
            { branch: '', isMain: false, rootPath: detached.worktreeRoot },
        ]);
        expect(await detached.cleanup.plan(detached.session.id)).toEqual({ worktree: null });

        const manual = await fixture({ state: 'merged' });
        const added = manual.database.createProject(join(manual.worktreeRoot, '..', 'added'));
        manual.database.selectWorkbenchProject(manual.session.id, added.id);
        expect(await manual.cleanup.plan(manual.session.id)).toEqual({ worktree: null });

        const shared = await fixture({ state: 'merged' });
        const { session: other } = shared.database.createSession(shared.owner.id, 'codex');
        shared.database.selectWorkbenchProject(other.id, shared.worktree.id);
        expect(await shared.cleanup.plan(shared.session.id)).toEqual({ worktree: null });
        expect(await shared.archive('remove')).toBeUndefined();
    });

    it('follows the latest archive decision when Undo and a second archive land inside the delay', async () => {
        const context = await fixture();
        await context.archive('remove');
        context.database.unarchiveSessions([context.session.id]);
        await context.archive('keep');
        await context.settle();
        expect(context.removeLinkedWorktree).not.toHaveBeenCalled();
    });

    it('keeps the worktree when the Session is restored before the removal runs', async () => {
        const context = await fixture({ state: 'merged' });
        const target = await context.cleanup.prepare(context.session.id, undefined);
        expect(target).toBeDefined();
        context.database.archiveSession(context.session.id);
        context.database.unarchiveSessions([context.session.id]);
        context.cleanup.schedule(context.session.id, target!);
        await context.settle();
        expect(context.removeLinkedWorktree).not.toHaveBeenCalled();
    });
});
