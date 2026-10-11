import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db/index';
import { validateWorkbenchRequestContext } from '../request-context';

describe('validateWorkbenchRequestContext', () => {
    it('accepts only the currently selected Workbench Root for the Session', () => {
        const getSessionWorkbenchBinding = vi.fn(() => ({
            projectId: 'project-owner',
            rootPath: '/project-worktree',
            sessionId: 'session-1',
            workbenchProjectId: 'project-worktree',
        }));
        const database = { getSessionWorkbenchBinding } as unknown as CaxriDatabase;

        expect(() =>
            validateWorkbenchRequestContext(database, {
                sessionId: 'session-1',
                workbenchProjectId: 'project-worktree',
            }),
        ).not.toThrow();
        expect(() =>
            validateWorkbenchRequestContext(database, {
                sessionId: 'session-1',
                workbenchProjectId: 'project-owner',
            }),
        ).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    });
});
