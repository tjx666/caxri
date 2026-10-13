import {
    agentChatPasteAsTextUnavailableReason,
    pasteAgentChatSavedPasteAsText,
} from '../features/agent-chat/agent-chat-long-paste-commands';
import {
    agentChatRedoUnavailableReason,
    redoAgentChatTurn,
} from '../features/agent-chat/agent-chat-undo-commands';
import { openCommanderHandover } from '../features/agent-commander/commander-handover-store';
import {
    discardedChangesUnavailableReason,
    restoreDiscardedChanges,
} from '../features/editor/discarded-buffers';
import {
    retrySaveDocument,
    saveRetryUnavailableReason,
} from '../features/editor/document-commands';
import {
    confirmTurnOffHardwareAcceleration,
    openHardwareAccelerationSettings,
} from '../features/gpu/gpu-commands';
import { openProcessExplorer } from '../features/process-explorer/process-explorer-commands';
import { unarchiveSession } from '../features/session/session-archive-commands';
import { createTerminalForSession } from '../features/terminal/terminal-commands';
import { terminalToastActionHandlers } from '../features/terminal/terminal-toast-actions';
import { showUpdateDialog } from '../features/updates/update-commands';
import { translate } from '../i18n';
import { openExternalUrl } from '../lib/external-link';
import { openSettings } from '../stores/dialogs';
import { getBootstrap } from '../stores/selectors';
import type { ToastActionHandlers } from '../stores/toast-actions';
import { pushToast, tryCommand } from '../stores/toasts';
import { undoFollowedWorkbenchRoot } from '../stores/workbench-root-notice';
import { executeCommand } from './execute';

/**
 * Archived Sessions stay in the bootstrap snapshot with an `archivedAt`, so this answers "does the record still exist",
 * which is exactly what every follow-up below needs, including Undo, whose whole job is to reach an archived one.
 */
function hasSession(sessionId: string): boolean {
    return Boolean(getBootstrap()?.sessions.some((session) => session.id === sessionId));
}

/**
 * What every notification follow-up actually does, and what makes each one stop being possible.
 *
 * These are the same feature entry points the menus and the palette call. They live in the command layer rather than
 * beside the store that records them because the store may not import feature modules, and a second private copy here
 * would be exactly the duplicate path this repository refuses to keep.
 */
export const toastActionHandlers: ToastActionHandlers = {
    'agentChat.redoUndo': {
        unavailable: agentChatRedoUnavailableReason,
        run: (parameters) => {
            // Fire-and-forget: redoAgentChatTurn reports every failure through tryCommand.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void redoAgentChatTurn(parameters);
        },
    },
    'agentChat.pasteAsText': {
        unavailable: agentChatPasteAsTextUnavailableReason,
        run: pasteAgentChatSavedPasteAsText,
    },
    'agentCommander.open': { run: () => executeCommand('agentCommander.open') },
    'agentCommander.handBack': {
        unavailable: ({ sessionId }) =>
            hasSession(sessionId)
                ? undefined
                : translate('toasts.actionUnavailable.missingSession'),
        run: ({ sessionId }) => openCommanderHandover([sessionId]),
    },
    'clipboard.copyCommand': {
        run: ({ text }) => {
            // eslint-disable-next-line no-void -- tryCommand reports clipboard failures through the toast
            void tryCommand(translate('toasts.copyCommandFailed'), () =>
                navigator.clipboard.writeText(text),
            );
        },
    },
    'diagnostics.copyFailure': {
        run: ({ text }) => {
            // eslint-disable-next-line no-void -- tryCommand reports clipboard failures through the toast
            void tryCommand(translate('toasts.copyDetailsFailed'), () =>
                navigator.clipboard.writeText(text),
            );
        },
    },
    'editor.restoreDiscardedChanges': {
        unavailable: discardedChangesUnavailableReason,
        run: restoreDiscardedChanges,
    },
    'editor.retrySave': {
        unavailable: saveRetryUnavailableReason,
        run: retrySaveDocument,
    },
    'github.open': {
        run: ({ url }) => {
            // eslint-disable-next-line no-void -- openExternalUrl reports its own failures through the toast
            void openExternalUrl(url, (message) => pushToast('error', message));
        },
    },
    'processExplorer.open': { run: openProcessExplorer },
    'session.unarchive': {
        // An archived Session can still be deleted outright, and restoring one that is gone would report a low-level
        // failure for something the user already did on purpose.
        unavailable: ({ sessionId }) =>
            hasSession(sessionId)
                ? undefined
                : translate('toasts.actionUnavailable.missingSession'),
        run: ({ sessionId }) => unarchiveSession(sessionId, 'unchanged'),
    },
    'settings.open': { run: () => openSettings() },
    'settings.openHardwareAcceleration': { run: openHardwareAccelerationSettings },
    'settings.turnOffHardwareAcceleration': {
        // Fire-and-forget by the Toast contract: a follow-up is synchronous, and the confirmation plus the shared
        // command funnel own everything that can fail after the click.
        run: () => {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void confirmTurnOffHardwareAcceleration();
        },
    },
    'terminal.create': {
        unavailable: ({ sessionId }) =>
            hasSession(sessionId)
                ? undefined
                : translate('toasts.actionUnavailable.missingSession'),
        run: ({ cwd, kind, paneId, sessionId, split, surface }) => {
            // eslint-disable-next-line no-void -- tryCommand reports retry failures through the toast
            void createTerminalForSession(sessionId, kind, { cwd, paneId, split, surface });
        },
    },
    ...terminalToastActionHandlers,
    'updates.show': { run: showUpdateDialog },
    'workbench.undoFollowedRoot': {
        /**
         * Undo takes back one specific move, so a third root means it no longer applies: returning from somewhere the
         * user chose afterwards would be another switch nobody asked for, and re-rooting a Session re-roots the Files
         * tree, Source Control, Project Status and the editor at once.
         *
         * Both ends of that move count as still applying. The snapshot is only caught up to the followed root once the
         * `state.changed` that accompanies the switch lands, which is after this notice is raised, so in the first
         * moments the Session still reads as the root the undo returns to, and refusing then would kill the live button
         * for the four seconds it is on screen.
         */
        unavailable: ({ followedProjectId, projectId, sessionId }) => {
            const session = getBootstrap()?.sessions.find((entry) => entry.id === sessionId);
            if (!session) return translate('toasts.actionUnavailable.missingSession');
            const current = session.workbenchProjectId;
            return current === followedProjectId || current === projectId
                ? undefined
                : translate('toasts.actionUnavailable.sessionMovedOn');
        },
        run: ({ projectId, sessionId }) => {
            // Fire-and-forget: undoFollowedWorkbenchRoot funnels every failure into its own error toast.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void undoFollowedWorkbenchRoot(sessionId, projectId);
        },
    },
};
