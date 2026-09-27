import { describe, expect, it } from 'vitest';

import type { SessionTranscriptContext } from '../session-context';
import { fixture } from './workbench-roots.fixture';

const EMPTY: SessionTranscriptContext = {
    acceptanceReferences: [],
    branches: [],
    directories: [],
    linearReferences: [],
    pullRequests: {},
};

describe('Workbench Root conversation recommendations', () => {
    it('marks the worktree this Session’s conversation worked in, without changing its authorization', async () => {
        const context = await fixture(1, {
            sessionContext: () =>
                Promise.resolve({ ...EMPTY, directories: [context.worktreeRoot] }),
        });
        try {
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature', rootPath: context.worktreeRoot },
            ]);
            const roots = await context.service.listOptions(context.sessions[0].session.id);
            const recommended = roots.find((root) => root.rootPath === context.worktreeRoot)!;
            expect(recommended.conversationRank).toBe(0);
            // A recommendation is an ordering hint, never an authorization: this worktree has no Project yet.
            expect(recommended.authorization).toBe('required');
            expect(
                roots.find((root) => root.rootPath === context.ownerRoot)?.conversationRank,
            ).toBeUndefined();
        } finally {
            await context.service.close();
            context.database.close();
        }
    });

    it('recommends nothing for a directory Git topology does not report', async () => {
        const context = await fixture(1, {
            sessionContext: () =>
                Promise.resolve({ ...EMPTY, directories: ['/somewhere/that/is/not/a/worktree'] }),
        });
        try {
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature', rootPath: context.worktreeRoot },
            ]);
            const roots = await context.service.listOptions(context.sessions[0].session.id);
            expect(roots.every((root) => root.conversationRank === undefined)).toBe(true);
        } finally {
            await context.service.close();
            context.database.close();
        }
    });

    it('still opens the menu when the transcript cannot be read', async () => {
        const context = await fixture(1, {
            sessionContext: () => Promise.reject(new Error('transcript unreadable')),
        });
        try {
            context.setWorktrees([
                { branch: 'main', rootPath: context.ownerRoot },
                { branch: 'feature', rootPath: context.worktreeRoot },
            ]);
            const roots = await context.service.listOptions(context.sessions[0].session.id);
            expect(roots).toHaveLength(2);
            expect(roots.every((root) => root.conversationRank === undefined)).toBe(true);
        } finally {
            await context.service.close();
            context.database.close();
        }
    });
});
