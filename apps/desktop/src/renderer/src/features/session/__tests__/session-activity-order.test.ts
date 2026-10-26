import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { activeSessionsInSidebarOrder } from '../session-activity-order';

function project(id: string, orderIndex: number): ProjectRecord {
    return {
        id,
        rootPath: `/${id}`,
        displayTitle: id,
        orderIndex,
        createdAt: orderIndex,
        lastOpenedAt: orderIndex,
    };
}

function session(
    id: string,
    projectId: string,
    lastSessionActivityAt: number,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        id,
        projectId,
        workbenchProjectId: projectId,
        rootPath: `/${projectId}`,
        createdAt: lastSessionActivityAt,
        lastOpenedAt: lastSessionActivityAt,
        sidebarOrder: 0,
        lastSessionActivityAt,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: id,
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
});
