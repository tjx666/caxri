import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    acknowledgeCheckedUncertainCreate,
    availableNewSessionAgent,
    canCreateNewSession,
    forgetNewSessionProject,
    markUncertainSessionsChecked,
    NEW_SESSION_AGENT_ORDER,
    newSessionAgentReason,
    newSessionDefaultSurface,
    newSessionSurface,
    newSessionSurfaceDescription,
    projectFilterAfterCreate,
    selectedNewSessionProject,
    sortNewSessionProjects,
} from '../new-session-model';

describe('New Session choices', () => {
    it('offers every Agent provider as a choice', () => {
        for (const provider of agentProviderIds)
            expect(NEW_SESSION_AGENT_ORDER).toContain(provider);
    });

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
        expect(selectedNewSessionProject('granted', projects, null)).toBe('granted');
        expect(selectedNewSessionProject('removed', projects, null)).toBe('granted');
        expect(selectedNewSessionProject(null, [], null)).toBeNull();
    });

    it('starts in the Project chip the Session list is filtered to, unless a Project was picked', () => {
        // Sorted most recent first: without the chip, + under `caxri` created the Session in `recent`.
        const projects = [
            { id: 'recent', displayTitle: 'Recent', lastActivityAt: 200 },
            { id: 'caxri', displayTitle: 'caxri', lastActivityAt: 100 },
        ];
        expect(selectedNewSessionProject(null, projects, 'caxri')).toBe('caxri');
        expect(selectedNewSessionProject('recent', projects, 'caxri')).toBe('recent');
        expect(selectedNewSessionProject(null, projects, 'removed')).toBe('recent');
        expect(selectedNewSessionProject(null, projects, null)).toBe('recent');
    });

    it('moves a Project chip to the created Session so the list does not hide it', () => {
        expect(projectFilterAfterCreate('caxri', 'recent')).toBe('recent');
        expect(projectFilterAfterCreate('caxri', 'caxri')).toBe('caxri');
        expect(projectFilterAfterCreate(null, 'recent')).toBeNull();
    });

    it('forgets the earlier Project pick when another chip is chosen', () => {
        const picked = { agent: 'claude' as const, projectId: 'recent', surface: null };
        expect(forgetNewSessionProject(picked)).toEqual({ ...picked, projectId: null });
        const unpicked = { ...picked, projectId: null };
        expect(forgetNewSessionProject(unpicked)).toBe(unpicked);
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

    it('asks to reconnect instead of checking forever while offline without an answer', () => {
        const base = { isConnected: false, isError: false, isLoading: true };
        expect(newSessionAgentReason({ ...base, agent: undefined })).toBe(
            'Reconnect to check availability.',
        );
        expect(newSessionAgentReason({ ...base, agent: undefined, isConnected: true })).toBe(
            'Checking availability…',
        );
        expect(
            newSessionAgentReason({
                ...base,
                agent: { available: true },
                isConnected: true,
                isLoading: false,
            }),
        ).toBeUndefined();
    });
});

describe('New Session surface', () => {
    it("defaults a Chat-capable Agent to the Mac's Open Agents in Chat setting", () => {
        expect(newSessionSurface(null, 'claude', true)).toBe('chat');
        expect(newSessionSurface(null, 'codex', false)).toBe('pty');
    });

    it('keeps an explicit pick over the Mac setting', () => {
        expect(newSessionSurface('pty', 'claude', true)).toBe('pty');
        expect(newSessionSurface('chat', 'codex', false)).toBe('chat');
    });

    it('hides the choice for a Shell or no Agent, which always open in a Terminal', () => {
        expect(newSessionSurface('chat', 'shell', true)).toBeNull();
        expect(newSessionSurface('chat', null, true)).toBeNull();
    });
});

describe('New Session surface descriptions', () => {
    it('reads the default from the computer setting once it is known', () => {
        expect(newSessionDefaultSurface(undefined)).toBeNull();
        expect(newSessionDefaultSurface(true)).toBe('chat');
        expect(newSessionDefaultSurface(false)).toBe('pty');
    });

    it('explains each surface in one line and marks the default', () => {
        expect(newSessionSurfaceDescription('chat', 'chat')).toBe(
            'Replies as readable messages · Default',
        );
        expect(newSessionSurfaceDescription('pty', 'chat')).toBe("The Agent's own terminal screen");
        expect(newSessionSurfaceDescription('pty', null)).toBe("The Agent's own terminal screen");
    });
});
