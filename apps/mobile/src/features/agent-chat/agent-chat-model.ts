import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentProvider,
} from '@caxri/protocol';
import { agentProviderCatalog, sentenceStartProvider } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
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
    t: Translate = translate,
): string => {
    const provider = terminal?.provider ?? terminal?.kind;
    return provider && provider !== 'shell'
        ? mobileAgentDisplayName(provider)
        : t('chat.providerFallback');
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
export const agentChatImagesUnsupportedReason = (
    provider: string,
    t: Translate = translate,
): string => t('chat.imagesUnsupported', { provider: sentenceStartProvider(provider) });

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
export const agentChatHandedOffNotice = (t: Translate = translate): string =>
    t('chat.handedOffNotice');

/**
 * The handed-off banner: the notice plus the way back, said once here so the body and composer need not repeat it.
 */
export const agentChatHandedOffBanner = (t: Translate = translate): string =>
    t('chat.handedOffBanner', { notice: agentChatHandedOffNotice(t) });

/**
 * Whether the Chat shows its "could not be updated" notice: only after a read actually failed. A Chat the phone stops
 * observing (a screen such as the in-app browser covers it, or another tab shows) also reads as `stale` and keeps its
 * last copy, but nothing failed, and the notice would flash on it while the covering screen slides in. While the phone
 * is disconnected the app-wide connection banner explains the stale copy instead.
 */
export const shouldShowAgentChatStaleNotice = (
    chat: { error: string | null; status: string },
    isConnected: boolean,
): boolean => isConnected && chat.status === 'stale' && chat.error !== null;

/**
 * The body copy for a Chat with no items. Neither a handed-off Chat (whose banner already says how to continue) nor a
 * device that cannot message the Chat is invited to send one.
 */
export const agentChatEmptyMessage = (
    {
        canSend,
        isHandedOff,
        provider,
    }: {
        canSend: boolean;
        isHandedOff: boolean;
        provider: string;
    },
    t: Translate = translate,
): string => {
    if (isHandedOff) return t('chat.emptyHandedOff');
    return canSend ? t('chat.emptyReady', { provider }) : t('chat.empty');
};

type DisabledReasonKind = 'access' | 'offline' | 'handedOff' | 'failed';

const DISABLED_REASONS = {
    send: {
        access: 'chat.disabled.send.access',
        offline: 'chat.disabled.send.offline',
        handedOff: 'chat.disabled.send.handedOff',
        failed: 'chat.disabled.send.failed',
    },
    configure: {
        access: 'chat.disabled.configure.access',
        offline: 'chat.disabled.configure.offline',
        handedOff: 'chat.disabled.configure.handedOff',
        failed: 'chat.disabled.configure.failed',
    },
    permission: {
        access: 'chat.disabled.permission.access',
        offline: 'chat.disabled.permission.offline',
        handedOff: 'chat.disabled.permission.handedOff',
        failed: 'chat.disabled.permission.failed',
    },
} as const satisfies Record<string, Record<DisabledReasonKind, TranslationKey>>;

interface DisabledReasonInput {
    action?: 'send' | 'configure' | 'permission';
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    /**
     * See {@link isAgentChatHandedOff}.
     */
    isHandedOff: boolean;
    snapshot: AgentChatSnapshot | undefined;
}

const agentChatDisabledReasonKind = ({
    action = 'send',
    deviceRole,
    isConnected,
    isHandedOff,
    snapshot,
}: DisabledReasonInput): DisabledReasonKind | undefined => {
    const hasAccess =
        deviceRole === 'control' || (deviceRole === 'reply' && action !== 'permission');
    if (!hasAccess) return 'access';
    if (!isConnected) return 'offline';
    if (isHandedOff) return 'handedOff';
    if (snapshot?.status === 'failed') return 'failed';
    return undefined;
};

/**
 * Why this device cannot send to the Chat, `configure` its model, or change its `permission` level right now, or
 * `undefined` when it can. The actions share one precedence and differ in what the reason names, and the permission
 * level needs `control` access, as answering approvals does, where the others need `reply`.
 */
export const agentChatDisabledReason = (
    input: DisabledReasonInput,
    t: Translate = translate,
): string | undefined => {
    const kind = agentChatDisabledReasonKind(input);
    if (kind !== undefined) return t(DISABLED_REASONS[input.action ?? 'send'][kind]);
    // The weekly usage guard refuses model requests only; the model and permission level stay changeable.
    if ((input.action ?? 'send') === 'send' && input.snapshot?.usageGuard)
        return t('chat.disabled.send.usageGuard');
    return undefined;
};

/**
 * The usage guard's banner (issue #2580): how much of the week the provider's account used, when it resets, and where
 * the way forward is. Generating a hand-off and continuing in another Agent stay on the computer, which can open the
 * new Session beside this one.
 */
export const agentChatUsageGuardBanner = (
    guard: Pick<NonNullable<AgentChatSnapshot['usageGuard']>, 'resetsAt' | 'usedPercent'>,
    providerName: string,
    now: number,
    t: Translate = translate,
): string => {
    const minutes = Math.max(1, Math.ceil((guard.resetsAt - now) / 60_000));
    const hours = Math.floor(minutes / 60);
    const reset =
        hours >= 24
            ? t('chat.usageGuard.resetDays', { days: Math.floor(hours / 24), hours: hours % 24 })
            : t('chat.usageGuard.resetHours', { hours, minutes: minutes % 60 });
    return t('chat.usageGuard.banner', {
        provider: providerName,
        percent: Math.floor(guard.usedPercent),
        reset,
    });
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
    input: Omit<DisabledReasonInput, 'action'>,
    t: Translate = translate,
): { isEnabled: boolean; reason?: string } => {
    const kind = agentChatDisabledReasonKind(input);
    // The usage guard's banner says why and when it lifts, like the handed-off and failed banners.
    if (kind === undefined) return { isEnabled: input.snapshot?.usageGuard === undefined };
    const isBannerOwned = kind === 'handedOff' || kind === 'failed';
    return isBannerOwned
        ? { isEnabled: false }
        : { isEnabled: false, reason: t(DISABLED_REASONS.send[kind]) };
};

/**
 * What a device without control access sees on a pending request it cannot answer, Chat or Terminal alike, with the way
 * to get that access.
 */
export const requestControlAccessMessage = (t: Translate = translate): string =>
    t('chat.requestControlAccess');

/**
 * Why this device cannot answer a pending request, or `undefined` when it can. Answering needs control access and a
 * live connection, mirroring the composer's "Reconnect to send messages.".
 */
export const agentChatRequestBlockedReason = (
    {
        deviceRole,
        isConnected,
    }: {
        deviceRole: 'view' | 'reply' | 'control' | null;
        isConnected: boolean;
    },
    t: Translate = translate,
): { kind: 'access' | 'offline'; message: string } | undefined => {
    if (deviceRole !== 'control')
        return { kind: 'access', message: requestControlAccessMessage(t) };
    if (!isConnected) return { kind: 'offline', message: t('chat.requestOffline') };
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
 * Whether the composer's button can act now, and whether a tap steers the running turn. A pending Stop refuses further
 * presses until its turn ends; steering needs a running turn and a draft, since Stop owns the button on an empty one.
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
export const agentChatComposerButton = (
    {
        isRunning,
        isStopAction,
        isStopping,
        provider,
    }: {
        isRunning: boolean;
        isStopAction: boolean;
        isStopping: boolean;
        provider: string;
    },
    t: Translate = translate,
): {
    kind: 'send' | 'stop';
    label: string;
    testID: 'agent-chat-composer-send' | 'agent-chat-composer-stop';
} => {
    if (isStopAction || isStopping)
        return {
            kind: 'stop',
            label: t(isStopping ? 'chat.composer.stoppingProvider' : 'chat.composer.stopProvider', {
                provider,
            }),
            testID: 'agent-chat-composer-stop',
        };
    return {
        kind: 'send',
        label: t(isRunning ? 'chat.composer.steerMessage' : 'chat.composer.sendMessage'),
        testID: 'agent-chat-composer-send',
    };
};

/**
 * What a tap and a hold on the composer's button deliver. While a turn runs and there is a draft, a tap steers it, as
 * Desktop's Enter does (#2611), and a hold queues the message for the turn's end, the phone's stand-in for Desktop's
 * Cmd+Enter. Otherwise a tap sends normally (the Server still queues it while the Chat is busy compacting or draining
 * its queue) and a hold does nothing. A slash command never reaches this choice: the composer runs it instead of
 * sending it.
 */
export const agentChatComposerPressDeliveries = ({
    canSteer,
}: {
    canSteer: boolean;
}): { hold: 'queue' | undefined; tap: 'send' | 'steer' } =>
    canSteer ? { hold: 'queue', tap: 'steer' } : { hold: undefined, tap: 'send' };

/**
 * The composer's line after a send failed. Only a write the Server explicitly refused, or one that never left the
 * phone, is "not sent"; any other failure may have reached the Agent, so the reader checks the Chat before repeating a
 * message the Agent may already be working on. Same contract as the Terminal composer's `unknown` delivery.
 */
export const agentChatSendFailureMessage = (
    failure: MobileWriteFailure,
    t: Translate = translate,
): string => {
    switch (failure.kind) {
        case 'rejected':
            return t(
                failure.code === 'FORBIDDEN'
                    ? 'chat.sendFailure.forbidden'
                    : 'chat.sendFailure.rejected',
            );
        case 'offline':
            return t('chat.sendFailure.offline');
        case 'unknown':
            return t('chat.sendFailure.unknown');
    }
};

/**
 * Which optional controls share the composer row with the input. While a turn runs and the user has typed, the row
 * already holds Queue and Steer, so the attach button steps aside to keep the input at least about 60% of the row on a
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
