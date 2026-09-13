import { isVirtualEditorTabPath } from '@caxri/protocol';

import {
    getBootstrap,
    getSelectedSession,
    getSessionState,
    selectSelectedWorkbenchProject,
} from '../../stores/selectors';
import { sessionViewScope } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import {
    activateTerminal,
    focusTerminalById,
    sendTerminalSequence,
    whenTerminalAttached,
} from '../terminal/terminal-commands';
import { getActivePaneTab } from '../workbench/pane-actions';
import { editorStatusKey, useEditorStatusStore } from './editor-status';
import { chooseReferenceTerminal, formatFileReference } from './file-reference';

/**
 * Upper bound for a just-revealed Terminal pane to mount and attach before the reference is abandoned.
 */
const TERMINAL_ATTACH_TIMEOUT_MS = 3000;

function activeFileReference() {
    const session = getSelectedSession();
    const active = getActivePaneTab();
    if (!session || active?.resource.kind !== 'file') return;
    const path = active.resource.path;
    if (isVirtualEditorTabPath(path)) return;
    const scope = sessionViewScope(session.id, session.workbenchProjectId);
    const status = useEditorStatusStore.getState().statuses[editorStatusKey(scope, path)];
    return { session, path, status };
}

/**
 * Gate for `editor.sendReferenceToTerminal`: an ordinary file editor is active and its Session owns a Terminal.
 */
export function canSendActiveFileReference(): boolean {
    const reference = activeFileReference();
    if (!reference) return false;
    const bootstrap = getBootstrap();
    return Boolean(
        bootstrap &&
        chooseReferenceTerminal(
            bootstrap.terminals,
            reference.session.id,
            getSessionState()?.paneLayout,
        ),
    );
}

/**
 * Types `@path#L<line>` for the active editor's cursor (or selected line span) into the most recently opened Terminal
 * of the Session, then focuses that Terminal so the user can continue the prompt.
 *
 * The Terminal is revealed before the write because Server drops input for a Terminal without a mounted pane; the
 * reference is captured first so revealing the Terminal cannot change which editor it describes.
 */
export async function sendActiveFileReferenceToTerminal(): Promise<void> {
    const reference = activeFileReference();
    const bootstrap = getBootstrap();
    if (!reference || !bootstrap) return;
    const terminal = chooseReferenceTerminal(
        bootstrap.terminals,
        reference.session.id,
        getSessionState()?.paneLayout,
    );
    if (!terminal) {
        pushToast('error', 'Open a Terminal in this Session first');
        return;
    }
    const line = reference.status?.line ?? 1;
    const text = formatFileReference({
        path: reference.path,
        projectRoot: selectSelectedWorkbenchProject(bootstrap)?.rootPath,
        startLine: reference.status?.selectionStartLine ?? line,
        endLine: reference.status?.selectionEndLine ?? line,
    });
    activateTerminal(terminal.id);
    if (!(await whenTerminalAttached(terminal.id, TERMINAL_ATTACH_TIMEOUT_MS))) {
        pushToast('error', 'Terminal is not ready for input');
        return;
    }
    sendTerminalSequence(terminal.id, text);
    focusTerminalById(terminal.id);
}
