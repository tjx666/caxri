import type { ReactElement } from 'react';

import type {
    ProjectRecord,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';

import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { readCommandShortcut } from '../../lib/keybindings';
import { fetchCaxriQuery } from '../../queries/client';
import { revokePermissionAutoAllow } from '../session/permission-auto-allow-commands';
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
    setSessionPinned,
} from '../session/session-commands';
import { agentReloadMenuEntry } from '../terminal/terminal-reload-commands';
import { agentResumeCommandMenuEntry } from '../terminal/terminal-surface-commands';

/**
 * Right-click menu for one Session row. Every entry acts on the clicked row (not the selected Session), so the handlers
 * call the id-taking actions directly instead of the selected-Session commands the palette uses. Rename and Archive
 * show their sidebar key hints as literals: they are tree-local keys, not catalog keybindings.
 *
 * Rename is never disabled. A Session title belongs to Caxri, so the Server always commits it and only synchronizes it
 * to the Agent when that provider can accept one; greying the entry out here made the menu disagree with the Project
 * tree row's Enter key, which always opened the input.
 *
 * This menu and the row's own gestures open the same inline rename editor. A list without an editor omits
 * `onBeginRename`, so the menu never offers an action that does nothing.
 */
export function SessionRowMenu({
    children,
    onBeginRename,
    onMarkRead,
    onOpenChange,
    project,
    pullRequest,
    session,
    terminals,
}: {
    children: ReactElement;
    onBeginRename?: () => void;
    /**
     * Clears the row's Unread Attention without opening it. Passed by the Activity queue, where that is the list's own
     * Delete action; the entry renders only while the Session is unread.
     */
    onMarkRead?: () => void;
    onOpenChange?: (isOpen: boolean) => void;
    /**
     * The fields the menu's Project actions act on.
     */
    project: Pick<ProjectRecord, 'id' | 'rootPath'>;
    pullRequest?: SessionPullRequest;
    session: SessionRecord;
    terminals: TerminalRecord[];
}) {
    return (
        <ContextMenuTrigger
            onOpenChange={onOpenChange}
            menu={() =>
                sessionRowMenu({
                    onBeginRename,
                    onMarkRead,
                    project,
                    pullRequest,
                    session,
                    terminals,
                })
            }
        >
            {children}
        </ContextMenuTrigger>
    );
}

const UNBOUND_AGENT_REASON = 'This Session has no bound Agent conversation yet';

/**
 * A native menu cannot be patched once it is showing, so the grant read gates the whole menu. It is bounded: a slow or
 * stalled Server must not turn a right-click into nothing happening.
 */
const AUTO_ALLOW_READ_TIMEOUT_MS = 300;

/**
 * "Always allow in this Session" (issue caxri#1295) is a Server in-memory grant, not part of the bootstrap
 * `SessionRecord`, so it is read only when the menu opens rather than for every row in the tree. A failed or timed-out
 * read hides the entry instead of blocking the menu.
 */
async function isPermissionAutoAllowGranted(sessionId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), AUTO_ALLOW_READ_TIMEOUT_MS);
    });
    try {
        const isGranted = async (): Promise<boolean> =>
            (await fetchCaxriQuery('session.permissionAutoAllowStatus', { sessionId })).granted;
        return await Promise.race([isGranted(), timeout]);
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function sessionRowMenu({
    onBeginRename,
    onMarkRead,
    project,
    pullRequest,
    session,
    terminals,
}: {
    onBeginRename?: () => void;
    onMarkRead?: () => void;
    project: Pick<ProjectRecord, 'id' | 'rootPath'>;
    pullRequest?: SessionPullRequest;
    session: SessionRecord;
    terminals: TerminalRecord[];
}): Promise<ContextMenuEntries> {
    const pinned = isPinnedSession(session);
    const detached = hasDetachedAgentTerminal(session.id, terminals);
    const canDetach = hasLiveAgentTerminal(session.id, terminals);
    const primaryTerminal = terminals.find(
        (terminal) => terminal.id === session.primaryAgentTerminalId,
    );
    /**
     * Both copy entries read the Agent's durable identity, which only exists once the provider has created a
     * conversation: a Session whose Agent has not been bound yet has nothing to put on the clipboard.
     */
    const boundAgentSessionId = primaryTerminal?.agentSessionId;
    const isAutoAllowGranted = await isPermissionAutoAllowGranted(session.id);
    return [
        /**
         * Rename's hint is read from the live keybinding table now that `session.rename` is a real command. Archive
         * keeps a literal on purpose: `Delete` is a tree key, not a keybinding; it archives the row focus is on, which
         * is not necessarily the selected Session, so it cannot become a command binding without changing which Session
         * it would take.
         */
        onMarkRead &&
            session.hasUnread && {
                label: 'Mark as Read',
                shortcut: 'delete',
                onSelect: onMarkRead,
            },
        /**
         * The action runs after the native menu has closed, so the inline rename input mounts into a settled row and
         * keeps its focus.
         */
        onBeginRename && {
            label: 'Rename',
            shortcut: readCommandShortcut('session.rename'),
            onSelect: onBeginRename,
        },
        /**
         * Pin has no key hint: it is neither a tree key nor a catalog command, because it acts on the clicked row
         * rather than the selected Session; the same reason Archive keeps a literal instead of a binding.
         */
        {
            label: pinned ? 'Unpin Session' : 'Pin Session',
            onSelect: () => setSessionPinned(session.id, !pinned),
        },
        /**
         * In the Activity queue Delete marks the row read instead, so the hint moves to that entry.
         */
        {
            label: 'Archive',
            shortcut: onMarkRead ? undefined : 'delete',
            onSelect: () => archiveSession(session.id),
        },
        detached
            ? { label: 'Resume Agent', onSelect: () => resumeSession(session.id) }
            : {
                  label: 'Detach Agent',
                  disabled: !canDetach,
                  disabledReason: 'No running Agent Terminal to detach',
                  onSelect: () => detachSession(session.id),
              },
        /**
         * Reloads the Primary Agent, the same Terminal the copy entries below read, rather than every Agent Terminal
         * the way Detach does: a reload interrupts a running turn, so it must not reach Agents the user did not point
         * at. Each Agent Terminal's own tab menu reloads that one.
         */
        agentReloadMenuEntry(primaryTerminal),
        isAutoAllowGranted && {
            label: 'Turn Off Always Allow in this Session',
            onSelect: () => revokePermissionAutoAllow(session.id),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Open Project in Editor',
            shortcut: readCommandShortcut('project.openInEditor'),
            onSelect: () => openProjectInExternalEditor(project, session.id),
        },
        pullRequest && {
            label: `Open Pull Request #${pullRequest.number}`,
            shortcut: readCommandShortcut('session.openPullRequest'),
            onSelect: () => openSessionPullRequest(pullRequest),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Copy Agent Session ID',
            disabled: !boundAgentSessionId,
            disabledReason: UNBOUND_AGENT_REASON,
            onSelect: () => boundAgentSessionId && copyAgentSessionId(boundAgentSessionId),
        },
        {
            label: 'Copy Transcript Path',
            disabled: !boundAgentSessionId,
            disabledReason: UNBOUND_AGENT_REASON,
            onSelect: () =>
                primaryTerminal &&
                boundAgentSessionId &&
                copyAgentTranscriptPath(primaryTerminal.id),
        },
        agentResumeCommandMenuEntry(primaryTerminal, UNBOUND_AGENT_REASON),
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Delete Session…',
            shortcut: readCommandShortcut('session.delete'),
            onSelect: () => deleteSession(session.id),
        },
    ];
}
