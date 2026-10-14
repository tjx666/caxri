import { agentChatWaitingText } from './agent-chat-approval.js';
import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatPlan,
    AgentChatSnapshot,
} from './agent-chat-contract.js';
import type { AgentChatRequest } from './agent-chat-requests.js';

/**
 * Presentation rules every Agent Chat client shares (the Desktop Chat pane and the phone's Chat screen). Copy that
 * differs by where the user sits is keyed by `AgentChatSurface`, so each surface's wording lives beside the other's and
 * a new failure reason cannot ship on one surface only.
 */
export type AgentChatSurface = 'desktop' | 'mobile';

/**
 * The provider name at the start of a sentence. Catalog names are already capitalized; only a providerless fallback
 * such as `the Agent` needs its first letter raised.
 */
export function sentenceStartProvider(provider: string): string {
    return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export interface AgentChatFailureMessageOptions {
    /**
     * The provider catalog's display name, or a client's providerless fallback.
     */
    providerName: string;
    surface: AgentChatSurface;
    /**
     * False on a phone without reply access, which has no Retry button, so the copy names the access it needs instead
     * of asking it to retry. Desktop always offers Retry.
     */
    canRetry?: boolean;
}

/**
 * User-facing copy for each closed failure reason; provider text never selects the message. Desktop copy names the next
 * step on the same machine (Retry, the terminal, the PATH). The phone's copy says the provider runs "on your computer",
 * because nothing the phone does installs or updates it.
 */
export function agentChatFailureMessage(
    reason: AgentChatFailureReason,
    { canRetry = true, providerName, surface }: AgentChatFailureMessageOptions,
): string {
    return surface === 'desktop'
        ? desktopFailureMessage(reason, providerName)
        : mobileFailureMessage(reason, providerName, canRetry);
}

function desktopFailureMessage(reason: AgentChatFailureReason, provider: string): string {
    switch (reason) {
        case 'executable_not_found': {
            return `${provider} is not installed or is not on your PATH. Install it, then retry.`;
        }
        case 'spawn_failed': {
            return `${provider} could not be started. Retry, or check that the ${provider} CLI runs in a terminal.`;
        }
        case 'handshake_failed': {
            return `${provider} started but did not respond. Retry, or update the ${provider} CLI.`;
        }
        case 'process_exited': {
            return `${provider} stopped unexpectedly. Retry to resume the conversation.`;
        }
        case 'resume_failed': {
            return 'The previous conversation could not be resumed.';
        }
        case 'conversation_in_use': {
            return `This conversation is open in another ${provider} app or window.`;
        }
        case 'unsupported_version': {
            return `This ${provider} version does not support Chat. Update the ${provider} CLI.`;
        }
    }
}

function mobileFailureMessage(
    reason: AgentChatFailureReason,
    provider: string,
    canRetry: boolean,
): string {
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
}

/**
 * Claude Code marks the option it recommends by ending its label with `(Recommended)`, the convention its
 * `AskUserQuestion` tool asks the model to follow; there is no structured flag. A model answering in Chinese writes the
 * same suffix in Chinese, often with full-width parentheses (`（推荐）`). The card shows the label without the suffix and a
 * badge instead, while the answer still sends the provider its original label.
 */
const RECOMMENDED_SUFFIX = /\s*[(（]\s*(?:recommended|推荐)\s*[)）]\s*$/iu;

export function agentChatQuestionOption(label: string): { isRecommended: boolean; text: string } {
    const text = label.replace(RECOMMENDED_SUFFIX, '');
    return text === label || !text
        ? { isRecommended: false, text: label }
        : { isRecommended: true, text };
}

/**
 * Builds the `answers` response for a question request. A typed "Other" answer replaces the chosen option for its
 * question; an unanswered question is omitted (the provider decides how to treat it), and `isComplete` tells the card
 * whether every question has an answer yet. Only the request's own questions are read, so a stale selection for a
 * question the request no longer asks never reaches the provider.
 */
export function agentChatQuestionAnswers(
    request: Extract<AgentChatRequest, { kind: 'question' }>,
    selected: Readonly<Record<string, string | undefined>>,
    other: Readonly<Record<string, string | undefined>>,
): { answers: Record<string, string[]>; isComplete: boolean } {
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
}

/**
 * The selection a question card starts with: each question's recommended option, so one Submit accepts every
 * recommendation. A question without a recommendation starts unanswered, because preselecting an arbitrary option would
 * read as advice the provider never gave.
 */
export function agentChatQuestionDefaults(
    request: Extract<AgentChatRequest, { kind: 'question' }>,
): Record<string, string> {
    const selected: Record<string, string> = {};
    for (const question of request.questions) {
        const recommended = question.options.find(
            (option) => agentChatQuestionOption(option.label).isRecommended,
        );
        if (recommended) selected[question.id] = recommended.label;
    }
    return selected;
}

/**
 * Where a multi-question card goes after the question at `from` is answered: the next question still without an answer,
 * searching forward and wrapping around, so questions skipped earlier come back before the card submits. `undefined`
 * means every other question is answered and the card can send.
 */
export function agentChatNextUnansweredQuestion(
    request: Extract<AgentChatRequest, { kind: 'question' }>,
    answers: Readonly<Record<string, readonly string[]>>,
    from: number,
): number | undefined {
    const count = request.questions.length;
    for (let step = 1; step < count; step += 1) {
        const index = (from + step) % count;
        const question = request.questions.at(index);
        if (question && !Object.hasOwn(answers, question.id)) return index;
    }
    return undefined;
}

/**
 * What a running turn says it is doing. A long turn reads as progress rather than a stall when the line has some life
 * in it, as Claude Code's spinner does; the words never claim a specific step. These Caxri-owned phrases stay in the
 * same order as Desktop's translated list, so every client picks the same position.
 */
const WORKING_PHRASES = [
    'Mapping the terrain',
    'Following a bright thread',
    'Sorting the puzzle pieces',
    'Checking the compass',
    'Turning the problem around',
    'Turning another page',
    'Sketching a few routes',
    'Listening for the signal',
    'Clearing a little fog',
    'Taking the scenic route',
    'Reading between the lines',
    'Tuning the workshop',
    'Finding the loose thread',
    'Looking under the hood',
    'Trying another angle',
    'Letting the pieces settle',
    'Peeking behind the curtain',
    'Walking through the maze',
    'Sharpening the outline',
    'Following the breadcrumbs',
    'Checking the other pocket',
    'Giving the idea a spin',
    'Looking for the quiet clue',
    'Moving the lantern closer',
    'Bringing the edges together',
    'Taking one more pass',
    'Getting the bearings',
    'Bringing it into focus',
] as const;

/**
 * One phrase per turn, chosen from its id so it stays put while the turn runs and every client shows the same one.
 */
export function agentChatWorkingVerb(turnId: string): string {
    let hash = 0;
    for (const character of turnId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    return WORKING_PHRASES[hash % WORKING_PHRASES.length] ?? 'Working';
}

export type AgentChatActivity =
    | { kind: 'starting'; text: string }
    | { kind: 'working'; text: string; startedAt: number | undefined }
    | { kind: 'compacting'; text: string; isStoppable: boolean }
    | { kind: 'waiting'; text: string };

/**
 * What the Chat is doing right now, for the status line on the composer. A pending request means the turn is blocked on
 * the user, not working, so it says so instead of animating, and says whether it waits on an approval or an answer.
 * Compacting the context names itself instead of a playful verb, so a `/compact` the user asked for visibly runs; it
 * can happen inside a turn (automatic compaction), which Esc still stops. Before the projection is first read, a Chat
 * that already has a conversation is loading it, not starting its Agent, so it says so (`hasConversation` is whether
 * the Terminal is bound to an Agent Session).
 */
export function agentChatActivity(
    snapshot:
        | Pick<AgentChatSnapshot, 'status' | 'activeTurnId' | 'operation' | 'requests' | 'turns'>
        | undefined,
    providerName: string,
    { hasConversation = false }: { hasConversation?: boolean } = {},
): AgentChatActivity | undefined {
    if (!snapshot && hasConversation) return { kind: 'starting', text: 'Loading conversation…' };
    if (!snapshot || snapshot.status === 'starting')
        return { kind: 'starting', text: `Starting ${providerName}…` };
    const turnId = snapshot.activeTurnId;
    if (turnId && snapshot.requests.length > 0)
        return { kind: 'waiting', text: agentChatWaitingText(snapshot.requests) };
    if (snapshot.operation === 'compacting')
        return { kind: 'compacting', text: 'Compacting context…', isStoppable: Boolean(turnId) };
    if (!turnId) return undefined;
    return {
        kind: 'working',
        text: `${agentChatWorkingVerb(turnId)}…`,
        startedAt: snapshot.turns.find((turn) => turn.id === turnId)?.startedAt,
    };
}

export interface AgentChatPlanProgress {
    completed: number;
    total: number;
    /**
     * The step the Agent is on: the one in progress, else the first still pending; absent once every step is done.
     */
    current: string | undefined;
}

/**
 * How far the Agent is through its plan, for the collapsed plan row above the composer.
 */
export function agentChatPlanProgress(plan: Pick<AgentChatPlan, 'steps'>): AgentChatPlanProgress {
    const current =
        plan.steps.find((step) => step.status === 'inProgress') ??
        plan.steps.find((step) => step.status === 'pending');
    return {
        completed: plan.steps.filter((step) => step.status === 'completed').length,
        total: plan.steps.length,
        current: current?.step,
    };
}

/**
 * The plan docked above the composer, on Desktop and the phone alike: the latest plan stays docked after its turn ends
 * (the Server clears it when the next turn starts), and its in-progress step spins only while a turn is running.
 */
export function agentChatDockedPlan(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'plan'> | undefined,
): { plan: AgentChatPlan; isTurnRunning: boolean } | undefined {
    if (!snapshot?.plan) return undefined;
    return { plan: snapshot.plan, isTurnRunning: Boolean(snapshot.activeTurnId) };
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
 * Whether a timeline item has anything to show, on Desktop and on the phone. An empty or whitespace-only thought
 * (redacted, or not streamed yet) draws nothing, and so does a reply that ended without words, such as one a stop cut
 * off after a lone newline: it would render an empty bubble, and on Desktop a Copy action with nothing to copy. A reply
 * still streaming stays, because its first words are on the way. An image-only user message keeps its place, since its
 * images draw above the bubble.
 */
export function isAgentChatItemVisible(item: AgentChatItem): boolean {
    switch (item.type) {
        case 'reasoning': {
            return item.text.trim() !== '';
        }
        case 'agentMessage': {
            return item.streaming || item.text.trim() !== '';
        }
        case 'userMessage': {
            return item.text !== '' || (item.images?.length ?? 0) > 0;
        }
        default: {
            return true;
        }
    }
}
