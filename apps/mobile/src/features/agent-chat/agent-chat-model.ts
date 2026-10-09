import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
    AgentTimelineItem,
} from '@caxri/protocol';

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
 * Chat-capable provider reads correctly.
 */
export const agentChatProviderName = (
    terminal: Pick<MobileTerminal, 'kind' | 'provider'> | undefined,
): string => {
    switch (terminal?.provider ?? terminal?.kind) {
        case 'claude': {
            return 'Claude';
        }
        case 'grok': {
            return 'Grok';
        }
        case 'codex': {
            return 'Codex';
        }
        default: {
            return 'the Agent';
        }
    }
};

/**
 * The same closed failure copy the Desktop Chat pane shows; provider text never selects the message.
 */
export const agentChatFailureMessage = (
    reason: AgentChatFailureReason,
    provider: string,
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
            return `${provider} stopped unexpectedly. Retry to resume the conversation.`;
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
        case 'userMessage':
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
    request: Extract<AgentChatRequest, { kind: 'command' | 'fileChange' }>,
): Array<{ decision: 'accept' | 'acceptForSession' | 'decline'; label: string }> => {
    const choices = [
        { decision: 'accept', label: 'Accept' },
        { decision: 'acceptForSession', label: 'Accept for this Chat' },
        { decision: 'decline', label: 'Decline' },
    ] as const;
    const allowed = request.decisions;
    return choices.filter((choice) => !allowed || allowed.includes(choice.decision));
};

export const agentChatRequestTitle = (request: AgentChatRequest): string => {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? `Allow network access to ${request.networkHost}?`
                : 'Run this command?';
        }
        case 'fileChange': {
            return 'Apply these file changes?';
        }
        case 'question': {
            return request.questions.length === 1
                ? 'The Agent has a question'
                : `The Agent has ${request.questions.length} questions`;
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
 * Why this device cannot type into the Chat right now, or `undefined` when it can.
 */
export const agentChatComposerDisabledReason = ({
    deviceRole,
    isConnected,
    snapshot,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
    snapshot: AgentChatSnapshot | undefined;
}): string | undefined => {
    if (deviceRole !== 'reply' && deviceRole !== 'control')
        return 'Reply access is required to message this Chat.';
    if (!isConnected) return 'Reconnect to send messages.';
    if (!snapshot) return undefined;
    if (snapshot.status === 'failed') return 'Retry the Chat before sending a message.';
    return undefined;
};
