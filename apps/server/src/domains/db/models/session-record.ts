import type {
    AgentActivityState,
    SessionActivityReason,
    SessionAttentionKind,
    SessionRecord,
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
    sidebarOrder: sessions.sidebarOrder,
    sessionActivityReason: sessions.sessionActivityReason,
    archivedAt: sessions.archivedAt,
    pinnedAt: sessions.pinnedAt,
    pinnedOrder: sessions.pinnedOrder,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    agentActivityState: sessions.agentActivityState,
    attentionGeneration: sessions.attentionGeneration,
    acknowledgedAttentionGeneration: sessions.acknowledgedAttentionGeneration,
    lastAttentionKind: sessions.lastAttentionKind,
    lastViewedAt: sessions.lastViewedAt,
    title: sessions.title,
    titleMode: sessions.titleMode,
    createdBySessionId: sessions.createdBySessionId,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    workbenchRootProjectId: string;
    rootPath: string;
    createdAt: number;
    lastVisitedAt: number;
    sessionActivityAt: number;
    sidebarOrder: number;
    sessionActivityReason: string;
    archivedAt: number | null;
    pinnedAt: number | null;
    pinnedOrder: number;
    primaryAgentTerminalId: string | null;
    agentActivityState: string;
    attentionGeneration: number;
    acknowledgedAttentionGeneration: number;
    lastAttentionKind: string | null;
    lastViewedAt: number | null;
    title: string;
    titleMode: string;
    createdBySessionId: string | null;
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
        hasUnread: row.attentionGeneration > row.acknowledgedAttentionGeneration,
        ...(row.lastViewedAt !== null && { lastViewedAt: row.lastViewedAt }),
        title: row.title,
        titleMode: row.titleMode as SessionTitleMode,
        ...(row.createdBySessionId && { createdBySessionId: row.createdBySessionId }),
    };
}
