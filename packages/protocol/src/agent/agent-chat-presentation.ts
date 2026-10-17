import { agentChatWaitingText } from './agent-chat-approval.js';
import type {
    AgentChatFailureReason,
    AgentChatItem,
    AgentChatItemStatus,
    AgentChatPlan,
    AgentChatSnapshot,
} from './agent-chat-contract.js';
import type { AgentChatLabelKey, AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import { agentChatLabelsEn } from './agent-chat-labels-en.js';
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

const DESKTOP_FAILURE_KEYS: Record<AgentChatFailureReason, AgentChatLabelKey> = {
    conversation_in_use: 'agentChat.failure.conversationInUse',
    executable_not_found: 'agentChat.failure.executableNotFound',
    handshake_failed: 'agentChat.failure.handshakeFailed',
    process_exited: 'agentChat.failure.processExited',
    resume_failed: 'agentChat.failure.resumeFailed',
    spawn_failed: 'agentChat.failure.spawnFailed',
    unsupported_version: 'agentChat.failure.unsupportedVersion',
};

/**
 * The phone's copy where it differs from Desktop's; `process_exited` depends on reply access and `resume_failed` reads
 * the same on both.
 */
const MOBILE_FAILURE_KEYS: Record<
    Exclude<AgentChatFailureReason, 'process_exited' | 'resume_failed'>,
    AgentChatLabelKey
> = {
    conversation_in_use: 'agentChat.failure.mobile.conversationInUse',
    executable_not_found: 'agentChat.failure.mobile.executableNotFound',
    handshake_failed: 'agentChat.failure.mobile.handshakeFailed',
    spawn_failed: 'agentChat.failure.mobile.spawnFailed',
    unsupported_version: 'agentChat.failure.mobile.unsupportedVersion',
};

/**
 * User-facing copy for each closed failure reason; provider text never selects the message. Desktop copy names the next
 * step on the same machine (Retry, the terminal, the PATH). The phone's copy says the provider runs "on your computer",
 * because nothing the phone does installs or updates it.
 */
export function agentChatFailureMessage(
    reason: AgentChatFailureReason,
    { canRetry = true, providerName, surface }: AgentChatFailureMessageOptions,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    if (surface === 'desktop') return t(DESKTOP_FAILURE_KEYS[reason], { provider: providerName });
    switch (reason) {
        case 'process_exited': {
            return t(
                canRetry
                    ? 'agentChat.failure.processExited'
                    : 'agentChat.failure.mobile.processExitedNoRetry',
                { provider: sentenceStartProvider(providerName) },
            );
        }
        case 'resume_failed': {
            return t('agentChat.failure.resumeFailed');
        }
        case 'conversation_in_use':
        case 'unsupported_version': {
            return t(MOBILE_FAILURE_KEYS[reason], { provider: providerName });
        }
        default: {
            return t(MOBILE_FAILURE_KEYS[reason], {
                provider: sentenceStartProvider(providerName),
            });
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
 * in it, as Claude Code's spinner does; the words never claim a specific step. The phrases are Caxri's own, numbered in
 * the catalog so every client and language picks the same position.
 */
const WORKING_VERB_KEYS = Object.keys(agentChatLabelsEn).filter((key): key is AgentChatLabelKey =>
    key.startsWith('agentChat.timeline.working.phrase'),
);

/**
 * One phrase per turn, chosen from its id so it stays put while the turn runs and every client shows the same one.
 */
export function agentChatWorkingVerb(
    turnId: string,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    let hash = 0;
    for (const character of turnId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
    return t(
        WORKING_VERB_KEYS[hash % WORKING_VERB_KEYS.length] ?? 'agentChat.timeline.working.working',
    );
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
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): AgentChatActivity | undefined {
    if (!snapshot && hasConversation)
        return { kind: 'starting', text: t('agentChat.timeline.loadingConversation') };
    if (!snapshot || snapshot.status === 'starting')
        return {
            kind: 'starting',
            text: t('agentChat.timeline.starting', { provider: providerName }),
        };
    const turnId = snapshot.activeTurnId;
    if (turnId && snapshot.requests.length > 0)
        return { kind: 'waiting', text: agentChatWaitingText(snapshot.requests, t) };
    if (snapshot.operation === 'compacting')
        return {
            kind: 'compacting',
            text: t('agentChat.timeline.compacting'),
            isStoppable: Boolean(turnId),
        };
    if (!turnId) return undefined;
    return {
        kind: 'working',
        text: `${agentChatWorkingVerb(turnId, t)}…`,
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

export function agentChatItemStatusLabel(
    status: AgentChatItemStatus,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    return t(`agentChat.tool.status.${status}`);
}

/**
 * A notice's text. The provider's own message is transcript content and stays as reported; only the words Caxri puts
 * around it are translated.
 */
export function agentChatNoticeMessage(
    item: Extract<AgentChatItem, { type: 'notice' }>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    switch (item.kind) {
        case 'warning':
        case 'output': {
            return item.message ?? '';
        }
        case 'compacted': {
            return t('agentChat.message.contextCompacted');
        }
        case 'retrying': {
            return item.message
                ? t('agentChat.message.retryingWith', { message: item.message })
                : t('agentChat.message.retrying');
        }
        case 'error': {
            return item.message ?? t('agentChat.message.agentError');
        }
        case 'answered': {
            return item.message
                ? t('agentChat.message.answeredWith', { message: item.message })
                : t('agentChat.message.answered');
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
