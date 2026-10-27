import type { SessionRecord, WorkbenchRootOption } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { withConversationRanks } from '../root-discovery';

function option(
    overrides: Partial<WorkbenchRootOption> & Pick<WorkbenchRootOption, 'branch' | 'rootPath'>,
): WorkbenchRootOption {
    return {
        worktreeId: overrides.rootPath,
        authorization: 'authorized',
        title: overrides.rootPath,
        isMain: false,
        owner: false,
        ...overrides,
    };
}

const options = [
    option({ branch: 'main', rootPath: '/repo', isMain: true, projectId: 'repo' }),
    option({ branch: 'feat/alpha', rootPath: '/worktrees/alpha', projectId: 'alpha' }),
    option({ branch: 'feat/beta', rootPath: '/worktrees/beta' }),
    option({ branch: 'feat/gamma', rootPath: '/worktrees/gamma' }),
    option({ branch: 'feat/delta', rootPath: '/worktrees/delta' }),
];

const onMain = { workbenchRootProjectId: 'repo' } as SessionRecord;
const onWorktree = { workbenchRootProjectId: 'alpha' } as SessionRecord;

async function ranks(
    session: SessionRecord,
    context: { branches?: readonly string[]; directories?: readonly string[] },
): Promise<Array<[string, number]>> {
    const ranked = await withConversationRanks(session, options, () =>
        Promise.resolve({
            branches: context.branches ?? [],
            directories: context.directories ?? [],
        }),
    );
    return ranked
        .filter((entry) => entry.conversationRank !== undefined)
        .map((entry) => [entry.rootPath, entry.conversationRank!]);
}

describe('conversation worktree ranking', () => {
    it('ranks directories ahead of branches, each most recently named first', async () => {
        await expect(
            ranks(onMain, {
                branches: ['feat/gamma'],
                directories: ['/worktrees/beta', '/worktrees/alpha'],
            }),
        ).resolves.toEqual([
            ['/worktrees/alpha', 1],
            ['/worktrees/beta', 0],
            ['/worktrees/gamma', 2],
        ]);
    });

    it('never recommends the main worktree, which is where the Session already is', async () => {
        await expect(
            ranks(onMain, { branches: ['main'], directories: ['/repo'] }),
        ).resolves.toEqual([]);
    });

    it('ignores directories and branches Git topology did not report', async () => {
        await expect(
            ranks(onMain, {
                branches: ['feat/nonexistent'],
                directories: ['/somewhere/else', '/worktrees/alpha'],
            }),
        ).resolves.toEqual([['/worktrees/alpha', 0]]);
    });

    it('caps the group so it stays a shortcut rather than a second list', async () => {
        await expect(
            ranks(onMain, {
                directories: [
                    '/worktrees/alpha',
                    '/worktrees/beta',
                    '/worktrees/gamma',
                    '/worktrees/delta',
                ],
            }),
        ).resolves.toHaveLength(3);
    });

    it('does not rank one worktree twice when its directory and branch were both named', async () => {
        await expect(
            ranks(onMain, { branches: ['feat/alpha'], directories: ['/worktrees/alpha'] }),
        ).resolves.toEqual([['/worktrees/alpha', 0]]);
    });

    it('says nothing once the Session has already chosen a worktree', async () => {
        await expect(ranks(onWorktree, { directories: ['/worktrees/alpha'] })).resolves.toEqual([]);
    });

    it('reads no transcript at all when no reader is wired', async () => {
        const ranked = await withConversationRanks(onMain, options);
        expect(ranked.every((entry) => entry.conversationRank === undefined)).toBe(true);
    });
});
