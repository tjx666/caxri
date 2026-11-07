import type {
    AgentActivityState,
    SessionActivityReason,
    SessionAttentionKind,
    SessionRecord,
    SessionRelation,
    SessionTitleMode,
} from '@caxri/protocol';
import { sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { projects, sessions } from '../schema';

export const workbenchProjects = alias(projects, 'workbench_projects');
export const effectiveWorkbenchRootProjectId = sql<string>`COALESCE(${sessions.workbenchRootProjectId}, ${sessions.projectId})`;

export const sessionSelection = {
    id: sessions.id,
    projectId: sessions.projectId,
    workbenchRootProjectId: effectiveWorkbenchRootProjectId,
    rootPath: workbenchProjects.rootPath,
    createdAt: sessions.createdAt,
    lastVisitedAt: sessions.lastVisitedAt,
    sessionActivityAt: sessions.sessionActivityAt,
    turnStartedAt: sessions.turnStartedAt,
    sidebarOrder: sessions.sidebarOrder,
    sessionActivityReason: sessions.sessionActivityReason,
    archivedAt: sessions.archivedAt,
    pinnedAt: sessions.pinnedAt,
    pinnedOrder: sessions.pinnedOrder,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    agentActivityState: sessions.agentActivityState,
    attentionGeneration: sessions.attentionGeneration,
    acknowledgedAttentionGeneration: sessions.acknowledgedAttentionGeneration,
    resolvedAttentionGeneration: sessions.resolvedAttentionGeneration,
    attentionResolvedAt: sessions.attentionResolvedAt,
    lastAttentionKind: sessions.lastAttentionKind,
    lastViewedAt: sessions.lastViewedAt,
    title: sessions.title,
    titleMode: sessions.titleMode,
    createdBySessionId: sessions.createdBySessionId,
    createdByRelation: sessions.createdByRelation,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    workbenchRootProjectId: string;
    rootPath: string;
    createdAt: number;
    lastVisitedAt: number;
    sessionActivityAt: number;
    turnStartedAt: number | null;
    sidebarOrder: number;
    sessionActivityReason: string;
    archivedAt: number | null;
    pinnedAt: number | null;
    pinnedOrder: number;
    primaryAgentTerminalId: string | null;
    agentActivityState: string;
    attentionGeneration: number;
    acknowledgedAttentionGeneration: number;
    resolvedAttentionGeneration: number;
    attentionResolvedAt: number | null;
    lastAttentionKind: string | null;
    lastViewedAt: number | null;
    title: string;
    titleMode: string;
    createdBySessionId: string | null;
    createdByRelation: string | null;
}

export function mapSession(row: SessionJoinRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        workbenchRootProjectId: row.workbenchRootProjectId,
        rootPath: row.rootPath,
        createdAt: row.createdAt,
        lastVisitedAt: row.lastVisitedAt,
        sessionActivityAt: row.sessionActivityAt,
        sidebarOrder: row.sidebarOrder,
        sessionActivityReason: row.sessionActivityReason as SessionActivityReason,
        archivedAt: row.archivedAt ?? undefined,
        pinnedAt: row.pinnedAt ?? undefined,
        // Only meaningful while pinned; leaving it off an unpinned row keeps the read model from implying an order it does not have.
        pinnedOrder: row.pinnedAt === null ? undefined : row.pinnedOrder,
        primaryAgentTerminalId: row.primaryAgentTerminalId ?? undefined,
        agentActivityState: row.agentActivityState as AgentActivityState,
        attentionGeneration: row.attentionGeneration,
        acknowledgedAttentionGeneration: row.acknowledgedAttentionGeneration,
        lastAttentionKind: (row.lastAttentionKind as SessionAttentionKind | null) ?? undefined,
        resolvedAttentionGeneration: row.resolvedAttentionGeneration,
        ...(row.attentionResolvedAt !== null && { attentionResolvedAt: row.attentionResolvedAt }),
        ...(row.turnStartedAt !== null && { turnStartedAt: row.turnStartedAt }),
        hasUnread: row.attentionGeneration > row.acknowledgedAttentionGeneration,
        hasPendingAttention: row.attentionGeneration > row.resolvedAttentionGeneration,
        ...(row.lastViewedAt !== null && { lastViewedAt: row.lastViewedAt }),
        title: row.title,
        titleMode: row.titleMode as SessionTitleMode,
        ...(row.createdBySessionId && { createdBySessionId: row.createdBySessionId }),
        // Deleting the creator nulls only `created_by_session_id`, so a relation without its creator is a leftover.
        ...(row.createdBySessionId &&
            row.createdByRelation && {
                createdByRelation: row.createdByRelation as SessionRelation,
            }),
    };
}
