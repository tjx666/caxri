import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentTimelineItem,
} from '@caxri/protocol';
import { agentProviderCatalog, describeAgentTool } from '@caxri/protocol';

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
 * The same closed failure copy the Desktop Chat pane shows; provider text never selects the message. `canRetry` is
 * false on a view-only device, which has no Retry button, so the copy names the access it needs instead of asking it to
 * retry.
 */
export const agentChatFailureMessage = (
    reason: AgentChatFailureReason,
    provider: string,
    canRetry = true,
): string => {
    switch (reason) {
        case 'executable_not_found': {
            return `${provider} is not installed or is not on your computer's PATH.`;
        }
        case 'spawn_failed': {
            return `${provider} could not be started on your computer.`;
        }
        case 'handshake_failed': {
            return `${provider} started but did not respond.`;
        }
        case 'process_exited': {
            return canRetry
                ? `${provider} stopped unexpectedly. Retry to resume the conversation.`
                : `${provider} stopped unexpectedly. Reply access is required to retry.`;
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'unsupported_version': {
            return `This ${provider} version does not support Chat. Update it on your computer.`;
        }
    }
};

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
 * What the Chat is doing now, for the line above the composer. A pending request means the turn waits on the user.
 */
export const agentChatActivityLabel = (
    snapshot: Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'requests'> | undefined,
    provider: string,
): { text: string; isBusy: boolean } | undefined => {
    if (!snapshot || snapshot.status === 'starting')
        return { text: `Starting ${provider}…`, isBusy: true };
    if (!snapshot.activeTurnId) return undefined;
    if (snapshot.requests.length > 0) return { text: 'Waiting for your answer', isBusy: false };
    return { text: 'Working…', isBusy: true };
};

/**
 * The approval buttons in a fixed order, limited to the decisions the provider offers. `cancel` is never a button:
 * declining already answers the request without stopping the turn.
 */
export const agentChatApprovalChoices = (
    request: Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>,
): Array<{ decision: 'accept' | 'acceptForSession' | 'decline'; label: string }> => {
    const choices = [
        { decision: 'accept', label: 'Accept' },
        { decision: 'acceptForSession', label: 'Accept for this Chat' },
        { decision: 'decline', label: 'Decline' },
    ] as const;
    const allowed = request.decisions;
    return choices.filter((choice) => !allowed || allowed.includes(choice.decision));
};

/**
 * A tool's name as a person reads it: an MCP tool (`mcp__github__create_issue`) reads as `create_issue from github`,
 * and any other tool keeps the name the provider reported.
 */
const approvalToolName = (name: string): string => {
    const presentation = describeAgentTool({ name, summary: name });
    return presentation.kind === 'mcp' && presentation.subject
        ? `${presentation.subject} from ${presentation.label}`
        : name;
};

export const agentChatRequestTitle = (request: AgentChatRequest, provider: string): string => {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? `Allow network access to ${request.networkHost}?`
                : 'Run this command?';
        }
        case 'fileChange': {
            return 'Apply these file changes?';
        }
        case 'tool': {
            /**
             * Claude Code asks to leave plan mode through this tool; its summary is the plan.
             */
            return request.name === 'ExitPlanMode'
                ? 'Start with this plan?'
                : `Allow ${approvalToolName(request.name)}?`;
        }
        case 'question': {
            return request.questions.length === 1
                ? `${provider} has a question`
                : `${provider} has ${request.questions.length} questions`;
        }
    }
};

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
 * The body copy for a Chat with no items. Neither a handed-off Chat (whose history returns only when it resumes) nor a
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
    if (isHandedOff) return 'Messages appear here once the Chat resumes.';
    return canSend
        ? `No messages yet. Send a message to start working with ${provider}.`
        : 'No messages yet.';
};

/**
 * Why this device cannot type into the Chat right now, or `undefined` when it can.
 */
export const agentChatComposerDisabledReason = ({
    deviceRole,
    isConnected,
    isHandedOff,
    snapshot,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    /**
     * See {@link isAgentChatHandedOff}.
     */
    isHandedOff: boolean;
    snapshot: AgentChatSnapshot | undefined;
}): string | undefined => {
    if (deviceRole !== 'reply' && deviceRole !== 'control')
        return 'Reply access is required to message this Chat.';
    if (!isConnected) return 'Reconnect to send messages.';
    if (isHandedOff) return 'Resume the Agent on your computer to send messages.';
    if (!snapshot) return undefined;
    if (snapshot.status === 'failed') return 'Retry the Chat before sending a message.';
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
