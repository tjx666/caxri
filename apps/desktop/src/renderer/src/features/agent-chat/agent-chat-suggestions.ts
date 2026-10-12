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
    /**
     * When the row's Session was last opened, shown beside its description only when another row has the same title, so
     * two same-named Sessions can be told apart.
     */
    openedAt?: number;
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
 * The `@` list's rows. Each names its Project; a title that more than one row shares (compared case-insensitively) also
 * carries when that Session was last opened, since two Sessions in one Project can share a title.
 */
export function agentChatSessionSuggestions(
    candidates: readonly SessionReferenceCandidate[],
    openedAt: ReadonlyMap<string, number>,
): AgentChatSuggestion[] {
    const counts = new Map<string, number>();
    for (const { title } of candidates) {
        const key = title.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return candidates.map((candidate) => {
        const suggestion = agentChatSessionSuggestion(candidate);
        const opened = openedAt.get(candidate.sessionId);
        return opened !== undefined && (counts.get(candidate.title.toLowerCase()) ?? 0) > 1
            ? { ...suggestion, openedAt: opened }
            : suggestion;
    });
}

/**
 * The keys a suggestion list's `meta` footer names. A list with no row to choose offers only Escape, so it never
 * promises an Enter that would send the draft instead.
 */
export function agentChatSuggestionFooter(
    list: 'commands' | 'sessions',
    hasMatches: boolean,
): string {
    if (!hasMatches) return 'Esc to dismiss';
    return list === 'commands'
        ? '↑↓ to move · Tab to complete · Enter to run · Esc to dismiss'
        : '↑↓ to move · Enter to cite · Esc to dismiss';
}

/**
 * The `@` list's row while nothing matches: a query that matches no title, or no other Session to cite at all.
 */
export function agentChatSessionEmptyText(query: string): string {
    return query.trim() ? 'No Sessions match' : 'No other Sessions to cite';
}

/**
 * The `@` list's progress row while the chosen Session is condensed into a reference file.
 */
export function agentChatSessionPreparingText(title: string): string {
    return `Preparing “${title}”…`;
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
