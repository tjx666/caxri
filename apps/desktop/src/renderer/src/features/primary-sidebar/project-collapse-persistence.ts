import type { SharedLocalState } from '../../lib/local-storage';
import { createSharedLocalState } from '../../lib/local-storage';
import type { ProjectCollapseState } from './project-collapse';
import { parseProjectCollapseRecord } from './project-collapse';

/**
 * `v2` records the user's expansions as well as their collapses, so the stored vocabulary changed. Unrecognized values
 * are dropped rather than translated: this is local view state, and starting an unknown Project expanded is the same
 * thing a first launch does.
 */
export const PROJECT_COLLAPSE_STORAGE_KEY = 'caxri.primary-sidebar-project-collapse.v2';

/**
 * The fields to patch into the stored record so it matches `disclosure`, and nothing else. A key is removed only when
 * its Project is in `knownProjectIds`, because reconciliation also drops the records of Projects this window does not
 * list (another environment's, or one still loading), and those belong to the windows that do.
 */
export function projectCollapseChanges(
    persisted: Readonly<ProjectCollapseState>,
    disclosure: Readonly<ProjectCollapseState>,
    knownProjectIds: ReadonlySet<string> | undefined,
): Record<string, string | undefined> {
    const changes: Record<string, string | undefined> = {};
    for (const [projectId, value] of Object.entries(disclosure))
        if (persisted[projectId] !== value) changes[projectId] = value;
    if (knownProjectIds)
        for (const projectId of Object.keys(persisted))
            if (knownProjectIds.has(projectId) && disclosure[projectId] === undefined)
                changes[projectId] = undefined;
    return changes;
}

export interface ProjectCollapsePersistence {
    /**
     * What the shared record held when this window started, or when another window last changed it.
     */
    initial: () => ProjectCollapseState;
    /**
     * Writes only the Projects whose disclosure changed since the last read or write, merged into whatever the record
     * holds now, so a collapse made in another window meanwhile survives.
     */
    persist: (
        disclosure: Readonly<ProjectCollapseState>,
        knownProjectIds: ReadonlySet<string> | undefined,
    ) => void;
    /**
     * Follows other windows' changes. `apply` must update memory only, never call `persist` itself.
     */
    subscribe: (apply: (state: ProjectCollapseState) => void) => () => void;
}

/**
 * One window's view of the Project disclosure record that every window of the profile shares. Per-Project fields are
 * the unit of ownership: collapsing Project A here and Project B in a second window leaves both collapsed after a
 * restart.
 */
export function createProjectCollapsePersistence(
    storage: SharedLocalState<ProjectCollapseState> = createSharedLocalState(
        PROJECT_COLLAPSE_STORAGE_KEY,
        parseProjectCollapseRecord,
    ),
): ProjectCollapsePersistence {
    let persisted = storage.read();
    return {
        initial: () => persisted,
        persist: (disclosure, knownProjectIds) => {
            const changes = projectCollapseChanges(persisted, disclosure, knownProjectIds);
            if (Object.keys(changes).length === 0) return;
            persisted = storage.patch(changes);
        },
        subscribe: (apply) =>
            storage.subscribe((state) => {
                persisted = state;
                apply(state);
            }),
    };
}
