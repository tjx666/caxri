import { relative, resolve } from 'node:path';

import {
    closeTabs,
    isVirtualEditorTabPath,
    listPaneTabs,
    remapPaneLayoutPaths,
    sessionStateSchema,
} from '@caxri/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { isOutsideRoot, isSameOrInside } from '../../path-security';
import type { CaxriDrizzleDatabase } from '../connection';
import { sessionState as sessionStateTable } from '../schema';

/**
 * One Workbench Root's durable snapshot. Terminal processes are Session-global; only their placement lives here, so
 * switching Root restores a different arrangement of the same Terminals without restarting anything.
 */
const workbenchEditorStateSchema = z.object({
    editorRemapOperationId: sessionStateSchema.shape.editorRemapOperationId,
    extensionTreeViewStates: sessionStateSchema.shape.extensionTreeViewStates,
    sourceControlViewStates: sessionStateSchema.shape.sourceControlViewStates,
    paneLayout: sessionStateSchema.shape.paneLayout,
});
export const workbenchEditorStatesSchema = z
    .record(z.string().min(1).max(200), workbenchEditorStateSchema)
    .refine((states) => Object.keys(states).length <= 1_024, 'Too many Workbench Root states');
// `Partial` corrects `z.record`'s inferred type: real lookups by workbenchProjectId key can miss
// (Session-owned root has no state yet), but zod's inference promises every value is present.
export type WorkbenchEditorStates = Partial<z.infer<typeof workbenchEditorStatesSchema>>;

export function parseWorkbenchEditorStates(source: string): WorkbenchEditorStates | undefined {
    try {
        const parsed = workbenchEditorStatesSchema.safeParse(JSON.parse(source) as unknown);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export function pruneWorkbenchEditorState(source: string, projectId: string): string | undefined {
    try {
        const parsed = JSON.parse(source) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const candidate = { ...(parsed as Record<string, unknown>) };
        if (!Object.hasOwn(candidate, projectId)) return;
        delete candidate[projectId];
        if (!workbenchEditorStatesSchema.safeParse(candidate).success) return;
        return JSON.stringify(candidate);
    } catch {
        return;
    }
}

/**
 * Remaps one stored editor path after a Project root move. Note the parallel implementation for the `paneLayout` tree:
 * `remapPaneLayoutPaths` in `packages/protocol/src/domain/pane-layout-reducer.ts` does a pure string-prefix rewrite
 * (browser-safe, no `node:path`), while this one uses `relative`/`resolve`. Both agree for Caxri's canonical absolute
 * POSIX-style paths; if either ever needs to handle non-canonical input, change both together.
 */
function remapStoredEditorPath(path: string, previousPath: string, nextPath: string): string {
    if (isVirtualEditorTabPath(path)) return path;
    const nested = relative(previousPath, path);
    if (nested === '') return nextPath;
    if (isOutsideRoot(nested)) return path;
    return resolve(nextPath, nested);
}

/**
 * Rewrites every stored snapshot of one Workbench Root, including the Sessions parked on another root. `mutate` returns
 * `undefined` for a snapshot it leaves untouched, which is also how a caller declines work it has already done: see the
 * operation-id check in {@link remapWorkbenchEditorState}.
 */
function mutateRootStates(
    database: CaxriDrizzleDatabase,
    workbenchProjectId: string,
    mutate: (
        state: NonNullable<WorkbenchEditorStates[string]>,
    ) => NonNullable<WorkbenchEditorStates[string]> | undefined,
): number {
    const rows = database
        .select({
            sessionId: sessionStateTable.sessionId,
            workbenchStateJson: sessionStateTable.workbenchStateJson,
        })
        .from(sessionStateTable)
        .all();
    let changedCount = 0;
    for (const row of rows) {
        const workbenchStates = parseWorkbenchEditorStates(row.workbenchStateJson);
        const rootState = workbenchStates?.[workbenchProjectId];
        if (!workbenchStates || !rootState) continue;
        const nextState = mutate(rootState);
        if (!nextState) continue;
        database
            .update(sessionStateTable)
            .set({
                workbenchStateJson: JSON.stringify({
                    ...workbenchStates,
                    [workbenchProjectId]: nextState,
                }),
            })
            .where(eq(sessionStateTable.sessionId, row.sessionId))
            .run();
        changedCount += 1;
    }
    return changedCount;
}

/**
 * Remaps one durable root snapshot even when its Session has since selected another root. Terminal occurrences carry no
 * path, so only document tabs move.
 */
export function remapWorkbenchEditorState(
    database: CaxriDrizzleDatabase,
    workbenchProjectId: string,
    operationId: string,
    previousPath: string,
    nextPath: string,
): number {
    return mutateRootStates(database, workbenchProjectId, (rootState) =>
        rootState.editorRemapOperationId === operationId
            ? undefined
            : {
                  ...rootState,
                  paneLayout: remapPaneLayoutPaths(rootState.paneLayout, (path) =>
                      remapStoredEditorPath(path, previousPath, nextPath),
                  ),
                  editorRemapOperationId: operationId,
              },
    );
}

/**
 * The Trash counterpart of {@link remapWorkbenchEditorState}: drops the tabs for a path and its descendants from every
 * stored snapshot of one Workbench Root.
 *
 * A rename can be applied by the Renderer alone, because a Session parked elsewhere reloads a rewritten path when it
 * returns. A Trash cannot: the Renderer only holds the pane layout of the root each Session is currently showing
 * (`listStates` returns that one row; the rest live in `workbenchStateJson`), so a tab stored for another root would
 * survive and come back as a tab stuck on `Loading file…` for a file that no longer exists (issue #909).
 */
export function removeWorkbenchEditorPath(
    database: CaxriDrizzleDatabase,
    workbenchProjectId: string,
    path: string,
): number {
    return mutateRootStates(database, workbenchProjectId, (rootState) => {
        const closingIds = listPaneTabs(rootState.paneLayout).flatMap(({ tab }) =>
            tab.resource.kind === 'file' &&
            !isVirtualEditorTabPath(tab.resource.path) &&
            // `isSameOrInside` is the Server's counterpart of the Renderer's `isPathAtOrBelow`; both sides of the Trash
            // cleanup must agree on which tabs a directory owns, so neither may grow its own containment rule.
            isSameOrInside(path, tab.resource.path)
                ? [tab.id]
                : [],
        );
        if (closingIds.length === 0) return;
        return { ...rootState, paneLayout: closeTabs(rootState.paneLayout, closingIds) };
    });
}
