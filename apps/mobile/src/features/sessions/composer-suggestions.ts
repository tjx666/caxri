export interface ComposerSuggestionTrigger {
    kind: 'action' | 'file';
    token: string;
    query: string;
}

/**
 * The composer only completes the token at the cursor's end, leaving earlier prose untouched.
 */
export function composerSuggestionTrigger(draft: string): ComposerSuggestionTrigger | null {
    const match = /(?:^|\s)([/@]\S*)$/u.exec(draft);
    if (!match) return null;
    const token = match[1];
    return {
        kind: token.startsWith('/') ? 'action' : 'file',
        token,
        query: token.slice(1),
    };
}

export function insertComposerSuggestion(draft: string, token: string, value: string): string {
    if (!draft.endsWith(token)) return draft;
    return `${draft.slice(0, -token.length)}${value} `;
}

/**
 * The `mobile.agent.actions` parameters for a typed slash query. The Server ranks the Terminal's whole action list by
 * the query before keeping its bounded top slice (the same request the Agent Chat menu makes), so a skill past the
 * first page is still found. The query omits the leading `/` so `$` skills match too; an empty query asks for the
 * unranked list.
 */
export function composerActionsRequest(
    sessionId: string,
    terminalId: string,
    query: string,
): { sessionId: string; terminalId: string; query?: string } {
    return query ? { sessionId, terminalId, query } : { sessionId, terminalId };
}
