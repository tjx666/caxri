import { virtualEditorTabScheme } from '@caxri/protocol';

import { virtualTabDescriptors } from '../editor/virtual-tab-descriptors';

/**
 * How much file status the status bar shows for the active editor tab.
 *
 * - `full`: a Project file. Current-line blame, selection, cursor position, and language.
 * - `cursorOnly`: an external document (a file outside the Project, opened from a Terminal link). Its editor publishes
 *   cursor and language under the same status key as a Project file, but it has no Project history, so `git.blame` is
 *   never asked about it.
 * - `hidden`: every other virtual tab (file preview, Agent transcript, diff, Settings, ...), which has no cursor of its
 *   own.
 */
export type ActiveFileStatusTier = 'cursorOnly' | 'full' | 'hidden';

/**
 * Defers to the virtual-tab descriptor table, so a new virtual scheme cannot compile without declaring its status bar
 * eligibility and never leaks file status by default; the external document is the one scheme that still edits text and
 * therefore keeps its cursor and language.
 */
export function activeFileStatusTier(path: string): ActiveFileStatusTier {
    const scheme = virtualEditorTabScheme(path);
    return scheme ? virtualTabDescriptors[scheme].statusBar : 'full';
}
