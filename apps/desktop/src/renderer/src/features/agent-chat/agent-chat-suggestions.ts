import type { AgentAction } from '@caxri/protocol';

import type { SessionReferenceCandidate } from '../session/session-reference';

/**
 * One row of a composer suggestion list. `label` is set in the monospace face when it is something the user types
 * verbatim (a `/command`), and in the UI face when it is a name (a Session title).
 */
export interface AgentChatSuggestion {
    description?: string;
    hint?: string;
    isLabelLiteral: boolean;
    /**
     * Unique within the list; also the suffix of the row's DOM id.
     */
    key: string;
    label: string;
}

/**
 * DOM id of a suggestion row, for the input's `aria-activedescendant`.
 */
export function agentChatSuggestionOptionId(listId: string, key: string): string {
    return `${listId}-${key}`;
}

export function agentChatActionSuggestion(action: AgentAction): AgentChatSuggestion {
    return {
        key: action.invocation,
        label: action.invocation,
        isLabelLiteral: true,
        ...(action.argumentHint && { hint: action.argumentHint }),
        ...(action.description && { description: action.description }),
    };
}

export function agentChatSessionSuggestion(
    candidate: SessionReferenceCandidate,
): AgentChatSuggestion {
    return {
        key: `session-${candidate.sessionId}`,
        label: candidate.title,
        isLabelLiteral: false,
        ...(candidate.projectTitle && { description: candidate.projectTitle }),
    };
}

/**
 * The `@` mention being typed at the caret: the whitespace-delimited word that ends at the caret and starts with `@`.
 * `start`/`end` cover the whole word so choosing a Session replaces exactly what was typed. A second `@` inside the
 * word (an email address) is not a mention.
 */
export function agentChatMentionAt(
    draft: string,
    caret: number,
): { end: number; query: string; start: number } | undefined {
    const before = draft.slice(0, caret);
    const start = before.search(/\S*$/u);
    const word = before.slice(start);
    if (!word.startsWith('@') || word.includes('@', 1)) return undefined;
    return { end: caret, query: word.slice(1), start };
}
