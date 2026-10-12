import { CaxriError } from '@caxri/protocol';

import { createTerminal } from '../features/terminal/terminal-commands';
import { translate } from '../i18n';
import { getSelectedSession } from '../stores/selectors';
import { tryCommand } from '../stores/toasts';
import { caxri } from './caxri';

/**
 * Hands one Workbench file to the desktop environment around it. Shared by the two menus that offer these actions (the
 * Files tree row and the editor tab), the same way `copy-file-path` is shared, so a file exposes one behavior no matter
 * which entry point the user right-clicks.
 *
 * The Session is read from the current selection instead of taken as an argument: both menus render inside the selected
 * Session's Workbench, and the Resource Explorer's own client is constructed from that same selection. Server Core
 * re-validates the path against that Session's authorized Project root before Main ever sees it, so this id is a scope
 * selector, not an authority claim.
 */
function requireSelectedSessionId(): string {
    const sessionId = getSelectedSession()?.id;
    if (!sessionId) throw new CaxriError('UNAVAILABLE', translate('core.files.noSessionSelected'));
    return sessionId;
}

export function revealFile(path: string): Promise<void | undefined> {
    return tryCommand(translate('core.files.revealFailed'), async () => {
        await caxri.request('files.reveal', { sessionId: requireSelectedSessionId(), path });
    });
}

/**
 * Opens one file with whatever application the operating system registers for its type, so an `.html` document lands in
 * the browser rather than staying inside Caxri's editor. Main turns a refused launch (an unregistered file type, a
 * missing application) into an error, so the failure reaches the user as a toast instead of a click that appears to do
 * nothing.
 */
export function openFileWithDefaultApp(path: string): Promise<void | undefined> {
    return tryCommand(translate('core.files.openWithDefaultAppFailed'), async () => {
        await caxri.request('files.openWithDefaultApp', {
            sessionId: requireSelectedSessionId(),
            path,
        });
    });
}

export function openFileInTerminal(directory: string): Promise<void> {
    return createTerminal('shell', { cwd: directory });
}

/**
 * The same three actions for an external document, a file outside every added Project. The Renderer holds only the
 * opaque ID Main issued when it read the file, and Main resolves it back to that file.
 */
export function revealExternalDocument(documentId: string): Promise<void | undefined> {
    return tryCommand(translate('core.files.revealFailed'), async () => {
        await caxri.request('externalDocument.reveal', { documentId });
    });
}

export function openExternalDocumentWithDefaultApp(documentId: string): Promise<void | undefined> {
    return tryCommand(translate('core.files.openWithDefaultAppFailed'), async () => {
        await caxri.request('externalDocument.openWithDefaultApp', { documentId });
    });
}

export function openExternalDocumentInTerminal(documentId: string): Promise<void> {
    return createTerminal('shell', { externalDocumentId: documentId });
}
