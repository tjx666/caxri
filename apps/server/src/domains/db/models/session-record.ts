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
export const effectiveWorkbenchProjectId = sql<string>`COALESCE(${sessions.workbenchProjectId}, ${sessions.projectId})`;

export const sessionSelection = {
    id: sessions.id,
    projectId: sessions.projectId,
    workbenchProjectId: effectiveWorkbenchProjectId,
    rootPath: workbenchProjects.rootPath,
    createdAt: sessions.createdAt,
    lastOpenedAt: sessions.lastOpenedAt,
    lastSessionActivityAt: sessions.lastSessionActivityAt,
    sidebarOrder: sessions.sidebarOrder,
    lastSessionActivityReason: sessions.lastSessionActivityReason,
    archivedAt: sessions.archivedAt,
    pinnedAt: sessions.pinnedAt,
    pinnedOrder: sessions.pinnedOrder,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    lastActivityState: sessions.lastActivityState,
    attentionEpoch: sessions.attentionEpoch,
    readAttentionEpoch: sessions.readAttentionEpoch,
    lastAttentionKind: sessions.lastAttentionKind,
    lastViewedAt: sessions.lastViewedAt,
    displayTitle: sessions.displayTitle,
    titleMode: sessions.titleMode,
    createdBySessionId: sessions.createdBySessionId,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    workbenchProjectId: string;
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
    lastSessionActivityAt: number;
    sidebarOrder: number;
    lastSessionActivityReason: string;
    archivedAt: number | null;
    pinnedAt: number | null;
    pinnedOrder: number;
    primaryAgentTerminalId: string | null;
    lastActivityState: string;
    attentionEpoch: number;
    readAttentionEpoch: number;
    lastAttentionKind: string | null;
    lastViewedAt: number | null;
    displayTitle: string;
    titleMode: string;
    createdBySessionId: string | null;
}

export function mapSession(row: SessionJoinRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        workbenchProjectId: row.workbenchProjectId,
        rootPath: row.rootPath,
        createdAt: row.createdAt,
        lastOpenedAt: row.lastOpenedAt,
        lastSessionActivityAt: row.lastSessionActivityAt,
        sidebarOrder: row.sidebarOrder,
        lastSessionActivityReason: row.lastSessionActivityReason as SessionActivityReason,
        archivedAt: row.archivedAt ?? undefined,
        pinnedAt: row.pinnedAt ?? undefined,
        // Only meaningful while pinned; leaving it off an unpinned row keeps the read model from implying an order it does not have.
        pinnedOrder: row.pinnedAt === null ? undefined : row.pinnedOrder,
        primaryAgentTerminalId: row.primaryAgentTerminalId ?? undefined,
        lastActivityState: row.lastActivityState as AgentActivityState,
        attentionEpoch: row.attentionEpoch,
        readAttentionEpoch: row.readAttentionEpoch,
        lastAttentionKind: (row.lastAttentionKind as SessionAttentionKind | null) ?? undefined,
        hasUnread: row.attentionEpoch > row.readAttentionEpoch,
        ...(row.lastViewedAt !== null && { lastViewedAt: row.lastViewedAt }),
        displayTitle: row.displayTitle,
        titleMode: row.titleMode as SessionTitleMode,
        ...(row.createdBySessionId && { createdBySessionId: row.createdBySessionId }),
    };
}
