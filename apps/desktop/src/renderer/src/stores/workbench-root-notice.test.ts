import { describe, expect, it } from 'vitest';

import { workbenchRootNotice } from './workbench-root-notice';

describe('workbench Root change notices', () => {
    const followed = {
        sessionId: 'session-1',
        workbenchProjectId: 'project-worktree',
        reason: 'followed',
        followedProjectTitle: 'feature-entered',
    } as const;

    it.each(['selected', 'authorized'] as const)(
        'owes the user nothing for a %s switch they performed themselves',
        (reason) => {
            expect(
                workbenchRootNotice(
                    { sessionId: 'session-1', workbenchProjectId: 'project-worktree', reason },
                    'project-owner',
                ),
            ).toBeUndefined();
        },
    );

    it('names the destination of an Agent move and offers the root it left', () => {
        expect(workbenchRootNotice(followed, 'project-owner')).toEqual({
            kind: 'followed',
            message: 'Switched to worktree "feature-entered" — an Agent moved there.',
            projectId: 'project-worktree',
            projectTitle: 'feature-entered',
            undoProjectId: 'project-owner',
        });
    });

    it.each([
        ['no snapshot has loaded', undefined],
        ['the previous root is the destination', 'project-worktree'],
    ])('still announces the move when %s, without an undo', (_case, previous) => {
        const notice = workbenchRootNotice(followed, previous);

        expect(notice).toMatchObject({
            kind: 'followed',
            message: 'Switched to worktree "feature-entered" — an Agent moved there.',
        });
        expect(notice).not.toHaveProperty('undoProjectId');
    });

    it('never goes silent when the destination title is missing', () => {
        expect(
            workbenchRootNotice(
                {
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-worktree',
                    reason: 'followed',
                },
                'project-owner',
            ),
        ).toMatchObject({ message: 'Switched to another worktree — an Agent moved there.' });
    });

    it('keeps naming the Project a fallback returned to', () => {
        expect(
            workbenchRootNotice(
                {
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-owner',
                    reason: 'fallback',
                    returnedProjectTitle: 'Owner Project',
                },
                'project-worktree',
            ),
        ).toEqual({
            kind: 'fallback',
            message: 'The active worktree is no longer available. Returned to Owner Project.',
            projectId: 'project-owner',
            projectTitle: 'Owner Project',
        });
    });
});
