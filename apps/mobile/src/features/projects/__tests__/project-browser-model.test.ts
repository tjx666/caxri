import { describe, expect, it } from 'vitest';

import {
    canAddProjectBrowserEntry,
    canAddProjectBrowserLevel,
    currentProjectBrowserLevel,
    enterProjectBrowserLevel,
    leaveProjectBrowserLevel,
    PROJECT_BROWSER_HOME,
} from '../project-browser-model';

describe('Add Project browser levels', () => {
    it('walks into folders and back without leaving home', () => {
        const code = enterProjectBrowserLevel([PROJECT_BROWSER_HOME], {
            name: 'code',
            path: 'code',
        });
        const app = enterProjectBrowserLevel(code, { name: 'app', path: 'code/app' });
        expect(currentProjectBrowserLevel(app)).toEqual({ name: 'app', path: 'code/app' });
        expect(currentProjectBrowserLevel(leaveProjectBrowserLevel(app))).toEqual({
            name: 'code',
            path: 'code',
        });
        expect(leaveProjectBrowserLevel([PROJECT_BROWSER_HOME])).toEqual([PROJECT_BROWSER_HOME]);
    });

    it('never offers home itself as a Project', () => {
        expect(canAddProjectBrowserLevel(PROJECT_BROWSER_HOME)).toBe(false);
        expect(canAddProjectBrowserLevel({ name: 'code', path: 'code' })).toBe(true);
    });

    it('offers Add on a row only where the footer cannot be reached or a repository is the obvious choice', () => {
        expect(canAddProjectBrowserEntry({ hasChildren: true, isGitRepository: true })).toBe(true);
        expect(canAddProjectBrowserEntry({ hasChildren: false, isGitRepository: false })).toBe(
            true,
        );
        expect(canAddProjectBrowserEntry({ hasChildren: true, isGitRepository: false })).toBe(
            false,
        );
    });
});
