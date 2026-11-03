import type { ProjectRecord, SessionRecord, SessionRelation } from '@caxri/protocol';

export function project(id: string, orderIndex = 0): ProjectRecord {
    return {
        id,
        rootPath: `/${id}`,
        title: id,
        orderIndex,
        createdAt: 1,
        lastVisitedAt: 1,
    };
}

export function session(
    id: string,
    projectId: string,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return {
        id,
        projectId,
        workbenchRootProjectId: projectId,
        rootPath: `/${projectId}`,
        createdAt: 1,
        lastVisitedAt: 1,
        sidebarOrder: 0,
        sessionActivityAt: 1,
        sessionActivityReason: 'created',
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        title: id,
        titleMode: 'automatic',
        ...overrides,
    };
}

/**
 * A Session another Session created.
 */
export function createdBy(
    id: string,
    projectId: string,
    creatorId: string,
    relation: SessionRelation,
    overrides: Partial<SessionRecord> = {},
): SessionRecord {
    return session(id, projectId, {
        createdByRelation: relation,
        createdBySessionId: creatorId,
        ...overrides,
    });
}
