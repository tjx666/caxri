import type { BootstrapState } from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    getProjectSessionIds,
    getWorkbenchProjectSessionIds,
    selectSelectedProject,
    selectSelectedSession,
    selectSelectedWorkbenchProject,
} from './selectors';
import { useWorkbenchStore } from './workbench';

/**
 * Builds the minimal BootstrapState slice each selector actually reads. Fields outside `sessions` / `projects` / the
 * two `selected*Id` pointers are irrelevant to this module, so they are omitted rather than faked in full.
 */
function bootstrap(overrides: {
    sessions?: Array<{ id: string; projectId: string; workbenchRootProjectId: string }>;
    projects?: Array<{ id: string }>;
    selectedSessionId?: string;
    selectedProjectId?: string;
}): BootstrapState {
    return {
        sessions: overrides.sessions ?? [],
        projects: overrides.projects ?? [],
        selectedSessionId: overrides.selectedSessionId,
        selectedProjectId: overrides.selectedProjectId,
    } as unknown as BootstrapState;
}

describe('selectSelectedSession', () => {
    it('returns undefined when bootstrap is not loaded yet', () => {
        expect(selectSelectedSession(undefined)).toBeUndefined();
    });

    it('returns undefined when no Session id is selected', () => {
        const state = bootstrap({
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
            ],
        });

        expect(selectSelectedSession(state)).toBeUndefined();
    });

    it('returns the Session matching the selected id', () => {
        const state = bootstrap({
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
                { id: 'session-2', projectId: 'project-2', workbenchRootProjectId: 'project-2' },
            ],
            selectedSessionId: 'session-2',
        });

        expect(selectSelectedSession(state)?.id).toBe('session-2');
    });
});

describe('selectSelectedProject', () => {
    it('returns undefined when bootstrap is not loaded yet', () => {
        expect(selectSelectedProject(undefined)).toBeUndefined();
    });

    it('follows the selected Session to its owning Project', () => {
        const state = bootstrap({
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-owner',
                    workbenchRootProjectId: 'project-work',
                },
            ],
            projects: [{ id: 'project-owner' }, { id: 'project-work' }],
            selectedSessionId: 'session-1',
            selectedProjectId: 'project-work',
        });

        // PrimarySidebar ownership tracks `projectId`, not the Workbench Root, even when a different
        // Project is separately marked selected.
        expect(selectSelectedProject(state)?.id).toBe('project-owner');
    });

    it('falls back to the standalone Project selection when the Project has no Session', () => {
        const state = bootstrap({
            sessions: [],
            projects: [{ id: 'project-empty' }],
            selectedProjectId: 'project-empty',
        });

        expect(selectSelectedProject(state)?.id).toBe('project-empty');
    });

    it('returns undefined when neither a Session nor a standalone Project is selected', () => {
        const state = bootstrap({ projects: [{ id: 'project-1' }] });

        expect(selectSelectedProject(state)).toBeUndefined();
    });
});

describe('selectSelectedWorkbenchProject', () => {
    it('follows the selected Session to its active Workbench Project', () => {
        const state = bootstrap({
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-owner',
                    workbenchRootProjectId: 'project-worktree',
                },
            ],
            projects: [{ id: 'project-owner' }, { id: 'project-worktree' }],
            selectedSessionId: 'session-1',
        });

        expect(selectSelectedWorkbenchProject(state)?.id).toBe('project-worktree');
    });
});

describe('getProjectSessionIds', () => {
    beforeEach(() => {
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('returns only the origin Session when it has no Workbench Project', () => {
        useWorkbenchStore.setState({
            bootstrap: bootstrap({
                sessions: [{ id: 'session-1', projectId: 'project-1', workbenchRootProjectId: '' }],
            }),
        });

        expect(getProjectSessionIds('session-1')).toEqual(['session-1']);
    });

    it('returns the origin Session alone when bootstrap has not loaded', () => {
        expect(getProjectSessionIds('session-1')).toEqual(['session-1']);
    });

    it('reconciles every Session sharing the same Workbench Root', () => {
        useWorkbenchStore.setState({
            bootstrap: bootstrap({
                sessions: [
                    { id: 'session-1', projectId: 'project-a', workbenchRootProjectId: 'root-1' },
                    { id: 'session-2', projectId: 'project-b', workbenchRootProjectId: 'root-1' },
                    { id: 'session-3', projectId: 'project-c', workbenchRootProjectId: 'root-2' },
                ],
            }),
        });

        expect(getProjectSessionIds('session-1')).toEqual(['session-1', 'session-2']);
    });
});

describe('getWorkbenchProjectSessionIds', () => {
    beforeEach(() => {
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('returns every Session whose structured requests resolve against the Workbench Root', () => {
        useWorkbenchStore.setState({
            bootstrap: bootstrap({
                sessions: [
                    { id: 'session-1', projectId: 'project-a', workbenchRootProjectId: 'root-1' },
                    { id: 'session-2', projectId: 'project-b', workbenchRootProjectId: 'root-1' },
                ],
            }),
        });

        expect(getWorkbenchProjectSessionIds('root-1')).toEqual(['session-1', 'session-2']);
    });

    it('falls back to the origin Session id when no Session currently resolves the root', () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap({ sessions: [] }) });

        expect(getWorkbenchProjectSessionIds('root-1', 'session-origin')).toEqual([
            'session-origin',
        ]);
    });

    it('returns an empty list when nothing resolves the root and no fallback is given', () => {
        useWorkbenchStore.setState({ bootstrap: bootstrap({ sessions: [] }) });

        expect(getWorkbenchProjectSessionIds('root-1')).toEqual([]);
    });
});
