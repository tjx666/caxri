import { describe, expect, it } from 'vitest';

import {
    acknowledgeCheckedUncertainCreate,
    availableNewSessionAgent,
    canCreateNewSession,
    markUncertainSessionsChecked,
    selectedNewSessionProject,
    sortNewSessionProjects,
} from '../new-session-model';

describe('New Session choices', () => {
    it('sorts granted Projects by server-projected recent use, then title', () => {
        const projects = [
            { id: 'older', displayTitle: 'Older', lastActivityAt: 100 },
            { id: 'unused', displayTitle: 'Unused' },
            { id: 'recent', displayTitle: 'Recent', lastActivityAt: 200 },
        ];
        const sorted = sortNewSessionProjects(projects);
        expect(sorted.map(({ id }) => id)).toEqual(['recent', 'older', 'unused']);
        expect(projects[0]?.id).toBe('older');
    });

    it('sorts using Project recency even when no Session is in the dashboard', () => {
        const sorted = sortNewSessionProjects([
            { id: 'visible', displayTitle: 'Visible' },
            { id: 'hidden', displayTitle: 'Hidden', lastActivityAt: 500 },
        ]);
        expect(sorted.map(({ id }) => id)).toEqual(['hidden', 'visible']);
    });

    it('keeps a remembered granted Project and rejects a removed grant', () => {
        const projects = [{ id: 'granted', displayTitle: 'Granted' }];
        expect(selectedNewSessionProject('granted', projects)).toBe('granted');
        expect(selectedNewSessionProject('removed', projects)).toBe('granted');
        expect(selectedNewSessionProject(null, [])).toBeNull();
    });

    it('does not select an unavailable Agent, even when remembered', () => {
        const agents = [
            { kind: 'claude' as const, available: false, reason: 'CLI unavailable.' },
            { kind: 'codex' as const, available: true },
        ];
        expect(availableNewSessionAgent('claude', agents)).toBe('codex');
        expect(availableNewSessionAgent('codex', agents)).toBe('codex');
        expect(availableNewSessionAgent(null, [agents[0]])).toBeNull();
    });

    it('allows only a control device with fresh choices to create once', () => {
        const ready = {
            agent: 'claude' as const,
            createState: { kind: 'idle' as const },
            dashboardError: null,
            hasDashboard: true,
            isAvailabilityError: false,
            isAvailabilityLoading: false,
            isForeground: true,
            projectId: 'project-1',
            role: 'control' as const,
            status: 'connected' as const,
        };
        expect(canCreateNewSession(ready)).toBe(true);
        expect(canCreateNewSession({ ...ready, role: 'reply' })).toBe(false);
        expect(canCreateNewSession({ ...ready, role: 'view' })).toBe(false);
        expect(canCreateNewSession({ ...ready, role: null })).toBe(false);
        expect(
            canCreateNewSession({
                ...ready,
                createState: { kind: 'partial', sessionId: 'created', message: 'Launch failed' },
            }),
        ).toBe(false);
        expect(canCreateNewSession({ ...ready, createState: { kind: 'creating' } })).toBe(false);
        expect(canCreateNewSession({ ...ready, isAvailabilityError: true })).toBe(false);
    });

    it('requires an explicit Sessions check before resetting an uncertain create', () => {
        const uncertain = {
            kind: 'uncertain' as const,
            checkedSessions: false,
            message: 'Delivery is unknown.',
        };
        expect(acknowledgeCheckedUncertainCreate(uncertain)).toEqual(uncertain);
        const checked = markUncertainSessionsChecked(uncertain);
        expect(checked).toEqual({ ...uncertain, checkedSessions: true });
        expect(acknowledgeCheckedUncertainCreate(checked)).toEqual({ kind: 'idle' });
    });
});
