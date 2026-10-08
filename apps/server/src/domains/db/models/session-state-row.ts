import type { SessionState } from '@caxri/protocol';
import { sessionStateSchema } from '@caxri/protocol';

import { CURRENT_SESSION_STATE_VERSION } from '../schema';
import type { WorkbenchEditorStates } from './workbench-editor-state';
import { workbenchEditorStatesSchema } from './workbench-editor-state';

/**
 * The stored `session_state` row joined with its Session's Project binding, as every read in
 * {@link ../models/sessions.SessionsModel} selects it.
 */
export interface SessionStateRow {
    sessionId: string;
    projectId: string;
    workbenchProjectId: string | null;
    revision: number;
    stateVersion: number;
    workbenchStateJson: string;
    desiredSecondarySidebarViewContainerId: string;
}

export interface SessionStateRepair {
    reason: 'invalid_json' | 'invalid_shape' | 'unsupported_version';
    sessionId: string;
    stateVersion: number;
}

/**
 * One `session.updateState` that stored exactly the row it found, reported with this lifetime's running totals.
 *
 * A write nobody can see is the hardest kind of defect to find: it costs a round trip and a SQLite write per
 * occurrence, and it turns an ordinary interaction into a failure surface, because the Session behind it may have been
 * deleted or the application may be quitting by the time the write lands. That is exactly how "Unable to activate
 * Terminal" reached unrelated E2E specs (#877): a Terminal regaining focus rebuilt an identical pane layout and wrote
 * it back, and nothing anywhere recorded that the write changed nothing. Each report carries both the occurrence and
 * the totals so the real volume stays readable without one client having to sample it.
 */
export interface SessionStateUnchangedWrite {
    sessionId: string;
    workbenchProjectId: string;
    unchangedWrites: number;
    totalWrites: number;
}

/**
 * `fallbackPaneLayout` covers a Workbench Root the Session has never arranged: the row itself is healthy, so this is an
 * ordinary first visit rather than a repair.
 */
export function parseSessionState(
    row: SessionStateRow,
    fallbackPaneLayout: () => SessionState['paneLayout'],
): { state: SessionState; isNewRoot: boolean } | { reason: SessionStateRepair['reason'] } {
    if (row.stateVersion !== CURRENT_SESSION_STATE_VERSION)
        return { reason: 'unsupported_version' };
    let workbenchStatesSource: unknown;
    try {
        workbenchStatesSource = JSON.parse(row.workbenchStateJson) as unknown;
    } catch {
        return { reason: 'invalid_json' };
    }
    const workbenchStates = workbenchEditorStatesSchema.safeParse(workbenchStatesSource);
    if (!workbenchStates.success) return { reason: 'invalid_shape' };
    const workbenchProjectId = row.workbenchProjectId ?? row.projectId;
    // `z.record`'s inferred value type promises every key is present; cast through the `Partial`
    // alias so the lookup below is correctly typed as possibly missing.
    const states: WorkbenchEditorStates = workbenchStates.data;
    const rootState = states[workbenchProjectId];
    const candidate: unknown = {
        sessionId: row.sessionId,
        revision: row.revision,
        workbenchProjectId,
        editorRemapOperationId: rootState?.editorRemapOperationId,
        // Availability is presentation state. Keep the desired ID even while its extension is absent or crashed.
        desiredSecondarySidebarViewContainerId: row.desiredSecondarySidebarViewContainerId,
        extensionTreeViewStates: rootState?.extensionTreeViewStates,
        sourceControlViewStates: rootState?.sourceControlViewStates,
        paneLayout: rootState?.paneLayout ?? fallbackPaneLayout(),
    };
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success
        ? { state: parsed.data, isNewRoot: !rootState }
        : { reason: 'invalid_shape' };
}
