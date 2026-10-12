import { isExternalEditorTabPath, isVirtualEditorTabPath } from '@caxri/protocol';

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
 * Defers to the protocol's single virtual-tab registry, so a new virtual scheme never leaks file status; the external
 * document is the one registered scheme that still edits text and therefore keeps its cursor and language.
 */
export function activeFileStatusTier(path: string): ActiveFileStatusTier {
    if (isExternalEditorTabPath(path)) return 'cursorOnly';
    return isVirtualEditorTabPath(path) ? 'hidden' : 'full';
}
