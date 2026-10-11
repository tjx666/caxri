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
import { getBootstrap } from '../../stores/selectors';
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
import {
    agentResumeCommandMenuEntry,
    isAgentConversationResumable,
} from '../terminal/terminal-surface-commands';
import { canSuggestSessionTitle } from './session-rename-draft';

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
 * `onBeginRename`, so the menu never offers an action that does nothing. `onSuggestRename` is the row's Rename with AI
 * (its `Shift+Enter`); the entry hides for a Session without a primary Agent, whose conversation the name comes from.
 */
export function SessionRowMenu({
    children,
    onBeginRename,
    onMarkRead,
    onOpenChange,
    onSuggestRename,
    project,
    pullRequest,
    session,
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
     * Opens the row's rename editor and asks for an AI-generated name, as the row's `Shift+Enter` does. Omitted by a
     * list without a rename editor.
     */
    onSuggestRename?: () => void;
    /**
     * The fields the menu's Project actions act on.
     */
    project: Pick<ProjectRecord, 'id' | 'rootPath'>;
    pullRequest?: SessionPullRequest;
    session: SessionRecord;
}) {
    return (
        <ContextMenuTrigger
            onOpenChange={onOpenChange}
            menu={() =>
                sessionRowMenu({
                    onBeginRename,
                    onMarkRead,
                    onSuggestRename,
                    project,
                    pullRequest,
                    session,
                    /**
                     * Read when the menu opens instead of taken as a prop: every row would otherwise receive the whole
                     * Terminal list, so any Terminal change (a surface switch, a title update) re-rendered every
                     * Session row in the tree.
                     */
                    terminals: getBootstrap()?.terminals ?? [],
                })
            }
        >
            {children}
        </ContextMenuTrigger>
    );
}

/**
 * One sentence per reason an Agent entry is unavailable, shared by every entry that needs it: the Session has no Agent
 * at all, or its Agent has not started a conversation yet.
 */
const NO_AGENT_REASON = 'This Session has no Agent';
const NO_CONVERSATION_REASON = 'This Session has no Agent conversation yet';
const NO_RUNNING_AGENT_REASON = 'This Session has no running Agent';

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
    onSuggestRename,
    project,
    pullRequest,
    session,
    terminals,
}: {
    onBeginRename?: () => void;
    onMarkRead?: () => void;
    onSuggestRename?: () => void;
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
     * conversation: a Session whose Agent has not started one yet has nothing to put on the clipboard.
     */
    const agentSessionId = primaryTerminal?.agentSessionId;
    const missingConversationReason = primaryTerminal?.provider
        ? NO_CONVERSATION_REASON
        : NO_AGENT_REASON;
    const [isAutoAllowGranted, isResumable] = await Promise.all([
        isPermissionAutoAllowGranted(session.id),
        isAgentConversationResumable(primaryTerminal),
    ]);
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
        onSuggestRename &&
            canSuggestSessionTitle(session) && {
                label: 'Rename with AI',
                shortcut: 'shift+enter',
                onSelect: onSuggestRename,
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
                  disabledReason: NO_RUNNING_AGENT_REASON,
                  onSelect: () => detachSession(session.id),
              },
        /**
         * Reloads the Primary Agent, the same Terminal the copy entries below read, rather than every Agent Terminal
         * the way Detach does: a reload interrupts a running turn, so it must not reach Agents the user did not point
         * at. Each Agent Terminal's own tab menu reloads that one.
         */
        agentReloadMenuEntry(primaryTerminal, missingConversationReason),
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
            disabled: !agentSessionId,
            disabledReason: missingConversationReason,
            onSelect: () => agentSessionId && copyAgentSessionId(agentSessionId),
        },
        {
            label: 'Copy Transcript Path',
            disabled: !agentSessionId,
            disabledReason: missingConversationReason,
            onSelect: () =>
                primaryTerminal && agentSessionId && copyAgentTranscriptPath(primaryTerminal.id),
        },
        agentResumeCommandMenuEntry(primaryTerminal, isResumable, missingConversationReason),
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Delete Session…',
            shortcut: readCommandShortcut('session.delete'),
            onSelect: () => deleteSession(session.id),
        },
    ];
}
