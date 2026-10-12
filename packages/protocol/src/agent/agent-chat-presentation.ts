import type { AgentChatFailureReason } from './agent-chat-contract.js';
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
