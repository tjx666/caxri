import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LATE_SNAPSHOT_GRACE_MS } from '../provenance-support';
import { beginWorktreeCreation, fixture, prime, shellFinished } from './roots.fixture';

type Context = Awaited<ReturnType<typeof fixture>>;

function candidates(context: Context) {
    return context.events.filter(
        (event): event is Extract<ServerEvent, { event: 'workbench.candidate' }> =>
            event.event === 'workbench.candidate',
    );
}

/**
 * A Codex or ACP Chat under Full access: `git worktree add` already finished when the start notification reached Server
 * Core, so the creation's before-snapshot already lists the new worktree.
 */
async function racedCreation(): Promise<Context | undefined> {
    const context = await fixture();
    await prime(context);
    await writeFile(join(context.worktreeRoot, '.git'), 'gitdir: elsewhere\n');
    // Some filesystems cannot report a birth time; the recovery then deliberately follows nothing.
    if (!((await lstat(join(context.worktreeRoot, '.git'))).birthtimeMs > 0)) return undefined;
    context.setWorktrees([
        { branch: 'main', rootPath: context.ownerRoot },
        { branch: 'feature/raced', rootPath: context.worktreeRoot },
    ]);
    return context;
}

function finish(context: Context): void {
    context.service.observeShellToolFinished(
        shellFinished(context, { worktreeCreateIntent: true }),
    );
}

describe('WorkbenchRootService worktree creation whose snapshot raced the command', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('follows the declared worktree born just before the creation started', async ({ skip }) => {
        const context = await racedCreation();
        if (!context) return skip();
        await beginWorktreeCreation(context, { worktreeCreatePath: context.worktreeRoot });
        finish(context);

        await vi.waitFor(() => expect(candidates(context)).toHaveLength(1));
        expect(candidates(context)[0].payload.rootPath).toBe(context.worktreeRoot);
        expect(
            (await context.readLogEvents()).some(
                (entry) => entry.event === 'workbench_root.provenance_late_snapshot',
            ),
        ).toBe(true);
        await context.service.close();
        context.database.close();
    });

    it('follows nothing when the declared worktree predates the creation', async ({ skip }) => {
        const context = await racedCreation();
        if (!context) return skip();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + LATE_SNAPSHOT_GRACE_MS + 60_000);
        await beginWorktreeCreation(context, { worktreeCreatePath: context.worktreeRoot });
        finish(context);

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

    it('follows nothing when the command declared no path', async ({ skip }) => {
        const context = await racedCreation();
        if (!context) return skip();
        await beginWorktreeCreation(context);
        finish(context);

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
});
