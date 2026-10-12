import type { AgentAction } from '@caxri/protocol';

import type { SuggestionOption } from '../../lib/suggestion-options';
import type { SessionReferenceCandidate } from '../session/session-reference';

export function agentChatActionSuggestion(action: AgentAction): SuggestionOption {
    return {
        key: action.invocation,
        label: action.invocation,
        isLabelLiteral: true,
        ...(action.argumentHint && { hint: action.argumentHint }),
        ...(action.description && { description: action.description }),
    };
}

export function agentChatSessionSuggestion(candidate: SessionReferenceCandidate): SuggestionOption {
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
): SuggestionOption[] {
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
