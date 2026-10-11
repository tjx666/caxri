import { isVirtualEditorTabPath } from '@caxri/protocol';

/**
 * Whether an active editor tab names a real Project file whose language, cursor, and encoding the status bar should
 * show. Defers to the protocol's single virtual-tab registry so a new virtual scheme (file preview, Agent transcript,
 * ...) never leaks file status; an external document tab stays hidden because it is registered there too.
 */
export function shouldShowActiveFileStatus(path: string): boolean {
    return !isVirtualEditorTabPath(path);
}
