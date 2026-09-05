import type { ReactElement } from 'react';

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
    deleteSession,
    detachSession,
    hasDetachedAgentTerminal,
    hasLiveAgentTerminal,
    openProjectInExternalEditor,
    openSessionPullRequest,
    resumeSession,
} from '../session/session-actions';

/**
 * Right-click menu for one Session row. Every entry acts on the clicked row (not the selected Session), so the handlers
 * call the id-taking actions directly instead of the selected-Session commands the palette uses. Rename and Archive
 * show their sidebar key hints as literals: they are tree-local keys, not catalog keybindings.
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
    return (
        <ContextMenu onOpenChange={onOpenChange}>
            <ContextMenuTrigger render={children} />
            <ContextMenuContent aria-label={`${session.displayTitle} actions`}>
                <ContextMenuItem hint="enter" onClick={onBeginRename}>
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
                <ContextMenuItem hint={deleteShortcut} onClick={() => deleteSession(session.id)}>
                    Delete Session…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
