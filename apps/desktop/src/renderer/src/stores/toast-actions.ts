import type { PaneSplitSide, TerminalKind, TerminalSurface } from '@caxri/protocol';

import type { TranslationKey } from '../i18n';
import { translate } from '../i18n';

/**
 * The argument each follow-up needs to run again later, and, through its keys, the closed set of follow-ups a
 * notification may offer.
 *
 * A toast lives four seconds. The notification center keeps the last hundred messages but, by design, no closures, so
 * until now the most actionable thing in the product was also the shortest-lived: once `Retry` or `Open Settings`
 * scrolled away, the route was gone. A notification therefore carries the _name_ of what to do plus plain data, and the
 * center rebuilds the button from that long after the toast expired.
 *
 * Everything here has to stay plain data for that to work, and none of it may be a document body: history is
 * memory-only, but it is still somewhere source content must never land.
 */
export interface ToastActionParameters {
    /**
     * Takes back an Agent Chat turn's Undo. Carries only identity: the replaced file bodies stay in the Undo store.
     */
    'agentChat.redoUndo': { sessionId: string; turnId: string };
    /**
     * Puts a long paste the composer saved as a file back into the draft as text. Carries only identity: the pasted
     * text stays in the composer's own bounded memory (`agent-chat-long-paste-commands.ts`).
     */
    'agentChat.pasteAsText': { pasteId: string };
    /**
     * Puts a turn review comment the user removed back into the Chat's draft. Carries only identity: the comment text
     * stays in the review's own bounded memory (`agent-chat-review-draft.ts`).
     */
    'agentChat.restoreReviewComment': { restoreId: string };
    /**
     * Puts a queued message the user deleted back where it was in the Chat's queue. Carries only identity: the message
     * stays in Server Core's queue memory until the window closes (`agent-chat-commands.ts`).
     */
    'agentChat.restoreQueued': { terminalId: string; id: string };
    /**
     * Raises the Agent Commander window, for a notice about work just handed to it.
     */
    'agentCommander.open': undefined;
    /**
     * Reopens the Hand Over dialog with one Session selected, for the notice that typing into a handed-over Session
     * took it back: the take-back is immediate, and this is its way back.
     */
    'agentCommander.handBack': { sessionId: string };
    /**
     * Takes back an Inbox dismissal that has not been sent yet. Carries only the item id; it stops applying once the
     * request went out, because the Server cannot restore a dismissed item.
     */
    'agentCommander.undoDismiss': { itemId: string };
    /**
     * Copies a shell command the notice asks the user to run elsewhere, such as raising a limit on an SSH Host.
     */
    'clipboard.copyCommand': { text: string };
    'diagnostics.copyFailure': { text: string };
    /**
     * Re-applies unsaved buffers a newer disk state replaced. Carries only the documents' identity: the discarded text
     * stays in the editor feature's own stash, because a follow-up must never hold a document body.
     */
    'editor.restoreDiscardedChanges': {
        sessionId: string;
        workbenchProjectId: string;
        paths: string[];
    };
    'editor.retrySave': {
        sessionId: string;
        /**
         * Undefined while the Session has no Project yet, which still has to compare equal to the Session's current
         * value: a retry is refused because the editor moved, not because both sides were unset.
         */
        workbenchProjectId?: string;
        tabId?: string;
    };
    /**
     * Opens a GitHub page, such as the pull request a merge reported on, through the external-link policy.
     */
    'github.open': { url: string };
    'processExplorer.open': undefined;
    'session.unarchive': { sessionId: string };
    'settings.open': undefined;
    'settings.openHardwareAcceleration': undefined;
    'settings.turnOffHardwareAcceleration': undefined;
    'terminal.create': {
        sessionId: string;
        kind: TerminalKind;
        cwd?: string;
        paneId?: string;
        split?: PaneSplitSide;
        surface?: TerminalSurface;
    };
    'terminal.refresh': undefined;
    /**
     * Stops a Terminal whose process tree is using too many resources. `processId` pins the offer to the PTY the alert
     * measured: once that process is gone the runaway is over, and stopping whatever replaced it would be a new
     * decision.
     */
    'terminal.stopRunaway': { terminalId: string; processId: number };
    'terminal.restart': {
        terminalId: string;
        /**
         * The process this Terminal was running when the restart failed, absent when it was not running at all. Restart
         * replaces a live PTY, so a retry taken long after the fact must first confirm nobody already restarted it:
         * repeating a submitted restart would kill whatever is running now.
         */
        processId?: number;
    };
    'updates.show': undefined;
    'workbench.undoFollowedRoot': {
        sessionId: string;
        /**
         * The root to return to.
         */
        projectId: string;
        /**
         * The root the Agent moved to. Undo means "take back that move", so it stops applying the moment the Session is
         * somewhere else: by then returning would be a third move the user never asked for.
         */
        followedProjectId: string;
    };
}

export type ToastActionId = keyof ToastActionParameters;

/**
 * One follow-up as a notification carries it. `accessibleLabel` is the screen-reader name when the visible one is too
 * short to stand alone: three `Retry` buttons in the history are three different retries. It starts with the visible
 * label word for word (WCAG 2.5.3, Label in Name): a voice-control user says what the button shows, and a name that
 * rewords it leaves that command matching nothing.
 */
export type ToastAction = {
    [Id in ToastActionId]: ToastActionParameters[Id] extends undefined
        ? { id: Id; params?: undefined; accessibleLabel?: string }
        : { id: Id; params: ToastActionParameters[Id]; accessibleLabel?: string };
}[ToastActionId];

/**
 * One label per identity, so the live toast and the history entry cannot disagree about what the button offers. Held as
 * translation keys and resolved where the button renders, so a language change relabels buttons already in history.
 */
export const toastActionLabelKeys: Record<ToastActionId, TranslationKey> = {
    'agentChat.redoUndo': 'toasts.action.redo',
    'agentChat.pasteAsText': 'agentChat.composer.pasteAsText',
    'agentChat.restoreReviewComment': 'toasts.action.undo',
    'agentChat.restoreQueued': 'toasts.action.undo',
    'agentCommander.open': 'toasts.action.openAgentCommander',
    'agentCommander.handBack': 'agentCommander.handover.handBack',
    'agentCommander.undoDismiss': 'toasts.action.undo',
    'clipboard.copyCommand': 'toasts.action.copyCommand',
    'diagnostics.copyFailure': 'toasts.action.copyDetails',
    'editor.restoreDiscardedChanges': 'toasts.action.restoreDiscardedChanges',
    'editor.retrySave': 'common.retry',
    'github.open': 'toasts.action.openOnGitHub',
    'processExplorer.open': 'toasts.action.viewDetails',
    'session.unarchive': 'toasts.action.undo',
    'settings.open': 'toasts.action.openSettings',
    'settings.openHardwareAcceleration': 'toasts.action.openSettings',
    'settings.turnOffHardwareAcceleration': 'toasts.action.turnOffHardwareAcceleration',
    'terminal.create': 'common.retry',
    'terminal.refresh': 'common.refresh',
    'terminal.restart': 'common.retry',
    'terminal.stopRunaway': 'toasts.action.stop',
    'updates.show': 'toasts.action.showUpdate',
    'workbench.undoFollowedRoot': 'toasts.action.undo',
};

export interface ToastActionHandler<Id extends ToastActionId> {
    /**
     * A reader-facing sentence when this follow-up can no longer run (the Session was closed, the editor's Project
     * changed) or undefined when it still can.
     *
     * Asked at click time, never at render time: a button that has been sitting in history for ten minutes must be
     * judged against the state it is clicked in, and a history list does not re-render when that state moves.
     */
    unavailable?: (parameters: ToastActionParameters[Id]) => string | undefined;
    run: (parameters: ToastActionParameters[Id]) => void;
}

export type ToastActionHandlers = { [Id in ToastActionId]: ToastActionHandler<Id> };

/**
 * The answer when this window has no handler for a follow-up: a notification raised before the module graph that owns
 * the handlers has evaluated, or a follow-up that belongs to another window. It fails closed rather than rendering a
 * button that does nothing. It does not claim the follow-up is gone, nothing was checked, only that this window could
 * not perform it.
 */
export function unknownToastActionReason(): string {
    return translate('toasts.actionUnavailable.unknown');
}

const installed: { handlers?: Partial<ToastActionHandlers> } = {};

/**
 * Installs what each follow-up actually does. The Workbench installs every handler; a narrower window installs only the
 * follow-ups its own surfaces raise.
 *
 * The behavior lives outside this store because the store may not import feature modules (the Renderer forbids the
 * import cycle that would create), while the features that raise notifications all import the store.
 */
export function configureToastActions(handlers: Partial<ToastActionHandlers>): void {
    installed.handlers = handlers;
}

/**
 * Runs a follow-up now, or answers with the reason it cannot run. A caller that gets a reason must show it: the one
 * outcome this contract rules out is a button that looks clickable and then silently does nothing.
 */
export function runToastAction(action: ToastAction): string | undefined {
    /**
     * Narrowing one handler against one action would need the union distributed across both at once, which TypeScript
     * cannot express here. The pairing is guaranteed structurally instead: `ToastActionHandlers` is keyed by the same
     * map that types `action.params`, so an id can only ever meet the handler declared for it.
     */
    const handler = installed.handlers?.[action.id] as
        ToastActionHandler<ToastActionId> | undefined;
    if (!handler) return unknownToastActionReason();
    const parameters = action.params;
    const reason = handler.unavailable?.(parameters);
    if (reason) return reason;
    handler.run(parameters);
    return undefined;
}
