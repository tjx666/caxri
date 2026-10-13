import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentProvider,
} from '@caxri/protocol';
import { agentProviderCatalog, sentenceStartProvider } from '@caxri/protocol';

import type { MobileWriteFailure } from '../connection/mobile-write-failure';
import { mobileAgentDisplayName } from '../sessions/agent-display-name';
import type { MobileTerminal } from '../sessions/session-model';

/**
 * Whether the Session's primary Terminal is a Chat. A Chat has no PTY to attach, so the phone shows its conversation
 * projection instead of a Terminal.
 */
export const isAgentChatTerminal = (
    terminal: Pick<MobileTerminal, 'surface'> | undefined,
): boolean => terminal?.surface === 'chat';

/**
 * The provider's display name for Chat copy. Taken from the Terminal, never written into a message, so a second
 * Chat-capable provider reads correctly. The name is the protocol catalog's `displayName`, the one Desktop's Chat pane
 * shows; only the providerless fallback is local copy.
 */
export const agentChatProviderName = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): string => {
    const provider = terminal?.provider ?? terminal?.kind;
    return provider && provider !== 'shell' ? mobileAgentDisplayName(provider) : 'the Agent';
};

/**
 * The Chat's provider id, which decides the permission levels and plan mode it offers, or `undefined` for a Terminal
 * that names none.
 */
export const agentChatProviderId = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): AgentProvider | undefined => {
    const provider = terminal?.provider ?? terminal?.kind;
    return provider && provider !== 'shell' ? provider : undefined;
};

/**
 * Whether the Chat's provider takes images in a message, read from the shared catalog like Desktop's composer.
 */
export const canAttachAgentChatImages = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): boolean => {
    const provider = terminal?.provider ?? terminal?.kind;
    return provider !== undefined && provider !== 'shell'
        ? agentProviderCatalog[provider].capabilities.chatImages
        : false;
};

/**
 * Why a Chat composer's attach button is disabled for a provider that takes no images in a Chat (Grok Build).
 */
export const agentChatImagesUnsupportedReason = (provider: string): string =>
    `${sentenceStartProvider(provider)} Chat does not accept images`;

/**
 * Whether Retry can fix a failure from the phone. A missing or outdated provider fails the same way again until someone
 * installs or updates it on the computer, so those failures explain that step instead of offering a Retry.
 */
export const isAgentChatFailureRetryable = (reason: AgentChatFailureReason): boolean =>
    reason !== 'executable_not_found' && reason !== 'unsupported_version';

/**
 * The approval buttons laid out in rows: the one-time answers (Accept, Decline) side by side, then the standing "for
 * this Chat" answer on its own row, as the Desktop request card groups them. Empty rows are dropped.
 */
export const agentChatApprovalRows = <Choice extends { decision: string }>(
    choices: readonly Choice[],
): Choice[][] =>
    [
        choices.filter((choice) => choice.decision !== 'acceptForSession'),
        choices.filter((choice) => choice.decision === 'acceptForSession'),
    ].filter((row) => row.length > 0);

/**
 * The files a file-change approval would touch, read from the timeline item it gates.
 */
export const agentChatApprovalFiles = (
    request: AgentChatRequest,
    items: readonly AgentChatItem[],
): string[] => {
    if (request.kind !== 'fileChange' || !request.itemId) return [];
    const item = items.find((candidate) => candidate.id === request.itemId);
    return item?.type === 'fileChange' ? item.changes.map((change) => change.path) : [];
};

/**
 * Whether the Chat was handed to another client with `session.detach`. The Chat snapshot cannot say so: a detached Chat
 * reads `stopped`, like one that merely idled, but the Server refuses its input with `UNAVAILABLE` until
 * `session.resume` clears the `detached` marker on the Terminal record, which the dashboard projects.
 */
export const isAgentChatHandedOff = (
    terminal: Pick<MobileTerminal, 'lastProcessState'> | undefined,
): boolean => terminal?.lastProcessState === 'detached';

/**
 * The phone's notice for a handed-off Chat. It mirrors the detached PTY chip ("Terminal was handed off on your
 * computer", `terminal-exit-presentation.ts`) with the surface the phone's tab names. The phone has no Resume action
 * for either: the Session resumes on the computer.
 */
export const AGENT_CHAT_HANDED_OFF_NOTICE = 'Chat was handed off on your computer';

/**
 * The handed-off banner: the notice plus the way back, said once here so the body and composer need not repeat it.
 */
export const AGENT_CHAT_HANDED_OFF_BANNER = `${AGENT_CHAT_HANDED_OFF_NOTICE}. Resume it there to continue.`;

/**
 * The body copy for a Chat with no items. Neither a handed-off Chat (whose banner already says how to continue) nor a
 * device that cannot message the Chat is invited to send one.
 */
export const agentChatEmptyMessage = ({
    canSend,
    isHandedOff,
    provider,
}: {
    canSend: boolean;
    isHandedOff: boolean;
    provider: string;
}): string => {
    if (isHandedOff) return 'No messages to show.';
    return canSend
        ? `No messages yet. Send a message to start working with ${provider}.`
        : 'No messages yet.';
};

const DISABLED_REASONS = {
    send: {
        access: 'Reply access is required to message this Chat.',
        offline: 'Reconnect to send messages.',
        handedOff: 'Resume the Chat on your computer to send messages.',
        failed: 'Retry the Chat before sending a message.',
    },
    configure: {
        access: 'Reply access is required to change the model.',
        offline: 'Reconnect to change the model.',
        handedOff: 'Resume the Chat on your computer to change the model.',
        failed: 'Retry the Chat before changing the model.',
    },
    permission: {
        access: 'Control access is required to change permissions.',
        offline: 'Reconnect to change permissions.',
        handedOff: 'Resume the Chat on your computer to change permissions.',
        failed: 'Retry the Chat before changing permissions.',
    },
} as const;

/**
 * Why this device cannot send to the Chat, `configure` its model, or change its `permission` level right now, or
 * `undefined` when it can. The actions share one precedence and differ in what the reason names, and the permission
 * level needs `control` access, as answering approvals does, where the others need `reply`.
 */
export const agentChatDisabledReason = ({
    action = 'send',
    deviceRole,
    isConnected,
    isHandedOff,
    snapshot,
}: {
    action?: 'send' | 'configure' | 'permission';
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    /**
     * See {@link isAgentChatHandedOff}.
     */
    isHandedOff: boolean;
    snapshot: AgentChatSnapshot | undefined;
}): string | undefined => {
    const reasons = DISABLED_REASONS[action];
    const hasAccess =
        deviceRole === 'control' || (deviceRole === 'reply' && action !== 'permission');
    if (!hasAccess) return reasons.access;
    if (!isConnected) return reasons.offline;
    if (isHandedOff) return reasons.handedOff;
    if (snapshot?.status === 'failed') return reasons.failed;
    return undefined;
};

/**
 * The messages that carry images and how many each has, as a stable string so a view can memoize on it while replies
 * stream. Empty when no message has images.
 */
export const agentChatImageCounts = (
    snapshot: Pick<AgentChatSnapshot, 'items'> | undefined,
): string => {
    const counts = (snapshot?.items ?? []).flatMap((item) =>
        item.type === 'userMessage' && item.images?.length ? [[item.id, item.images.length]] : [],
    );
    return counts.length > 0 ? JSON.stringify(counts) : '';
};

/**
 * Whether this device can type into the Chat right now, and the reason to show when it cannot. A handed-off or failed
 * Chat disables the composer without a reason: its banner above already names the state and the way out, and saying it
 * twice is noise. Access and connection keep {@link agentChatDisabledReason}'s precedence.
 */
export const agentChatComposerAvailability = (
    input: Omit<Parameters<typeof agentChatDisabledReason>[0], 'action'>,
): { isEnabled: boolean; reason?: string } => {
    const reason = agentChatDisabledReason(input);
    if (reason === undefined) return { isEnabled: true };
    const isBannerOwned =
        reason === DISABLED_REASONS.send.handedOff || reason === DISABLED_REASONS.send.failed;
    return isBannerOwned ? { isEnabled: false } : { isEnabled: false, reason };
};

/**
 * What a device without control access sees on a pending request it cannot answer, Chat or Terminal alike, with the way
 * to get that access.
 */
export const REQUEST_CONTROL_ACCESS_MESSAGE =
    'This device cannot answer requests. Pair it again on your computer with control access.';

/**
 * Why this device cannot answer a pending request, or `undefined` when it can. Answering needs control access and a
 * live connection, mirroring the composer's "Reconnect to send messages.".
 */
export const agentChatRequestBlockedReason = ({
    deviceRole,
    isConnected,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
}): { kind: 'access' | 'offline'; message: string } | undefined => {
    if (deviceRole !== 'control')
        return { kind: 'access', message: REQUEST_CONTROL_ACCESS_MESSAGE };
    if (!isConnected) return { kind: 'offline', message: 'Reconnect to answer.' };
    return undefined;
};

/**
 * Whether Stop was pressed for the turn still running. Keyed by turn id, as on Desktop, so the pending state ends by
 * itself when that turn ends or another one starts, without a timer.
 */
export const isAgentChatStopping = (
    stoppingTurnId: string | undefined,
    activeTurnId: string | undefined,
): boolean => activeTurnId !== undefined && stoppingTurnId === activeTurnId;

/**
 * Whether the composer's one button can act now, and whether holding it steers. A pending Stop refuses further presses
 * until its turn ends; steering needs a running turn and a draft, since Stop owns the button on an empty one.
 */
export const agentChatComposerSubmission = ({
    hasDraft,
    isEditable,
    isRunning,
    isStopAction,
    isStopping,
}: {
    hasDraft: boolean;
    isEditable: boolean;
    isRunning: boolean;
    isStopAction: boolean;
    isStopping: boolean;
}): { canSteer: boolean; canSubmit: boolean } => {
    const canSubmit = isEditable && !isStopping && (isStopAction || hasDraft);
    return { canSteer: canSubmit && isRunning && !isStopAction, canSubmit };
};

/**
 * What the composer's button says and does. A pending Stop keeps its button even if the user starts typing, so the
 * state does not flicker back to Send while the turn is still ending.
 */
export const agentChatComposerButton = ({
    isRunning,
    isStopAction,
    isStopping,
    provider,
}: {
    isRunning: boolean;
    isStopAction: boolean;
    isStopping: boolean;
    provider: string;
}): {
    kind: 'send' | 'stop';
    label: string;
    testID: 'agent-chat-composer-send' | 'agent-chat-composer-stop';
} => {
    if (isStopAction || isStopping)
        return {
            kind: 'stop',
            label: isStopping ? `Stopping ${provider}` : `Stop ${provider}`,
            testID: 'agent-chat-composer-stop',
        };
    return {
        kind: 'send',
        label: isRunning ? 'Queue message' : 'Send message',
        testID: 'agent-chat-composer-send',
    };
};

/**
 * The composer's line after a send failed. Only a write the Server explicitly refused, or one that never left the
 * phone, is "not sent"; any other failure may have reached the Agent, so the reader checks the Chat before repeating a
 * message the Agent may already be working on. Same contract as the Terminal composer's `unknown` delivery.
 */
export const agentChatSendFailureMessage = (failure: MobileWriteFailure): string => {
    switch (failure.kind) {
        case 'rejected':
            return failure.code === 'FORBIDDEN'
                ? 'This device no longer has access to this Chat. Your message was not sent.'
                : 'Your message was not sent. Try again.';
        case 'offline':
            return 'Your message was not sent. Reconnect to Caxri and try again.';
        case 'unknown':
            return "Couldn't confirm delivery. Check the Chat before sending again.";
    }
};

/**
 * Which optional controls share the composer row with the input. While a turn runs and the user has typed, the row
 * already holds Steer and Queue, so the attach button steps aside to keep the input at least about 60% of the row on a
 * phone; it comes back once the draft is empty, so attaching stays one tap away before typing. Images already attached
 * stay in the strip above, and their own remove buttons still work.
 */
export const agentChatComposerRowControls = ({
    canAttach,
    hasText,
    isRunning,
}: {
    /**
     * Whether this device may attach images at all (reply or control access).
     */
    canAttach: boolean;
    hasText: boolean;
    isRunning: boolean;
}): { showsAttach: boolean } => ({ showsAttach: canAttach && !(isRunning && hasText) });
