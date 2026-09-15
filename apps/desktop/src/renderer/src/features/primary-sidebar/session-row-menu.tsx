import type { ReactElement } from 'react';
import { useState } from 'react';

import type {
    ProjectRecord,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { useCommandShortcut } from '../../lib/keybindings';
import {
    archiveSession,
    copyAgentSessionId,
    copyAgentTranscriptPath,
    deleteSession,
    detachSession,
    hasDetachedAgentTerminal,
    hasLiveAgentTerminal,
    openProjectInExternalEditor,
    openSessionPullRequest,
    resumeSession,
} from '../session/session-commands';

/**
 * Right-click menu for one Session row. Every entry acts on the clicked row (not the selected Session), so the handlers
 * call the id-taking actions directly instead of the selected-Session commands the palette uses. Rename and Archive
 * show their sidebar key hints as literals: they are tree-local keys, not catalog keybindings.
 *
 * Rename is never disabled. A Session title belongs to Caxri, so the Server always commits it and only synchronizes it
 * to the Agent when that provider can accept one; greying the entry out here made the menu disagree with the row's own
 * Enter key, which always opened the input.
 *
 * This menu and that Enter key are rename's two entry points: the row's double-click now opens the Session instead,
 * because double-click means open everywhere else in this app and in the file managers it borrows from.
 */
export function SessionRowMenu({
    children,
    onBeginRename,
    onOpenChange,
    project,
    pullRequest,
    session,
    terminals,
}: {
    children: ReactElement;
    onBeginRename: () => void;
    onOpenChange?: (isOpen: boolean) => void;
    project: ProjectRecord;
    pullRequest?: SessionPullRequest;
    session: SessionRecord;
    terminals: TerminalRecord[];
}) {
    const deleteShortcut = useCommandShortcut('session.delete');
    const openInEditorShortcut = useCommandShortcut('project.openInEditor');
    const openPullRequestShortcut = useCommandShortcut('session.openPullRequest');
    const detached = hasDetachedAgentTerminal(session.id, terminals);
    const canDetach = hasLiveAgentTerminal(session.id, terminals);
    const primaryTerminal = terminals.find(
        (terminal) => terminal.id === session.primaryAgentTerminalId,
    );
    /**
     * Both copy entries read the Agent's durable identity, which only exists once the provider has created a
     * conversation — a Session whose Agent has not been bound yet has nothing to put on the clipboard.
     */
    const boundAgentSessionId = primaryTerminal?.agentSessionId;
    const unboundReason = 'This Session has no bound Agent conversation yet';
    /**
     * Rename is the one entry that leaves something focused behind: the row swaps itself for an input that must hold
     * focus, while every other entry hands off to a command and leaves the row alone. Closing a menu ends by returning
     * focus, and that return is what made `Rename` look dead (#950) — it fired one frame after the input mounted and
     * moved focus to an unrelated sidebar button, so the input blurred and `blurRename` ended a rename the user had
     * only just started. Two things keep them apart: `finalFocus` turns the return off for this close, and the rename
     * itself waits for `onOpenChangeComplete` so it begins after the popup is gone rather than racing it.
     *
     * `finalFocus` has to be the boolean, not a callback returning it: Base UI's focus manager gates the whole return
     * on the raw prop being truthy, so a function that answers `false` still runs the return — and with no element to
     * return to it walks to the first tabbable element in the document instead, which is how the focus reached a button
     * in the Project heading.
     */
    const [renameRequested, setRenameRequested] = useState(false);
    return (
        <ContextMenu
            onOpenChange={(isOpen) => {
                if (isOpen) setRenameRequested(false);
                onOpenChange?.(isOpen);
            }}
            onOpenChangeComplete={(isOpen) => {
                if (isOpen || !renameRequested) return;
                setRenameRequested(false);
                onBeginRename();
            }}
        >
            <ContextMenuTrigger render={children} />
            <ContextMenuContent
                aria-label={`${session.displayTitle} actions`}
                finalFocus={!renameRequested}
            >
                <ContextMenuItem hint="enter" onClick={() => setRenameRequested(true)}>
                    Rename
                </ContextMenuItem>
                <ContextMenuItem hint="delete" onClick={() => archiveSession(session.id)}>
                    Archive
                </ContextMenuItem>
                {detached ? (
                    <ContextMenuItem onClick={() => resumeSession(session.id)}>
                        Resume Agent
                    </ContextMenuItem>
                ) : (
                    <ContextMenuItem
                        disabled={!canDetach}
                        disabledReason={
                            canDetach ? undefined : 'No running Agent Terminal to detach'
                        }
                        onClick={() => detachSession(session.id)}
                    >
                        Detach Agent
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                    hint={openInEditorShortcut}
                    onClick={() => openProjectInExternalEditor(project, session.id)}
                >
                    Open Project in Editor
                </ContextMenuItem>
                {pullRequest && (
                    <ContextMenuItem
                        hint={openPullRequestShortcut}
                        onClick={() => openSessionPullRequest(pullRequest)}
                    >
                        Open Pull Request #{pullRequest.number}
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                    disabled={!boundAgentSessionId}
                    disabledReason={boundAgentSessionId ? undefined : unboundReason}
                    onClick={() => {
                        if (boundAgentSessionId) copyAgentSessionId(boundAgentSessionId);
                    }}
                >
                    Copy Agent Session ID
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={!boundAgentSessionId}
                    disabledReason={boundAgentSessionId ? undefined : unboundReason}
                    onClick={() => {
                        if (primaryTerminal && boundAgentSessionId)
                            copyAgentTranscriptPath(primaryTerminal.id);
                    }}
                >
                    Copy Transcript Path
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem hint={deleteShortcut} onClick={() => deleteSession(session.id)}>
                    Delete Session…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
