import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentTimelineItem,
} from '@caxri/protocol';
import { agentChatWaitingText, agentProviderCatalog } from '@caxri/protocol';

import { mobileAgentDisplayName } from '../sessions/agent-display-name';
import type { MobileTerminal } from '../sessions/session-model';

type ToolCall = Extract<AgentTimelineItem, { type: 'toolCall' }>;

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
 * The provider name at the start of a sentence. Catalog names are already capitalized; only the providerless fallback
 * (`the Agent`) needs its first letter raised.
 */
export const sentenceStartProvider = (provider: string): string =>
    provider.charAt(0).toUpperCase() + provider.slice(1);

/**
 * Why a Chat composer's attach button is disabled for a provider that takes no images in a Chat (Grok Build).
 */
export const agentChatImagesUnsupportedReason = (provider: string): string =>
    `${sentenceStartProvider(provider)} can't read images in a Chat.`;

/**
 * The same closed failure copy the Desktop Chat pane shows; provider text never selects the message. `canRetry` is
 * false on a view-only device, which has no Retry button, so the copy names the access it needs instead of asking it to
 * retry.
 */
export const agentChatFailureMessage = (
    reason: AgentChatFailureReason,
    provider: string,
    canRetry = true,
): string => {
    const subject = sentenceStartProvider(provider);
    switch (reason) {
        case 'executable_not_found': {
            return `${subject} is not installed or is not on your computer's PATH. Install it on your computer.`;
        }
        case 'spawn_failed': {
            return `${subject} could not be started on your computer.`;
        }
        case 'handshake_failed': {
            return `${subject} started but did not respond.`;
        }
        case 'process_exited': {
            return canRetry
                ? `${subject} stopped unexpectedly. Retry to resume the conversation.`
                : `${subject} stopped unexpectedly. Reply access is required to retry.`;
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'conversation_in_use': {
            return `This conversation is open in another ${provider} app or window on your computer.`;
        }
        case 'unsupported_version': {
            return `This ${provider} version does not support Chat. Update it on your computer.`;
        }
    }
};

/**
 * Whether Retry can fix a failure from the phone. A missing or outdated provider fails the same way again until someone
 * installs or updates it on the computer, so those failures explain that step instead of offering a Retry.
 */
export const isAgentChatFailureRetryable = (reason: AgentChatFailureReason): boolean =>
    reason !== 'executable_not_found' && reason !== 'unsupported_version';

const toolStatus = (status: AgentChatItemStatus): ToolCall['status'] => {
    switch (status) {
        case 'running': {
            return 'running';
        }
        case 'completed': {
            return 'succeeded';
        }
        case 'failed':
        case 'declined':
        case 'interrupted': {
            return 'failed';
        }
    }
};

/**
 * The first line of a reasoning summary without its Markdown emphasis, as the row's subject. Codex titles each
 * reasoning section with a bold line.
 */
const reasoningTitle = (text: string): string => {
    const firstLine = text
        .split('\n')
        .map((line) => line.replaceAll('**', '').trim())
        .find((line) => line.length > 0);
    return (firstLine ?? '').slice(0, 240);
};

const noticeSummary = (item: Extract<AgentChatItem, { type: 'notice' }>): string => {
    switch (item.kind) {
        case 'compacted': {
            return 'Context compacted';
        }
        case 'retrying': {
            return item.message ? `Retrying: ${item.message}` : 'Retrying';
        }
        case 'error': {
            return item.message ?? 'The Agent reported an error';
        }
        case 'answered': {
            return item.message ? `Answered: ${item.message}` : 'Answered';
        }
    }
};

const toTimelineItem = (item: AgentChatItem): AgentTimelineItem | undefined => {
    switch (item.type) {
        case 'userMessage': {
            // An image-only message keeps its place with empty text; the Chat view draws its images above the bubble.
            return item.text.length > 0 || (item.images?.length ?? 0) > 0
                ? { id: item.id, type: item.type, text: item.text }
                : undefined;
        }
        case 'agentMessage': {
            return item.text.length > 0
                ? { id: item.id, type: item.type, text: item.text }
                : undefined;
        }
        case 'reasoning': {
            if (item.text.trim().length === 0) return undefined;
            return {
                id: item.id,
                type: 'toolCall',
                name: 'reasoning',
                summary: reasoningTitle(item.text) || 'reasoning',
                status: item.streaming ? 'running' : 'succeeded',
                detail: item.text,
            };
        }
        case 'command': {
            return {
                id: item.id,
                type: 'toolCall',
                name: 'exec_command',
                summary: item.command.slice(0, 240) || 'exec_command',
                status: toolStatus(item.status),
                ...(item.durationMs !== undefined && { durationMs: Math.round(item.durationMs) }),
                ...(item.output && { detail: item.output }),
            };
        }
        case 'fileChange': {
            const first = item.changes.at(0);
            const subject = first
                ? item.changes.length === 1
                    ? first.path
                    : `${first.path} and ${item.changes.length - 1} more`
                : '';
            return {
                id: item.id,
                type: 'toolCall',
                name: 'apply_patch',
                summary: subject.slice(0, 240) || 'apply_patch',
                status: toolStatus(item.status),
                ...(item.changes.length > 0 && {
                    detail: item.changes
                        .map((change) => `${change.kind} ${change.path}\n${change.diff}`.trimEnd())
                        .join('\n\n'),
                }),
            };
        }
        case 'toolCall': {
            return {
                id: item.id,
                type: 'toolCall',
                name: item.name || 'tool',
                summary: (item.summary ?? item.name).slice(0, 240) || 'tool',
                status: toolStatus(item.status),
                ...(item.durationMs !== undefined && { durationMs: Math.round(item.durationMs) }),
                ...(item.output && { detail: item.output }),
            };
        }
        case 'notice': {
            return {
                id: item.id,
                type: 'systemEvent',
                kind: 'caveat',
                summary: noticeSummary(item).slice(0, 240),
                ...(item.kind === 'error' && { status: 'failed' as const }),
            };
        }
    }
};

/**
 * Projects a Chat onto the phone's Conversation timeline, so a Chat reuses the same Markdown replies, grouped tool
 * rows, and tap-to-open details as a terminal Agent. Reasoning becomes a collapsed "Thought" row whose detail holds the
 * text, and each finished turn ends with its duration divider.
 */
export const agentChatTimelineItems = (snapshot: AgentChatSnapshot): AgentTimelineItem[] => {
    const turnById = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
    const timeline: AgentTimelineItem[] = [];
    snapshot.items.forEach((item, index) => {
        const projected = toTimelineItem(item);
        if (projected) timeline.push(projected);
        const turn = item.turnId ? turnById.get(item.turnId) : undefined;
        const isLastOfTurn = snapshot.items[index + 1]?.turnId !== item.turnId;
        if (turn && isLastOfTurn && turn.status !== 'running')
            timeline.push({
                id: `turn:${turn.id}`,
                type: 'turnBoundary',
                ...(turn.durationMs !== undefined && { durationMs: Math.round(turn.durationMs) }),
            });
    });
    return timeline;
};

/**
 * What the Chat is doing now, for the line above the composer. A pending request means the turn waits on the user, for
 * an approval or an answer as the shared `agentChatWaitingText` words it on Desktop.
 */
export const agentChatActivityLabel = (
    snapshot: Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'requests'> | undefined,
    provider: string,
): { text: string; isBusy: boolean } | undefined => {
    if (!snapshot || snapshot.status === 'starting')
        return { text: `Starting ${provider}…`, isBusy: true };
    if (!snapshot.activeTurnId) return undefined;
    if (snapshot.requests.length > 0)
        return { text: agentChatWaitingText(snapshot.requests), isBusy: false };
    return { text: 'Working…', isBusy: true };
};

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
 * Builds a question response. A typed answer replaces the chosen option for its question; an unanswered question is
 * omitted, and `isComplete` tells the card whether every question has an answer yet.
 */
export const agentChatQuestionAnswers = (
    request: Extract<AgentChatRequest, { kind: 'question' }>,
    selected: Readonly<Record<string, string | undefined>>,
    other: Readonly<Record<string, string | undefined>>,
): { answers: Record<string, string[]>; isComplete: boolean } => {
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) {
        const typed = other[question.id]?.trim();
        const chosen = selected[question.id];
        if (typed) answers[question.id] = [typed];
        else if (chosen) answers[question.id] = [chosen];
    }
    return {
        answers,
        isComplete: request.questions.every((question) => Object.hasOwn(answers, question.id)),
    };
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
        handedOff: 'Resume the Agent on your computer to send messages.',
        failed: 'Retry the Chat before sending a message.',
    },
    configure: {
        access: 'Reply access is required to change the model.',
        offline: 'Reconnect to change the model.',
        handedOff: 'Resume the Agent on your computer to change the model.',
        failed: 'Retry the Chat before changing the model.',
    },
} as const;

/**
 * Why this device cannot send to, or `configure` the model of, the Chat right now, or `undefined` when it can. Both
 * actions need the same access and connection, so they share one precedence and differ only in what the reason names.
 */
export const agentChatDisabledReason = ({
    action = 'send',
    deviceRole,
    isConnected,
    isHandedOff,
    snapshot,
}: {
    action?: 'send' | 'configure';
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    /**
     * See {@link isAgentChatHandedOff}.
     */
    isHandedOff: boolean;
    snapshot: AgentChatSnapshot | undefined;
}): string | undefined => {
    const reasons = DISABLED_REASONS[action];
    if (deviceRole !== 'reply' && deviceRole !== 'control') return reasons.access;
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
