import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import { deriveDefaultEditorLayout, remapEditorLayoutPaths } from '../../../shared/editor-layout';
import { withoutEditorTabDirtiness } from '../../../shared/editor-state';
import { isGitDiffTabPath } from '../../../shared/git-diff';
import { sessionStateSchema } from '../../../shared/ipc/domain';
import { CaxriError } from '../../../shared/ipc/errors';
import { createTerminalLayout } from '../../../shared/terminal-layout';
import type {
    AgentActivityState,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
    SessionTitleMode,
} from '../../../shared/types';
import type { CaxriDrizzleDatabase } from '../connection';
import { DEFAULT_LAYOUT_VERSION } from '../connection';
import {
    CURRENT_SESSION_STATE_VERSION,
    projects,
    sessions,
    sessionState as sessionStateTable,
    terminals,
} from '../schema';

const workbenchProjects = alias(projects, 'workbench_projects');
const effectiveWorkbenchProjectId = sql<string>`COALESCE(${sessions.workbenchProjectId}, ${sessions.projectId})`;

const sessionSelection = {
    id: sessions.id,
    projectId: sessions.projectId,
    workbenchProjectId: effectiveWorkbenchProjectId,
    rootPath: workbenchProjects.rootPath,
    createdAt: sessions.createdAt,
    lastOpenedAt: sessions.lastOpenedAt,
    archivedAt: sessions.archivedAt,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    lastActivityState: sessions.lastActivityState,
    attentionEpoch: sessions.attentionEpoch,
    readAttentionEpoch: sessions.readAttentionEpoch,
    lastAttentionKind: sessions.lastAttentionKind,
    layoutVersion: sessions.layoutVersion,
    displayTitle: sessions.displayTitle,
    titleMode: sessions.titleMode,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    workbenchProjectId: string;
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
    archivedAt: number | null;
    primaryAgentTerminalId: string | null;
    lastActivityState: string;
    attentionEpoch: number;
    readAttentionEpoch: number;
    lastAttentionKind: string | null;
    layoutVersion: number;
    displayTitle: string;
    titleMode: string;
}

function mapSession(row: SessionJoinRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        workbenchProjectId: row.workbenchProjectId,
        rootPath: row.rootPath,
        createdAt: row.createdAt,
        lastOpenedAt: row.lastOpenedAt,
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
    };
}

export interface NewSessionInput {
    projectId: string;
    displayTitle: string;
}

export interface SessionWorkbenchBinding {
    projectId: string;
    workbenchProjectId: string;
    rootDevice?: string;
    rootInode?: string;
}

interface SessionStateRow {
    sessionId: string;
    projectId: string;
    workbenchProjectId: string | null;
    stateVersion: number;
    openTabsJson: string;
    activeTabJson: string | null;
    editorRemapOperationId: string | null;
    workbenchStateJson: string;
    inspectorMode: string;
    layoutJson: string;
}

const workbenchEditorStateSchema = z.object({
    openTabs: sessionStateSchema.shape.openTabs,
    activeTab: sessionStateSchema.shape.activeTab,
    editorRemapOperationId: sessionStateSchema.shape.editorRemapOperationId,
    editorLayout: sessionStateSchema.shape.editorLayout,
});
const workbenchEditorStatesSchema = z
    .record(z.string().min(1).max(200), workbenchEditorStateSchema)
    .refine((states) => Object.keys(states).length <= 1_024, 'Too many Workbench Root states');
// `Partial` corrects `z.record`'s inferred type: real lookups by workbenchProjectId key can miss
// (Session-owned root has no state yet), but zod's inference promises every value is present.
type WorkbenchEditorStates = Partial<z.infer<typeof workbenchEditorStatesSchema>>;

function parseWorkbenchEditorStates(source: string): WorkbenchEditorStates | undefined {
    try {
        const parsed = workbenchEditorStatesSchema.safeParse(JSON.parse(source) as unknown);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Remaps one stored editor path after a Project root move. Note the parallel implementation for the `editorLayout`
 * tree: `remapEditorLayoutPaths` in `src/shared/editor-layout.ts` does a pure string-prefix rewrite (browser-safe, no
 * `node:path`), while this one uses `relative`/`resolve`. Both agree for Caxri's canonical absolute POSIX-style paths;
 * if either ever needs to handle non-canonical input, change both together.
 */
function remapStoredEditorPath(path: string, previousPath: string, nextPath: string): string {
    if (isGitDiffTabPath(path)) return path;
    const nested = relative(previousPath, path);
    if (nested === '') return nextPath;
    if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) return path;
    return resolve(nextPath, nested);
}

export interface SessionStateRepair {
    reason: 'invalid_json' | 'invalid_shape' | 'unsupported_version';
    sessionId: string;
    stateVersion: number;
}

function parseSessionState(
    row: SessionStateRow,
): { state: SessionState } | { reason: SessionStateRepair['reason'] } {
    if (row.stateVersion !== CURRENT_SESSION_STATE_VERSION)
        return { reason: 'unsupported_version' };
    let layout: unknown;
    let legacyOpenTabs: unknown;
    let legacyActiveTab: unknown;
    let workbenchStatesSource: unknown;
    try {
        layout = JSON.parse(row.layoutJson) as unknown;
        legacyOpenTabs = JSON.parse(row.openTabsJson) as unknown;
        legacyActiveTab = row.activeTabJson
            ? (JSON.parse(row.activeTabJson) as unknown)
            : undefined;
        workbenchStatesSource = JSON.parse(row.workbenchStateJson) as unknown;
    } catch {
        return { reason: 'invalid_json' };
    }
    const workbenchStatesResult = workbenchEditorStatesSchema.safeParse(workbenchStatesSource);
    const activeTabResult = sessionStateSchema.shape.activeTab.safeParse(legacyActiveTab);
    if (!workbenchStatesResult.success || !activeTabResult.success)
        return { reason: 'invalid_shape' };
    const workbenchProjectId = row.workbenchProjectId ?? row.projectId;
    // `z.record`'s inferred value type promises every key is present; cast through the `Partial`
    // alias so the lookup below is correctly typed as possibly missing.
    const workbenchStates: WorkbenchEditorStates = workbenchStatesResult.data;
    const rootState = workbenchStates[workbenchProjectId];
    const isLegacyOwnerState = workbenchProjectId === row.projectId && !rootState;
    const activeTab = activeTabResult.data;
    const resolvedOpenTabs = rootState?.openTabs ?? (isLegacyOwnerState ? legacyOpenTabs : []);
    const resolvedActiveTab =
        rootState?.activeTab ??
        ((isLegacyOwnerState && activeTab?.kind === 'editor') || activeTab?.kind === 'terminal'
            ? activeTab
            : undefined);
    // `editorLayout` is additive state introduced after `openTabs`/`activeTab` already existed, so a row
    // persisted before this feature (or a Workbench Root that never wrote one) has no stored tree yet. Derive a
    // single-group default from the legacy tab list instead of bumping `CURRENT_SESSION_STATE_VERSION`, which
    // would otherwise mark every pre-existing row `unsupported_version`.
    const openTabsParsed = sessionStateSchema.shape.openTabs.safeParse(resolvedOpenTabs);
    const editorLayout =
        rootState?.editorLayout ??
        (openTabsParsed.success
            ? deriveDefaultEditorLayout(openTabsParsed.data, resolvedActiveTab)
            : undefined);
    const candidate: unknown = {
        sessionId: row.sessionId,
        workbenchProjectId,
        openTabs: resolvedOpenTabs,
        activeTab: resolvedActiveTab,
        editorRemapOperationId:
            rootState?.editorRemapOperationId ??
            (isLegacyOwnerState ? (row.editorRemapOperationId ?? undefined) : undefined),
        inspectorMode: row.inspectorMode,
        layout,
        editorLayout,
    };
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success ? { state: parsed.data } : { reason: 'invalid_shape' };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession, default titles, and
 * deletion-fallback selection are decided in `../../session-policy.ts` and applied here through plain setters. Session
 * JSON is versioned and schema-validated at this boundary so a corrupt or future row can be repaired without failing
 * the full Runtime bootstrap.
 */
export class SessionsModel {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly onStateRepair?: (repair: SessionStateRepair) => void,
    ) {}

    private defaultState(sessionId: string): SessionState {
        const session = this.database
            .select({
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .get();
        const firstTerminal = this.database
            .select({ id: terminals.id })
            .from(terminals)
            .where(eq(terminals.sessionId, sessionId))
            .orderBy(asc(terminals.orderIndex), asc(terminals.id))
            .get();
        return {
            sessionId,
            workbenchProjectId: session?.workbenchProjectId ?? session?.projectId ?? '',
            openTabs: [],
            inspectorMode: 'files',
            layout: firstTerminal ? createTerminalLayout(firstTerminal.id) : {},
            editorLayout: {},
        };
    }

    private readState(row: SessionStateRow): SessionState {
        const parsed = parseSessionState(row);
        if ('state' in parsed) {
            const normalized = withoutEditorTabDirtiness(parsed.state);
            if (normalized !== parsed.state) this.updateState(normalized);
            return normalized;
        }
        const repaired = this.defaultState(row.sessionId);
        this.updateState(repaired);
        this.onStateRepair?.({
            sessionId: row.sessionId,
            stateVersion: row.stateVersion,
            reason: parsed.reason,
        });
        return repaired;
    }

    list(projectId?: string): SessionRecord[] {
        const rows = projectId
            ? this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchProjectId),
                  )
                  .where(eq(sessions.projectId, projectId))
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all()
            : this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchProjectId),
                  )
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all();
        return rows.map(mapSession);
    }

    get(id: string): SessionRecord | undefined {
        const row = this.database
            .select(sessionSelection)
            .from(sessions)
            .innerJoin(workbenchProjects, eq(workbenchProjects.id, effectiveWorkbenchProjectId))
            .where(eq(sessions.id, id))
            .get();
        return row ? mapSession(row) : undefined;
    }

    getWorkbenchBinding(id: string): SessionWorkbenchBinding | undefined {
        const row = this.database
            .select({
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                rootDevice: sessions.workbenchRootDevice,
                rootInode: sessions.workbenchRootInode,
            })
            .from(sessions)
            .where(eq(sessions.id, id))
            .get();
        if (!row) return undefined;
        return {
            projectId: row.projectId,
            workbenchProjectId: row.workbenchProjectId ?? row.projectId,
            rootDevice: row.rootDevice ?? undefined,
            rootInode: row.rootInode ?? undefined,
        };
    }

    /**
     * Persists an alternate authorized Project, or null-normalizes the owning Project.
     */
    setWorkbenchProject(
        sessionId: string,
        projectId: string,
        identity?: { device: string; inode: string },
    ): boolean {
        const owner = this.database
            .select({ projectId: sessions.projectId })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .get();
        if (!owner) return false;
        const isAlternate = projectId !== owner.projectId;
        return (
            this.database
                .update(sessions)
                .set({
                    workbenchProjectId: isAlternate ? projectId : null,
                    workbenchRootDevice: isAlternate ? (identity?.device ?? null) : null,
                    workbenchRootInode: isAlternate ? (identity?.inode ?? null) : null,
                })
                .where(eq(sessions.id, sessionId))
                .run().changes === 1
        );
    }

    listUsingWorkbenchProject(projectId: string): SessionRecord[] {
        const ids = this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workbenchProjectId, projectId))
            .all();
        return ids.flatMap(({ id }) => {
            const session = this.get(id);
            return session ? [session] : [];
        });
    }

    /**
     * Clears explicit bindings before an authorized Project row can be deleted.
     */
    resetWorkbenchProject(projectId: string): string[] {
        const sessionIds = this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workbenchProjectId, projectId))
            .all()
            .map(({ id }) => id);
        if (sessionIds.length > 0)
            this.database
                .update(sessions)
                .set({
                    workbenchProjectId: null,
                    workbenchRootDevice: null,
                    workbenchRootInode: null,
                })
                .where(eq(sessions.workbenchProjectId, projectId))
                .run();
        return sessionIds;
    }

    /**
     * A new Session never starts with a primary Agent Terminal; the caller assigns one afterward.
     */
    insert(input: NewSessionInput): SessionRecord {
        const id = randomUUID();
        const now = Date.now();
        this.database
            .insert(sessions)
            .values({
                id,
                projectId: input.projectId,
                createdAt: now,
                lastOpenedAt: now,
                primaryAgentTerminalId: null,
                lastActivityState: 'idle',
                attentionEpoch: 0,
                readAttentionEpoch: 0,
                lastAttentionKind: null,
                layoutVersion: DEFAULT_LAYOUT_VERSION,
                displayTitle: input.displayTitle,
                titleMode: 'automatic',
            })
            .run();
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.database.delete(sessions).where(eq(sessions.id, id)).run().changes === 1;
    }

    /**
     * Returns true when a row existed and was touched.
     */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.database
                .update(sessions)
                .set({ lastOpenedAt: now })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }

    /**
     * Archiving is reversible metadata; it never removes or stops the Session's Terminals.
     */
    setArchived(id: string, archivedAt: number | null): boolean {
        return (
            this.database.update(sessions).set({ archivedAt }).where(eq(sessions.id, id)).run()
                .changes === 1
        );
    }

    setPrimaryAgent(
        id: string,
        patch: {
            primaryAgentTerminalId: string | null;
            displayTitle: string;
            lastActivityState: AgentActivityState;
        },
    ): void {
        this.database
            .update(sessions)
            .set({
                primaryAgentTerminalId: patch.primaryAgentTerminalId,
                displayTitle: patch.displayTitle,
                lastActivityState: patch.lastActivityState,
            })
            .where(eq(sessions.id, id))
            .run();
    }

    setDisplayTitleAndActivity(
        id: string,
        displayTitle: string,
        lastActivityState: AgentActivityState,
        attentionKind?: SessionAttentionKind,
    ): void {
        this.database
            .update(sessions)
            .set({
                displayTitle,
                lastActivityState,
                ...(attentionKind && {
                    attentionEpoch: sql`${sessions.attentionEpoch} + 1`,
                    lastAttentionKind: attentionKind,
                }),
            })
            .where(eq(sessions.id, id))
            .run();
    }

    /**
     * Acknowledges only the generation the Renderer actually displayed.
     */
    acknowledgeAttention(id: string, attentionEpoch: number): boolean {
        return (
            this.database
                .update(sessions)
                .set({ readAttentionEpoch: attentionEpoch })
                .where(
                    and(
                        eq(sessions.id, id),
                        eq(sessions.attentionEpoch, attentionEpoch),
                        lt(sessions.readAttentionEpoch, attentionEpoch),
                    ),
                )
                .run().changes === 1
        );
    }

    rename(id: string, displayTitle: string): boolean {
        return (
            this.database
                .update(sessions)
                .set({ displayTitle, titleMode: 'manual' })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }

    setActivityStateByPrimaryTerminal(
        terminalId: string,
        lastActivityState: AgentActivityState,
    ): void {
        this.database
            .update(sessions)
            .set({ lastActivityState })
            .where(eq(sessions.primaryAgentTerminalId, terminalId))
            .run();
    }

    getState(sessionId: string): SessionState {
        const row = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                stateVersion: sessionStateTable.stateVersion,
                openTabsJson: sessionStateTable.openTabsJson,
                activeTabJson: sessionStateTable.activeTabJson,
                editorRemapOperationId: sessionStateTable.editorRemapOperationId,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                inspectorMode: sessionStateTable.inspectorMode,
                layoutJson: sessionStateTable.layoutJson,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .where(eq(sessionStateTable.sessionId, sessionId))
            .get();
        if (!row) return this.defaultState(sessionId);
        return this.readState(row);
    }

    /**
     * Loads every 1:1 Session state row in the same stable order as {@link list}.
     */
    listStates(): SessionState[] {
        const rows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                stateVersion: sessionStateTable.stateVersion,
                openTabsJson: sessionStateTable.openTabsJson,
                activeTabJson: sessionStateTable.activeTabJson,
                editorRemapOperationId: sessionStateTable.editorRemapOperationId,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                inspectorMode: sessionStateTable.inspectorMode,
                layoutJson: sessionStateTable.layoutJson,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .orderBy(asc(sessions.createdAt), asc(sessions.id))
            .all();
        return rows.map((row) => this.readState(row));
    }

    insertInitialState(sessionId: string, terminalId?: string): void {
        this.database
            .insert(sessionStateTable)
            .values({
                sessionId,
                stateVersion: CURRENT_SESSION_STATE_VERSION,
                openTabsJson: '[]',
                activeTabJson: null,
                inspectorMode: 'files',
                layoutJson: JSON.stringify(terminalId ? createTerminalLayout(terminalId) : {}),
            })
            .run();
    }

    updateState(state: SessionState): void {
        const durableState = withoutEditorTabDirtiness(state);
        const binding = this.getWorkbenchBinding(state.sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (binding.workbenchProjectId !== state.workbenchProjectId)
            throw new CaxriError('CONFLICT', 'Session state belongs to a stale Workbench Root');
        const existing = this.database
            .select()
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, state.sessionId))
            .get();
        let workbenchStates: WorkbenchEditorStates = {};
        if (existing) {
            workbenchStates = parseWorkbenchEditorStates(existing.workbenchStateJson) ?? {};
        }
        const previousRootState = workbenchStates[state.workbenchProjectId];
        const rootActiveTab = durableState.activeTab ?? previousRootState?.activeTab;
        const rootEditorLayout = durableState.editorLayout ?? previousRootState?.editorLayout;
        workbenchStates = {
            ...workbenchStates,
            [state.workbenchProjectId]: {
                openTabs: durableState.openTabs,
                ...(rootActiveTab && { activeTab: rootActiveTab }),
                ...(durableState.editorRemapOperationId && {
                    editorRemapOperationId: durableState.editorRemapOperationId,
                }),
                ...(rootEditorLayout && { editorLayout: rootEditorLayout }),
            },
        };
        let existingTerminalActiveTab: SessionState['activeTab'];
        if (existing?.activeTabJson) {
            try {
                const parsed = sessionStateSchema.shape.activeTab.safeParse(
                    JSON.parse(existing.activeTabJson) as unknown,
                );
                if (parsed.success && parsed.data?.kind === 'terminal')
                    existingTerminalActiveTab = parsed.data;
            } catch {
                // The next Terminal activation replaces this legacy/global fallback.
            }
        }
        const terminalActiveTab =
            durableState.activeTab?.kind === 'terminal'
                ? durableState.activeTab
                : existingTerminalActiveTab;
        const isOwnerRoot = state.workbenchProjectId === binding.projectId;
        const values = {
            sessionId: durableState.sessionId,
            stateVersion: CURRENT_SESSION_STATE_VERSION,
            openTabsJson: isOwnerRoot
                ? JSON.stringify(durableState.openTabs)
                : (existing?.openTabsJson ?? '[]'),
            activeTabJson: terminalActiveTab ? JSON.stringify(terminalActiveTab) : null,
            editorRemapOperationId: isOwnerRoot
                ? (durableState.editorRemapOperationId ?? null)
                : (existing?.editorRemapOperationId ?? null),
            workbenchStateJson: JSON.stringify(workbenchStates),
            inspectorMode: durableState.inspectorMode,
            layoutJson: JSON.stringify(durableState.layout),
        };
        this.database
            .insert(sessionStateTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionStateTable.sessionId,
                set: {
                    openTabsJson: values.openTabsJson,
                    stateVersion: values.stateVersion,
                    activeTabJson: values.activeTabJson,
                    editorRemapOperationId: values.editorRemapOperationId,
                    workbenchStateJson: values.workbenchStateJson,
                    inspectorMode: values.inspectorMode,
                    layoutJson: values.layoutJson,
                },
            })
            .run();
    }

    /**
     * Remaps one durable root snapshot even when its Session has since selected another root.
     */
    remapWorkbenchEditorState(
        workbenchProjectId: string,
        operationId: string,
        previousPath: string,
        nextPath: string,
    ): number {
        const rows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                openTabsJson: sessionStateTable.openTabsJson,
                activeTabJson: sessionStateTable.activeTabJson,
                editorRemapOperationId: sessionStateTable.editorRemapOperationId,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .all();
        let remappedCount = 0;
        for (const row of rows) {
            const workbenchStates = parseWorkbenchEditorStates(row.workbenchStateJson);
            if (!workbenchStates) continue;
            const isOwnerRoot = row.projectId === workbenchProjectId;
            const isActiveRoot = (row.workbenchProjectId ?? row.projectId) === workbenchProjectId;
            let rootState = workbenchStates[workbenchProjectId];
            let legacyActiveTab: SessionState['activeTab'];
            const isUsingLegacyOwnerState = isOwnerRoot && !rootState;
            if (isUsingLegacyOwnerState) {
                let legacyOpenTabs: unknown;
                let legacyActiveWork: unknown;
                try {
                    legacyOpenTabs = JSON.parse(row.openTabsJson) as unknown;
                    legacyActiveWork = row.activeTabJson
                        ? (JSON.parse(row.activeTabJson) as unknown)
                        : undefined;
                } catch {
                    continue;
                }
                const openTabs = sessionStateSchema.shape.openTabs.safeParse(legacyOpenTabs);
                const activeTab = sessionStateSchema.shape.activeTab.safeParse(legacyActiveWork);
                if (!openTabs.success || !activeTab.success) continue;
                legacyActiveTab = activeTab.data;
                rootState = {
                    openTabs: openTabs.data,
                    ...(activeTab.data && { activeTab: activeTab.data }),
                    ...(row.editorRemapOperationId && {
                        editorRemapOperationId: row.editorRemapOperationId,
                    }),
                };
            }
            if (!rootState && isActiveRoot) rootState = { openTabs: [] };
            if (!rootState || rootState.editorRemapOperationId === operationId) continue;
            const remapPath = (path: string) => remapStoredEditorPath(path, previousPath, nextPath);
            const remappedState = {
                ...rootState,
                openTabs: rootState.openTabs.map((tab) => ({
                    ...tab,
                    path: remapPath(tab.path),
                })),
                activeTab:
                    rootState.activeTab?.kind === 'editor'
                        ? { kind: 'editor' as const, path: remapPath(rootState.activeTab.path) }
                        : rootState.activeTab,
                ...(rootState.editorLayout && {
                    editorLayout: remapEditorLayoutPaths(
                        rootState.editorLayout,
                        previousPath,
                        nextPath,
                    ),
                }),
                editorRemapOperationId: operationId,
            };
            const values: {
                activeTabJson?: string;
                editorRemapOperationId?: string;
                openTabsJson?: string;
                workbenchStateJson: string;
            } = {
                workbenchStateJson: JSON.stringify({
                    ...workbenchStates,
                    [workbenchProjectId]: remappedState,
                }),
            };
            if (isOwnerRoot) {
                values.openTabsJson = JSON.stringify(remappedState.openTabs);
                values.editorRemapOperationId = operationId;
                if (isUsingLegacyOwnerState && legacyActiveTab?.kind === 'editor')
                    values.activeTabJson = JSON.stringify(remappedState.activeTab);
            }
            this.database
                .update(sessionStateTable)
                .set(values)
                .where(eq(sessionStateTable.sessionId, row.sessionId))
                .run();
            remappedCount += 1;
        }
        return remappedCount;
    }
}
