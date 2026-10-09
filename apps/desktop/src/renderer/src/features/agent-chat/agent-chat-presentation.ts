import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';

import { projectRelativePath } from '../../lib/file-path';
import { agentChatFilesChangedLabel } from './agent-chat-diff';

/**
 * User-facing copy for each closed failure reason. Provider text never selects the message; `detail` is shown beside it
 * only as supporting context.
 */
export function agentChatFailureMessage(reason: AgentChatFailureReason): string {
    switch (reason) {
        case 'executable_not_found': {
            return 'Codex is not installed or is not on your PATH. Install it, then retry.';
        }
        case 'spawn_failed': {
            return 'Codex could not be started. Retry, or check that the Codex CLI runs in a terminal.';
        }
        case 'handshake_failed': {
            return 'Codex started but did not respond. Retry, or update the Codex CLI.';
        }
        case 'process_exited': {
            return 'Codex stopped unexpectedly. Retry to resume the conversation.';
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'unsupported_version': {
            return 'This Codex version does not support Chat. Update the Codex CLI.';
        }
    }
}

/**
 * Whether the composer accepts a message. A stopped Chat resumes its Agent Session on the next message, a starting one
 * queues the message on Server Core until the provider is ready (opening a Chat and typing at once must not drop the
 * first Enter), and a running turn accepts a message as steering. Only a failed provider, or a Chat not loaded yet,
 * refuses input.
 */
export function canSendAgentChatMessage(snapshot: AgentChatSnapshot | undefined): boolean {
    return snapshot !== undefined && snapshot.status !== 'failed';
}

/**
 * The composer's footer: the model the provider reported and how much of its context window remains, the two facts the
 * Codex TUI keeps visible. Omitted until the provider reports them.
 */
export function agentChatContextSummary(
    snapshot: Pick<AgentChatSnapshot, 'model' | 'usage'> | undefined,
): string | undefined {
    const parts: string[] = [];
    if (snapshot?.model) parts.push(snapshot.model);
    const usage = snapshot?.usage;
    if (usage?.contextWindow) {
        const used = Math.min(usage.totalTokens / usage.contextWindow, 1);
        parts.push(`${Math.round((1 - used) * 100)}% context left`);
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * What the Chat is doing right now, for the activity line. A pending request means the turn is blocked on the user, not
 * working, so it says so instead of spinning.
 */
export function agentChatActivityLabel(
    snapshot: Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'requests'> | undefined,
): { text: string; isBusy: boolean } | undefined {
    if (!snapshot || snapshot.status === 'starting')
        return { text: 'Starting Codex…', isBusy: true };
    if (!snapshot.activeTurnId) return undefined;
    if (snapshot.requests.length > 0) return { text: 'Waiting for your answer', isBusy: false };
    return { text: 'Working…', isBusy: true };
}

export function isAgentChatTurnRunning(snapshot: AgentChatSnapshot | undefined): boolean {
    return Boolean(snapshot?.activeTurnId);
}

/**
 * Enter sends and Shift+Enter inserts a newline, matching the mobile Conversation composer. An IME composition owns
 * Enter until it commits, otherwise confirming a candidate would send a half-typed message.
 */
export function isAgentChatSubmitKey(event: {
    key: string;
    shiftKey: boolean;
    isComposing: boolean;
}): boolean {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

/**
 * Escape interrupts a running turn, as it does in the Codex TUI; the draft is kept for the next message. An IME
 * composition owns Escape (it dismisses the candidate list), and a held key must not fire a stream of interrupts.
 */
export function isAgentChatInterruptKey(event: {
    key: string;
    isComposing: boolean;
    repeat: boolean;
}): boolean {
    return event.key === 'Escape' && !event.isComposing && !event.repeat;
}

export type AgentChatStatusTone = 'danger' | 'muted' | 'running' | 'success' | 'warning';

export function agentChatItemStatusTone(status: AgentChatItemStatus): AgentChatStatusTone {
    switch (status) {
        case 'running': {
            return 'running';
        }
        case 'completed': {
            return 'success';
        }
        case 'failed': {
            return 'danger';
        }
        case 'declined':
        case 'interrupted': {
            return 'warning';
        }
    }
}

export function agentChatItemStatusLabel(status: AgentChatItemStatus): string {
    switch (status) {
        case 'running': {
            return 'Running';
        }
        case 'completed': {
            return 'Completed';
        }
        case 'failed': {
            return 'Failed';
        }
        case 'declined': {
            return 'Declined';
        }
        case 'interrupted': {
            return 'Interrupted';
        }
    }
}

/**
 * One-line heading of a collapsible activity row.
 */
export function agentChatActivityTitle(
    item: Extract<AgentChatItem, { type: 'command' | 'fileChange' | 'toolCall' }>,
): string {
    switch (item.type) {
        case 'command': {
            return item.command;
        }
        case 'fileChange': {
            return agentChatFilesChangedLabel(item.changes.length);
        }
        case 'toolCall': {
            return item.summary ? `${item.name}: ${item.summary}` : item.name;
        }
    }
}

export function agentChatNoticeMessage(item: Extract<AgentChatItem, { type: 'notice' }>): string {
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
}

/**
 * Where an approval's command runs, as the user thinks of it: hidden at the Project root (the usual case, and the one
 * the user already assumes), Project-relative below it, and absolute only when the Agent leaves the Project.
 */
export function agentChatCommandCwd(
    cwd: string | undefined,
    projectRoot: string | undefined,
): string | undefined {
    if (!cwd) return undefined;
    if (projectRoot === undefined) return cwd;
    const relative = projectRelativePath(cwd, projectRoot);
    if (relative === '.') return undefined;
    return relative ?? cwd;
}

/**
 * The approval buttons to show, in a fixed order. The provider may restrict them; `cancel` is never a button here
 * because declining already answers the request without stopping the turn.
 */
export function agentChatApprovalChoices(
    request: Extract<AgentChatRequest, { kind: 'command' | 'fileChange' }>,
): Array<{ decision: 'accept' | 'acceptForSession' | 'decline'; label: string }> {
    const choices = [
        { decision: 'accept', label: 'Accept' },
        { decision: 'acceptForSession', label: 'Accept for this Chat' },
        { decision: 'decline', label: 'Decline' },
    ] as const;
    const allowed = request.decisions;
    return choices.filter((choice) => !allowed || allowed.includes(choice.decision));
}

export function agentChatRequestTitle(request: AgentChatRequest): string {
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
}

/**
 * Builds the `answers` response for a question request. A typed "Other" answer replaces the chosen option for that
 * question; a question left unanswered is omitted, and the provider decides how to treat it.
 */
export function agentChatQuestionAnswers(
    selected: Readonly<Record<string, string | undefined>>,
    other: Readonly<Record<string, string | undefined>>,
): Record<string, string[]> {
    const answers: Record<string, string[]> = {};
    const questionIds = new Set([...Object.keys(selected), ...Object.keys(other)]);
    for (const id of questionIds) {
        const typed = other[id]?.trim();
        const chosen = selected[id];
        if (typed) answers[id] = [typed];
        else if (chosen) answers[id] = [chosen];
    }
    return answers;
}

/**
 * Content keys for a list whose entries have no id (plan steps), numbered per repeated value so two identical steps
 * still get distinct keys while an edit to one step never remounts the others.
 */
export function withOccurrenceKeys<T>(
    items: readonly T[],
    content: (item: T) => string,
): Array<{ item: T; key: string }> {
    const seen = new Map<string, number>();
    return items.map((item) => {
        const value = content(item);
        const occurrence = seen.get(value) ?? 0;
        seen.set(value, occurrence + 1);
        return { item, key: `${value}\0${occurrence}` };
    });
}
