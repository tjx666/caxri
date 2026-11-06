import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { activeSessionsInSidebarOrder } from '../session-activity-order';

function project(id: string, orderIndex: number): ProjectRecord {
    return {
        id,
        rootPath: `/${id}`,
        title: id,
        orderIndex,
        createdAt: orderIndex,
        lastVisitedAt: orderIndex,
    };
}

function session(
    id: string,
    projectId: string,
    sessionActivityAt: number,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        id,
        projectId,
        workbenchRootProjectId: projectId,
        rootPath: `/${projectId}`,
        createdAt: sessionActivityAt,
        lastVisitedAt: sessionActivityAt,
        sidebarOrder: 0,
        sessionActivityAt,
        sessionActivityReason: 'created',
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        resolvedAttentionGeneration: 0,
        hasPendingAttention: false,
        hasUnread: false,
        title: id,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('Session Activity order', () => {
    it('preserves Project order while excluding archived Sessions', () => {
        const projects = [project('project-1', 0), project('project-2', 1)];
        expect(
            activeSessionsInSidebarOrder(projects, [
                session('project-2-newest', 'project-2', 100),
                session('project-1-oldest', 'project-1', 1),
                session('project-1-newest', 'project-1', 50),
                session('project-1-archived', 'project-1', 200, { archivedAt: 300 }),
            ]).map(({ id }) => id),
        ).toEqual(['project-1-newest', 'project-1-oldest', 'project-2-newest']);
    });

    describe('delegated Sessions', () => {
        const projects = [project('project-1', 0), project('project-2', 1)];
        const created = (
            id: string,
            projectId: string,
            creatorId: string,
            relation: 'consult' | 'delegated',
            sessionActivityAt: number,
        ) =>
            session(id, projectId, sessionActivityAt, {
                createdByRelation: relation,
                createdBySessionId: creatorId,
            });
        const sessions = [
            session('host', 'project-1', 10),
            session('other', 'project-1', 5),
            created('child-old', 'project-2', 'host', 'delegated', 1),
            created('child-new', 'project-2', 'host', 'delegated', 2),
            created('consult', 'project-1', 'host', 'consult', 3),
            session('own-row', 'project-2', 50),
        ];

        it('lists a nested Session right after its host, whatever Project it belongs to', () => {
            expect(activeSessionsInSidebarOrder(projects, sessions).map(({ id }) => id)).toEqual([
                'host',
                'child-new',
                'child-old',
                'consult',
                'other',
                'own-row',
            ]);
        });

        it('leaves hidden consults out when asked for navigable Sessions only', () => {
            expect(
                activeSessionsInSidebarOrder(projects, sessions, { navigableOnly: true }).map(
                    ({ id }) => id,
                ),
            ).toEqual(['host', 'child-new', 'child-old', 'other', 'own-row']);
        });

        it('keeps the selected consult in the navigable order', () => {
            expect(
                activeSessionsInSidebarOrder(projects, sessions, {
                    navigableOnly: true,
                    selectedSessionId: 'consult',
                }).map(({ id }) => id),
            ).toEqual(['host', 'consult', 'child-new', 'child-old', 'other', 'own-row']);
        });
    });
});
