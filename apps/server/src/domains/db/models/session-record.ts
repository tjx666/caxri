import type {
    AgentActivityState,
    SessionActivityReason,
    SessionAttentionKind,
    SessionAutoNamingState,
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
    lastSessionActivityReason: sessions.lastSessionActivityReason,
    archivedAt: sessions.archivedAt,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    lastActivityState: sessions.lastActivityState,
    attentionEpoch: sessions.attentionEpoch,
    readAttentionEpoch: sessions.readAttentionEpoch,
    lastAttentionKind: sessions.lastAttentionKind,
    layoutVersion: sessions.layoutVersion,
    displayTitle: sessions.displayTitle,
    titleMode: sessions.titleMode,
    autoNamingState: sessions.autoNamingState,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    workbenchProjectId: string;
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
    lastSessionActivityAt: number;
    lastSessionActivityReason: string;
    archivedAt: number | null;
    primaryAgentTerminalId: string | null;
    lastActivityState: string;
    attentionEpoch: number;
    readAttentionEpoch: number;
    lastAttentionKind: string | null;
    layoutVersion: number;
    displayTitle: string;
    titleMode: string;
    autoNamingState: string;
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
        lastSessionActivityReason: row.lastSessionActivityReason as SessionActivityReason,
        archivedAt: row.archivedAt ?? undefined,
        primaryAgentTerminalId: row.primaryAgentTerminalId ?? undefined,
        lastActivityState: row.lastActivityState as AgentActivityState,
        attentionEpoch: row.attentionEpoch,
        readAttentionEpoch: row.readAttentionEpoch,
        lastAttentionKind: (row.lastAttentionKind as SessionAttentionKind | null) ?? undefined,
        hasUnread: row.attentionEpoch > row.readAttentionEpoch,
        layoutVersion: row.layoutVersion,
        displayTitle: row.displayTitle,
        titleMode: row.titleMode as SessionTitleMode,
        autoNamingState: row.autoNamingState as SessionAutoNamingState,
    };
}
