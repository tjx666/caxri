import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { beginWorktreeCreation, fixture, prime, shellFailed, shellFinished } from './roots.fixture';

type Context = Awaited<ReturnType<typeof fixture>>;

function candidates(context: Context) {
    return context.events.filter(
        (event): event is Extract<ServerEvent, { event: 'workbench.candidate' }> =>
            event.event === 'workbench.candidate',
    );
}

/**
 * Two Sessions in one repository whose `git worktree add` PreToolUse hooks overlap, the way sibling Agents behave in
 * practice. Both before-snapshots hold only the main worktree.
 */
async function overlappingCreations(declare: { first?: string | true; second?: string | true }) {
    const context = await fixture(2);
    const secondRoot = join(context.directory, 'second-worktree');
    await mkdir(secondRoot);
    const pathFor = (value: string | true | undefined, own: string) =>
        value === true ? own : value;
    await prime(context, 'launch-1', 0);
    await prime(context, 'launch-2', 1);
    await beginWorktreeCreation(context, {
        launchId: 'launch-1',
        worktreeCreatePath: pathFor(declare.first, context.worktreeRoot),
    });
    await beginWorktreeCreation(context, {
        launchId: 'launch-2',
        sessionIndex: 1,
        worktreeCreatePath: pathFor(declare.second, secondRoot),
    });
    context.setWorktrees([
        { branch: 'main', rootPath: context.ownerRoot },
        { branch: 'feature/first', rootPath: context.worktreeRoot },
        { branch: 'feature/second', rootPath: secondRoot },
    ]);
    return { context, secondRoot };
}

describe('WorkbenchRootService overlapping worktree creations', () => {
    it('follows each Session to its own worktree when outcomes arrive in separate batches', async () => {
        const { context, secondRoot } = await overlappingCreations({ first: true, second: true });

        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        await vi.waitFor(() => expect(candidates(context)).toHaveLength(1));
        context.service.observeShellToolFinished(
            shellFinished(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        await vi.waitFor(() => expect(candidates(context)).toHaveLength(2));

        expect(
            candidates(context).map(({ payload }) => [payload.sessionId, payload.rootPath]),
        ).toEqual([
            [context.sessions[0].session.id, context.worktreeRoot],
            [context.sessions[1].session.id, secondRoot],
        ]);
        await context.service.close();
        context.database.close();
    });

    it('follows each Session to its own worktree when outcomes share one batch', async () => {
        const { context, secondRoot } = await overlappingCreations({ first: true, second: true });

        context.service.observeShellToolFinished(
            shellFinished(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        await vi.waitFor(() => expect(candidates(context)).toHaveLength(2));

        expect(
            candidates(context)
                .map(({ payload }) => payload.rootPath)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
            [context.worktreeRoot, secondRoot].toSorted((left, right) => left.localeCompare(right)),
        );
        await context.service.close();
        context.database.close();
    });

    it('lets a sibling without a declared path stay inert while the declared creation follows', async () => {
        const { context } = await overlappingCreations({ first: true });

        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        context.service.observeShellToolFinished(
            shellFinished(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        await vi.waitFor(() => expect(candidates(context)).toHaveLength(1));

        expect(candidates(context)[0].payload.sessionId).toBe(context.sessions[0].session.id);
        await context.service.close();
        context.database.close();
    });

    it('stays inert and logs the cause when neither creation declares a path', async () => {
        const { context } = await overlappingCreations({});

        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        context.service.observeShellToolFinished(
            shellFinished(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        await vi.waitFor(async () =>
            expect(
                (await context.readLogEvents()).filter(
                    (entry) =>
                        entry.event === 'workbench_root.provenance_unavailable' &&
                        entry.fields?.reason === 'concurrent_creations',
                ).length,
            ).toBeGreaterThan(0),
        );
        expect(candidates(context)).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('follows nothing and logs path_not_added when the declared path is not a Git addition', async () => {
        const { context } = await overlappingCreations({
            first: join(fixtureElsewhere(), 'not-a-worktree'),
            second: true,
        });

        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        await vi.waitFor(async () =>
            expect(
                (await context.readLogEvents()).some(
                    (entry) => entry.fields?.reason === 'path_not_added',
                ),
            ).toBe(true),
        );
        expect(candidates(context)).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('never lets a declared path authorize a path that Git did not report as new', async () => {
        const context = await fixture();
        await prime(context);
        await beginWorktreeCreation(context, { worktreeCreatePath: context.worktreeRoot });
        // The worktree already existed before this creation's snapshot would have seen it: no addition at all.
        context.service.observeShellToolFinished(
            shellFinished(context, { worktreeCreateIntent: true }),
        );
        await vi.waitFor(async () =>
            expect(
                (await context.readLogEvents()).some(
                    (entry) => entry.fields?.reason === 'no_addition',
                ),
            ).toBe(true),
        );
        expect(candidates(context)).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('follows neither Session when two creations declare the same path', async () => {
        const context = await fixture(2);
        await prime(context, 'launch-1', 0);
        await prime(context, 'launch-2', 1);
        for (const [launchId, sessionIndex] of [
            ['launch-1', 0],
            ['launch-2', 1],
        ] as const)
            // eslint-disable-next-line no-await-in-loop -- the second start must observe the first.
            await beginWorktreeCreation(context, {
                launchId,
                sessionIndex,
                worktreeCreatePath: context.worktreeRoot,
            });
        context.setWorktrees([
            { branch: 'main', rootPath: context.ownerRoot },
            { branch: 'feature/shared', rootPath: context.worktreeRoot },
        ]);

        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        context.service.observeShellToolFinished(
            shellFinished(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        await vi.waitFor(async () =>
            expect(
                (await context.readLogEvents()).filter(
                    (entry) => entry.fields?.reason === 'concurrent_creations',
                ).length,
            ).toBeGreaterThan(0),
        );
        expect(candidates(context)).toEqual([]);
        await context.service.close();
        context.database.close();
    });

    it('drops a failed sibling without disturbing the other declared creation', async () => {
        const { context } = await overlappingCreations({ first: true, second: true });

        context.service.observeShellToolFailed(
            shellFailed(context, {
                launchId: 'launch-2',
                sessionIndex: 1,
                worktreeCreateIntent: true,
            }),
        );
        context.service.observeShellToolFinished(
            shellFinished(context, { launchId: 'launch-1', worktreeCreateIntent: true }),
        );
        await vi.waitFor(() => expect(candidates(context)).toHaveLength(1));

        expect(candidates(context)[0].payload.rootPath).toBe(context.worktreeRoot);
        await context.service.close();
        context.database.close();
    });
});

function fixtureElsewhere(): string {
    return '/nonexistent-caxri-elsewhere';
}
