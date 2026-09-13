import { expect, it } from 'vitest';

import { hasWorktreeSession } from '../project-worktree-slot';
import { sessionListWindow } from '../session-list-window';

it('reserves the marker column when the only worktree Session is outside the reveal window', () => {
    const sessions = Array.from({ length: 7 }, (_, index) => ({ id: `session-${index + 1}` }));
    const worktreeProjects = { 'session-7': {} };
    const window = sessionListWindow(sessions, undefined, 'session-1');

    expect(window.visibleSessions).toHaveLength(5);
    expect(hasWorktreeSession(window.visibleSessions, worktreeProjects)).toBe(false);
    expect(hasWorktreeSession(sessions, worktreeProjects)).toBe(true);
});
