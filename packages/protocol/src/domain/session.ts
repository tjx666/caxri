import { z } from 'zod';

import { identifierSchema } from './identifiers.js';
import { paneLayoutSchema } from './pane-layout.js';
import {
    extensionTreeViewStatesSchema,
    sourceControlViewStatesSchema,
    viewContainerIdSchema,
} from './views.js';

/**
 * Neutral automatic Session title used until the Session gains useful Agent metadata or a manual name. Shared so
 * Desktop Main can recognize it without importing Server Core domain code.
 */
export const DEFAULT_SESSION_TITLE = 'Untitled';

function hasLineBreakOrControl(value: string): boolean {
    return [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 31 || (code >= 127 && code <= 159) || code === 8_232 || code === 8_233;
    });
}

export const sessionRenameTitleSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !hasLineBreakOrControl(value), {
        message: 'Session name must be a single line without control characters',
    });

/**
 * Where a restored Session lands in its Project. `top` is the default because a Session restored from the Archived
 * Sessions dialog otherwise reappears at whatever position it held before archiving: usually somewhere down a long
 * list, so the restore the user just asked for produces no visible result. `unchanged` exists for the Undo on the
 * archive notice: that button is the exact inverse of one archive, and promoting there would let an accidental archive
 * plus Undo silently rewrite an order the user arranged by dragging.
 */
export const sessionRestorePlacementSchema = z.enum(['top', 'unchanged']).default('top');
export type SessionRestorePlacement = z.infer<typeof sessionRestorePlacementSchema>;
export const sessionStateSchema = z.object({
    sessionId: identifierSchema,
    /**
     * Optimistic-concurrency token for this Session's stored state, incremented by the Server on every write that
     * actually changes the row. Read it in a snapshot, send it back in `session.updateState`, and the Server can tell a
     * write assembled from the current state apart from one assembled from a state that has since moved.
     *
     * Two directions, two meanings: on a `session.updateState` request it is the revision the writer read, and the
     * Server rejects the write with `CONFLICT` when it no longer matches; on every snapshot and on the answer to an
     * accepted write it is the revision now stored. `0` means the Session has no stored state row yet.
     *
     * Not to be confused with the Server-private `state_version` column, which is a storage-schema version used to
     * decide whether a row can be parsed or must be repaired, and is identical for every row under one schema.
     */
    revision: z.number().int().nonnegative(),
    /**
     * Scopes every ordinary Editor path in this snapshot to one authorized Workbench Root.
     */
    workbenchProjectId: identifierSchema,
    /**
     * Last durable file mutation whose editor remap was applied to this atomic Session snapshot.
     */
    editorRemapOperationId: identifierSchema.optional(),
    /**
     * The user's durable intent. Availability is resolved against the Host catalog in the Renderer; unknown extension
     * IDs remain valid so a temporarily missing extension can reclaim the selection when it returns.
     */
    desiredSecondarySidebarViewContainerId: viewContainerIdSchema,
    /**
     * Bounded stable-id state for extension trees, scoped by Session, Workbench Root, and View.
     */
    extensionTreeViewStates: extensionTreeViewStatesSchema.optional(),
    /**
     * Bounded disclosure and mode state for Source Control views, scoped by Session and Workbench Root.
     */
    sourceControlViewStates: sourceControlViewStatesSchema.optional(),
    /**
     * The Workbench split tree: the single source of truth for which Terminals and documents are open, how they are
     * arranged, and which one each pane shows. Terminal processes stay Session-global; only their placement is
     * root-local, so this tree is stored per Workbench Root. See `docs/adr/0002-unified-pane-layout.md`.
     */
    paneLayout: paneLayoutSchema,
});

export type SessionState = z.infer<typeof sessionStateSchema>;
