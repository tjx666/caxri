import { configureToastActions } from '../../stores/toast-actions';
import { restoreAgentChatQueued } from '../agent-chat/agent-chat-commands';
import {
    agentChatPasteAsTextUnavailableReason,
    pasteAgentChatSavedPasteAsText,
} from '../agent-chat/agent-chat-long-paste-commands';
import { terminalToastActionHandlers } from '../terminal/terminal-toast-actions';
import { openWorkbenchSettings } from './commander-commands';
import {
    commanderInboxUndoDismissUnavailableReason,
    undoCommanderInboxDismissal,
} from './commander-inbox-commands';

/**
 * Installs the follow-ups a notification in this window can run. The window shows only the Commander Terminal, so it
 * raises its pane's Retry and Refresh, its Chat composer's Paste as Text, and the Open Settings of the notice that pins
 * it to software rendering, which the Workbench opens because this window has no Settings. The Workbench's other
 * follow-ups open surfaces this window does not have, and they keep the fail-closed answer instead of a button that
 * does nothing.
 */
export function configureCommanderToastActions(): void {
    configureToastActions({
        ...terminalToastActionHandlers,
        'agentChat.pasteAsText': {
            unavailable: agentChatPasteAsTextUnavailableReason,
            run: pasteAgentChatSavedPasteAsText,
        },
        'agentChat.restoreQueued': { run: restoreAgentChatQueued },
        'agentCommander.undoDismiss': {
            unavailable: ({ itemId }) => commanderInboxUndoDismissUnavailableReason(itemId),
            run: ({ itemId }) => undoCommanderInboxDismissal(itemId),
        },
        'settings.openHardwareAcceleration': { run: openWorkbenchSettings },
    });
}
