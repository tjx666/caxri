import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';

import { projectRelativePath } from '../../lib/file-path';

/**
 * User-facing copy for each closed failure reason. Provider text never selects the message; `detail` is shown beside it
 * only as supporting context. `providerName` is the provider catalog's display name.
 */
export function agentChatFailureMessage(
    reason: AgentChatFailureReason,
    providerName: string,
): string {
    switch (reason) {
        case 'executable_not_found': {
            return `${providerName} is not installed or is not on your PATH. Install it, then retry.`;
        }
        case 'spawn_failed': {
            return `${providerName} could not be started. Retry, or check that the ${providerName} CLI runs in a terminal.`;
        }
        case 'handshake_failed': {
            return `${providerName} started but did not respond. Retry, or update the ${providerName} CLI.`;
        }
        case 'process_exited': {
            return `${providerName} stopped unexpectedly. Retry to resume the conversation.`;
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'unsupported_version': {
            return `This ${providerName} version does not support Chat. Update the ${providerName} CLI.`;
        }
    }
}

/**
 * Whether the composer accepts a message. A stopped Chat resumes its Agent Session on the next message, a starting one
 * queues the message on Server Core until the provider is ready (opening a Chat and typing at once must not drop the
 * first Enter), and a running turn accepts a message into its queue or as steering. Only a failed provider, or a Chat
 * not loaded yet, refuses input.
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
 * What a running turn says it is doing. A long turn reads as progress rather than a stall when the line has some life
 * in it, as Claude Code's spinner does; the words stay calm and never claim a specific step.
 */
const WORKING_VERBS = [
    'Pondering',
    'Tinkering',
    'Mulling it over',
    'Connecting the dots',
    'Untangling',
    'Sketching',
    'Percolating',
    'Rummaging',
    'Piecing it together',
    'Noodling',
    'Brewing',
    'Weighing options',
    'Tracing',
    'Sleuthing',
    'Distilling',
    'Simmering',
    'Calibrating',
    'Whittling',
    'Wrangling',
    'Conjuring',
    'Exploring',
    'Cross-checking',
    'Lining things up',
    'Spelunking',
] as const;

/**
 * One verb per turn, chosen from its id so it stays put while the turn runs and every client shows the same one.
 */
export function agentChatWorkingVerb(turnId: string): string {
    let hash = 0;
    for (const character of turnId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    return WORKING_VERBS[hash % WORKING_VERBS.length] ?? 'Working';
}

export type AgentChatActivity =
    | { kind: 'starting'; text: string }
    | { kind: 'working'; text: string; startedAt: number | undefined }
    | { kind: 'compacting'; text: string; isStoppable: boolean }
    | { kind: 'waiting'; text: string };

/**
 * What the Chat is doing right now, for the status line on the composer. A pending request means the turn is blocked on
 * the user, not working, so it says so instead of animating. Compacting the context names itself instead of a playful
 * verb, so a `/compact` the user asked for visibly runs; it can happen inside a turn (automatic compaction), which Esc
 * still stops.
 */
export function agentChatActivity(
    snapshot:
        | Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'operation' | 'requests' | 'turns'>
        | undefined,
    providerName: string,
): AgentChatActivity | undefined {
    if (!snapshot || snapshot.status === 'starting')
        return { kind: 'starting', text: `Starting ${providerName}…` };
    const turnId = snapshot.activeTurnId;
    if (turnId && snapshot.requests.length > 0)
        return { kind: 'waiting', text: 'Waiting for your answer' };
    if (snapshot.operation === 'compacting')
        return { kind: 'compacting', text: 'Compacting context…', isStoppable: Boolean(turnId) };
    if (!turnId) return undefined;
    return {
        kind: 'working',
        text: `${agentChatWorkingVerb(turnId)}…`,
        startedAt: snapshot.turns.find((turn) => turn.id === turnId)?.startedAt,
    };
}

/**
 * Whether a message sent now would wait in the queue rather than start a turn: a turn is running, the context is
 * compacting, or earlier messages are still queued and not paused (Server Core keeps the queue in order).
 */
export function isAgentChatBusy(
    snapshot:
        Pick<AgentChatSnapshot, 'activeTurnId' | 'operation' | 'queue' | 'queuePaused'> | undefined,
): boolean {
    if (!snapshot) return false;
    return (
        Boolean(snapshot.activeTurnId) ||
        snapshot.operation === 'compacting' ||
        ((snapshot.queue?.length ?? 0) > 0 && !snapshot.queuePaused)
    );
}

export function isAgentChatTurnRunning(snapshot: AgentChatSnapshot | undefined): boolean {
    return Boolean(snapshot?.activeTurnId);
}

/**
 * What submitting the composer does. Enter sends when the Chat is idle and queues while a turn runs or the context is
 * compacting; Cmd+Enter (Ctrl+Enter off macOS) steers the running turn instead. Shift+Enter adds a line, and an IME
 * composition owns Enter until it commits, otherwise confirming a candidate would send a half-typed message.
 * `undefined` means the key is not a submit.
 */
export function agentChatSubmitDelivery(
    event: {
        key: string;
        shiftKey: boolean;
        metaKey: boolean;
        ctrlKey: boolean;
        isComposing: boolean;
    },
    state: { isTurnRunning: boolean; isBusy: boolean },
): 'send' | 'queue' | 'steer' | undefined {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return undefined;
    const isSteerChord = event.metaKey || event.ctrlKey;
    if (isSteerChord && state.isTurnRunning) return 'steer';
    return state.isBusy ? 'queue' : 'send';
}

/**
 * The composer's send affordance for the Chat's state: while a turn runs, Enter queues and Cmd+Enter steers; while the
 * Chat is otherwise busy (compacting, or draining the queue) a message waits its turn.
 */
export function agentChatSendAction(
    state: { isTurnRunning: boolean; isBusy: boolean },
    providerName: string,
): { label: 'Send' | 'Queue message'; tooltip: string; placeholder: string } {
    if (state.isTurnRunning)
        return {
            label: 'Queue message',
            tooltip: 'Queue (Enter) · Steer (⌘Enter)',
            placeholder: 'Queue a follow-up (⌘Enter to steer)',
        };
    if (state.isBusy)
        return { label: 'Queue message', tooltip: 'Queue', placeholder: 'Queue a follow-up' };
    return { label: 'Send', tooltip: 'Send', placeholder: `Message ${providerName}` };
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
    request: Extract<AgentChatRequest, { kind: 'command' | 'fileChange' | 'tool' }>,
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
        case 'tool': {
            /**
             * Claude Code asks to leave plan mode through this tool; its summary is the plan.
             */
            return request.name === 'ExitPlanMode'
                ? 'Start with this plan?'
                : `Allow ${request.name}?`;
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
