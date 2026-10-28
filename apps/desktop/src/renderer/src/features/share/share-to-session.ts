import type { TerminalRecord } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import { translate } from '../../i18n';
import {
    getBootstrap,
    getSessionState,
    selectSelectedWorkbenchProject,
} from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { returnUnsentAgentChatMessage } from '../agent-chat/composer-input/agent-chat-drafts';
import { chooseReferenceTerminal } from '../editor/file-reference';
import { didSelectSession } from '../session/session-commands';
import { activateTerminal } from '../terminal/terminal-commands';
import { terminalPathsInput } from '../terminal/terminal-drop';
import {
    didPasteIntoTerminal,
    focusTerminalById,
    whenTerminalAttached,
} from '../terminal/terminal-pane-handlers';
import type { ShareRequest } from './share-request-store';

/**
 * Upper bound for a just-revealed Terminal pane to mount and attach before the shared paths are abandoned, the same
 * bound `send-file-reference.ts` gives an editor reference.
 */
const TERMINAL_ATTACH_TIMEOUT_MS = 3000;

/**
 * Where a share goes inside its Session: the Agent Chat the user most recently had in front of them, otherwise the
 * Terminal `chooseReferenceTerminal` would pick for an editor reference. A Chat comes first because it takes the files
 * as cards and the text as a draft, while a Terminal can take only the paths.
 */
export function chooseShareTarget(
    terminals: readonly TerminalRecord[],
    sessionId: string,
    layout: Parameters<typeof chooseReferenceTerminal>[2],
): TerminalRecord | undefined {
    return (
        chooseReferenceTerminal(terminals.filter(isChatTerminal), sessionId, layout) ??
        chooseReferenceTerminal(terminals, sessionId, layout)
    );
}

/**
 * Hands a Share menu request to `sessionId`: selects the Session, then puts the files into its Chat composer as file
 * cards and the text into its draft, without sending. A Session with only Terminals gets the paths typed at its prompt,
 * spelled as a drop of the same files would be; its text is left out, since a line break typed into a shell runs it.
 * Returns whether the request was placed.
 */
export async function didShareToSession(
    sessionId: string,
    request: ShareRequest,
): Promise<boolean> {
    if (!(await didSelectSession(sessionId))) return false;
    const bootstrap = getBootstrap();
    const terminal =
        bootstrap &&
        chooseShareTarget(bootstrap.terminals, sessionId, getSessionState()?.paneLayout);
    if (!terminal || (!isChatTerminal(terminal) && request.files.length === 0)) {
        pushToast('error', translate('share.noTarget'));
        return false;
    }
    activateTerminal(terminal.id);
    if (isChatTerminal(terminal)) {
        // A failed send comes back to its composer through this same channel: into the composer on screen when it is
        // mounted, otherwise into the stored draft and cards it opens with.
        returnUnsentAgentChatMessage(
            terminal.id,
            request.text ?? '',
            request.files.map((file) => ({ id: crypto.randomUUID(), ...file })),
        );
        focusTerminalById(terminal.id);
        return true;
    }
    if (!(await whenTerminalAttached(terminal.id, TERMINAL_ATTACH_TIMEOUT_MS))) {
        pushToast('error', translate('share.terminalNotReady'));
        return false;
    }
    const input = terminalPathsInput(
        request.files.map((file) => file.path),
        terminal,
        selectSelectedWorkbenchProject(getBootstrap())?.rootPath,
    );
    if (input) didPasteIntoTerminal(terminal.id, input);
    focusTerminalById(terminal.id);
    return true;
}
