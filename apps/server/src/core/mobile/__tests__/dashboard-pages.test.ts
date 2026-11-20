import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { buildMobileDashboard, MOBILE_DASHBOARD_MAX_BYTES } from '../dashboard';

describe('buildMobileDashboard pages', () => {
    type DashboardInput = Parameters<typeof buildMobileDashboard>[0];
    type InputSession = DashboardInput['sessions'][number];
    const row = (id: string, overrides: Partial<InputSession> = {}): InputSession => ({
        id,
        projectId: 'project-1',
        workbenchRootProjectId: 'project-1',
        title: id,
        createdAt: 1,
        lastVisitedAt: 1,
        sessionActivityAt: 1,
        agentActivityState: 'idle',
        attentionGeneration: 1,
        hasUnread: false,
        hasPendingAttention: false,
        ...overrides,
    });
    const attention = (index: number): InputSession =>
        row(`attention-${index}`, {
            agentActivityState: 'completed',
            hasPendingAttention: true,
            lastAttentionKind: 'completed',
            sessionActivityAt: 1_000 + index,
        });
    const idle = (index: number, projectId = 'project-1'): InputSession =>
        row(`idle-${projectId}-${index}`, { projectId, sessionActivityAt: 100 + index });
    const dashboard = (sessions: InputSession[], query?: DashboardInput['query']) =>
        buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            projects: [
                { id: 'project-1', title: 'One' },
                { id: 'project-2', title: 'Two' },
            ],
            query,
            sessions,
            terminals: [],
        });

    it('answers each group its own first page, so a Needs attention backlog leaves room for new idle Sessions', () => {
        const result = dashboard([
            ...Array.from({ length: 120 }, (_, index) => attention(index)),
            row('new-idle', { sessionActivityAt: 50 }),
        ]);
        const ids = result.sessions.map(({ id }) => id);
        expect(ids).toContain('new-idle');
        expect(ids.filter((id) => id.startsWith('attention-'))).toEqual(
            Array.from({ length: 15 }, (_, index) => `attention-${119 - index}`),
        );
        expect(result.groupTotals).toEqual({ pinned: 0, attention: 120, working: 0, idle: 1 });
        expect(result.total).toBe(121);
        expect(result.truncated).toBe(true);
    });

    it('continues one group from an offset in its list order', () => {
        const sessions = Array.from({ length: 120 }, (_, index) => attention(index));
        const result = dashboard(sessions, { page: { group: 'attention', offset: 15 } });
        expect(result.sessions.map(({ id }) => id)).toEqual(
            Array.from({ length: 50 }, (_, index) => `attention-${104 - index}`),
        );
        expect(result.groupTotals.attention).toBe(120);
        expect(dashboard(sessions, { page: { group: 'attention', offset: 120 } }).sessions).toEqual(
            [],
        );
    });

    it('filters to one Project on the Server and still lists every Project', () => {
        const result = dashboard(
            [
                ...Array.from({ length: 30 }, (_, index) => idle(index, 'project-1')),
                ...Array.from({ length: 3 }, (_, index) => idle(index, 'project-2')),
            ],
            { projectId: 'project-2' },
        );
        expect(result.sessions.map(({ id }) => id)).toEqual([
            'idle-project-2-2',
            'idle-project-2-1',
            'idle-project-2-0',
        ]);
        expect(result.groupTotals.idle).toBe(3);
        expect(result.projects.map(({ id }) => id)).toEqual(['project-1', 'project-2']);
        expect(dashboard([idle(0)], { projectId: 'not-granted' }).total).toBe(0);
    });

    it('hides delegated work under a creator in another Project and keeps a child waiting on the user', () => {
        const result = dashboard(
            [
                row('creator'),
                row('delegated', {
                    projectId: 'project-2',
                    createdBySessionId: 'creator',
                    createdByRelation: 'delegated',
                }),
                row('asking', {
                    projectId: 'project-2',
                    createdBySessionId: 'creator',
                    createdByRelation: 'consult',
                    agentActivityState: 'waiting',
                    hasPendingAttention: true,
                    lastAttentionKind: 'waiting',
                }),
            ],
            { projectId: 'project-2' },
        );
        expect(result.sessions.map(({ id }) => id)).toEqual(['asking']);
        expect(result.total).toBe(1);
    });

    it('dates a Project by its latest Session activity or visit', () => {
        const result = dashboard([
            row('worked', { sessionActivityAt: 70, lastVisitedAt: 10 }),
            row('visited', { projectId: 'project-2', sessionActivityAt: 5, lastVisitedAt: 90 }),
        ]);
        expect(result.projects).toEqual([
            { id: 'project-1', title: 'One', lastActivityAt: 70 },
            { id: 'project-2', title: 'Two', lastActivityAt: 90 },
        ]);
    });

    it('shares the byte budget between groups and keeps each group an unbroken prefix', () => {
        const long = '🙂'.repeat(25);
        /**
         * Long Project and worktree names make 60 rows outgrow the budget.
         */
        const wide = (session: InputSession): InputSession => ({
            ...session,
            title: long,
            workbenchRootProjectId: 'worktree',
        });
        const sessions = [
            ...Array.from({ length: 15 }, (_, index) => attention(index)),
            ...Array.from({ length: 15 }, (_, index) =>
                row(`working-${index}`, {
                    agentActivityState: 'running',
                    turnStartedAt: 500 + index,
                }),
            ),
            ...Array.from({ length: 15 }, (_, index) => idle(index)),
            ...Array.from({ length: 15 }, (_, index) =>
                row(`pinned-${index}`, { pinnedAt: 10 + index, pinnedOrder: index }),
            ),
        ].map(wide);
        const result = buildMobileDashboard({
            hostDisplayName: 'Workstation',
            deviceRole: 'control',
            projects: Array.from({ length: 128 }, (_, index) => ({
                id: index === 0 ? 'project-1' : `project-extra-${index}`,
                title: long,
            })),
            sessions,
            terminals: [],
            worktreeProjects: [{ id: 'worktree', title: long }],
        });
        expect(result.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
            MOBILE_DASHBOARD_MAX_BYTES,
        );
        const counts = ['pinned-', 'attention-', 'working-', 'idle-'].map(
            (prefix) => result.sessions.filter(({ id }) => id.startsWith(prefix)).length,
        );
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        const attentionIds = result.sessions
            .filter(({ id }) => id.startsWith('attention-'))
            .map(({ id }) => id);
        expect(attentionIds).toEqual(
            Array.from({ length: attentionIds.length }, (_, index) => `attention-${14 - index}`),
        );
    });
});
