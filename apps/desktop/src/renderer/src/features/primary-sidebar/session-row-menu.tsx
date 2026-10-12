import type { ReactElement } from 'react';

import type {
    ProjectRecord,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { isPinnedSession } from '@caxri/protocol';

import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { translate } from '../../i18n';
import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { readCommandShortcut } from '../../lib/keybindings';
import { fetchCaxriQuery } from '../../queries/client';
import { getBootstrap } from '../../stores/selectors';
import { revokePermissionAutoAllow } from '../session/permission-auto-allow-commands';
import {
    copyAgentSessionId,
    copyAgentTranscriptPath,
    detachSession,
    hasDetachedAgentTerminal,
    hasLiveAgentTerminal,
    resumeSession,
} from '../session/session-agent-commands';
import { archiveSession } from '../session/session-archive-commands';
import {
    deleteSession,
    openProjectInExternalEditor,
    openSessionPullRequest,
    setSessionPinned,
} from '../session/session-commands';
import { agentRestartMenuEntry } from '../terminal/agent-restart-commands';
import {
    agentResumeCommandMenuEntry,
    isAgentConversationResumable,
    terminalSurfaceMenuEntry,
} from '../terminal/terminal-surface-commands';
import { getActivePaneTab } from '../workbench/pane-actions';
import { canSuggestSessionTitle } from './session-rename-draft';

/**
 * Whether `terminalId` is the active pane's tab in the selected Session, the Terminal every Terminal shortcut acts on.
 */
function isActiveTerminal(terminalId: string | undefined): boolean {
    const resource = getActivePaneTab()?.resource;
    return (
        terminalId !== undefined &&
        resource?.kind === 'terminal' &&
        resource.terminalId === terminalId
    );
}

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
    const missingConversationReason = translate(
        primaryTerminal?.provider
            ? 'primarySidebar.sessionMenu.noConversationReason'
            : 'primarySidebar.sessionMenu.noAgentReason',
    );
    /**
     * `terminal.switchAgentSurface` and `terminal.restart` act on the active Terminal, while these entries act on the
     * clicked row's Primary Agent. Their key hints show only when the two are the same Terminal, so a row other than
     * the selected one never advertises a chord that would act somewhere else.
     */
    const isPrimaryTerminalActive = isActiveTerminal(primaryTerminal?.id);
    const [isAutoAllowGranted, isResumable] = await Promise.all([
        isPermissionAutoAllowGranted(session.id),
        isAgentConversationResumable(primaryTerminal),
    ]);
    /**
     * Five groups: the Session itself (Rename, Rename with AI, Pin, Archive), its Agent, opening it elsewhere, copying
     * its Agent's identity, and Delete. `serializeContextMenu` drops a separator left without neighbors.
     */
    return [
        /**
         * Rename's hint is read from the live keybinding table now that `session.rename` is a real command. Archive
         * keeps a literal on purpose: `Delete` is a tree key, not a keybinding; it archives the row focus is on, which
         * is not necessarily the selected Session, so it cannot become a command binding without changing which Session
         * it would take.
         */
        onMarkRead &&
            session.hasUnread && {
                label: translate('primarySidebar.sessionMenu.markAsRead'),
                shortcut: 'delete',
                onSelect: onMarkRead,
            },
        /**
         * The action runs after the native menu has closed, so the inline rename input mounts into a settled row and
         * keeps its focus.
         */
        onBeginRename && {
            label: translate('common.rename'),
            shortcut: readCommandShortcut('session.rename'),
            onSelect: onBeginRename,
        },
        onSuggestRename &&
            canSuggestSessionTitle(session) && {
                label: translate('primarySidebar.sessionMenu.renameWithAi'),
                shortcut: 'shift+enter',
                onSelect: onSuggestRename,
            },
        /**
         * Pin has no key hint: it is neither a tree key nor a catalog command, because it acts on the clicked row
         * rather than the selected Session; the same reason Archive keeps a literal instead of a binding.
         */
        {
            label: translate(
                pinned ? 'primarySidebar.sessionMenu.unpin' : 'primarySidebar.sessionMenu.pin',
            ),
            onSelect: () => setSessionPinned(session.id, !pinned),
        },
        /**
         * In the Activity queue Delete marks the row read instead, so the hint moves to that entry.
         */
        {
            label: translate('primarySidebar.sessionMenu.archive'),
            shortcut: onMarkRead ? undefined : 'delete',
            onSelect: () => archiveSession(session.id),
        },
        CONTEXT_MENU_SEPARATOR,
        /**
         * The Agent group. The surface switch and Restart Agent act on the Primary Agent, the same Terminal the copy
         * entries below read, rather than every Agent Terminal the way Detach does: both end a running turn (after
         * asking), so they must not reach Agents the user did not point at. Each Agent Terminal's own tab menu acts on
         * that one.
         */
        primaryTerminal && terminalSurfaceMenuEntry(primaryTerminal, isPrimaryTerminalActive),
        agentRestartMenuEntry(primaryTerminal, missingConversationReason, isPrimaryTerminalActive),
        detached
            ? {
                  label: translate('primarySidebar.sessionMenu.resumeAgent'),
                  onSelect: () => resumeSession(session.id),
              }
            : {
                  label: translate('primarySidebar.sessionMenu.detachAgent'),
                  disabled: !canDetach,
                  disabledReason: translate('primarySidebar.sessionMenu.noRunningAgentReason'),
                  onSelect: () => detachSession(session.id),
              },
        isAutoAllowGranted && {
            label: translate('primarySidebar.sessionMenu.turnOffAlwaysAllow'),
            onSelect: () => revokePermissionAutoAllow(session.id),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('primarySidebar.sessionMenu.openProjectInEditor'),
            shortcut: readCommandShortcut('project.openInEditor'),
            onSelect: () => openProjectInExternalEditor(project, session.id),
        },
        pullRequest && {
            label: translate('primarySidebar.sessionMenu.openPullRequest', {
                number: pullRequest.number,
            }),
            shortcut: readCommandShortcut('session.openPullRequest'),
            onSelect: () => openSessionPullRequest(pullRequest),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('primarySidebar.sessionMenu.copyConversationId'),
            disabled: !agentSessionId,
            disabledReason: missingConversationReason,
            onSelect: () => agentSessionId && copyAgentSessionId(agentSessionId),
        },
        {
            label: translate('primarySidebar.sessionMenu.copyTranscriptPath'),
            disabled: !agentSessionId,
            disabledReason: missingConversationReason,
            onSelect: () =>
                primaryTerminal && agentSessionId && copyAgentTranscriptPath(primaryTerminal.id),
        },
        agentResumeCommandMenuEntry(primaryTerminal, isResumable, missingConversationReason),
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('primarySidebar.sessionMenu.deleteSession'),
            shortcut: readCommandShortcut('session.delete'),
            onSelect: () => deleteSession(session.id),
        },
    ];
}
