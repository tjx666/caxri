import { describe, expect, it } from 'vitest';

import { workbenchRootNotice } from './workbench-root-notice';

describe('workbench Root change notices', () => {
    it.each(['selected', 'authorized', 'followed'] as const)(
        'owes the user nothing for a %s switch',
        (reason) => {
            expect(
                workbenchRootNotice({
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-worktree',
                    reason,
                }),
            ).toBeUndefined();
        },
    );

    it('keeps naming the Project a fallback returned to', () => {
        expect(
            workbenchRootNotice({
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-owner',
                reason: 'fallback',
                returnedProjectTitle: 'Owner Project',
            }),
        ).toEqual({
            message: 'The active worktree is no longer available. Returned to Owner Project.',
            projectId: 'project-owner',
            projectTitle: 'Owner Project',
        });
    });
});
