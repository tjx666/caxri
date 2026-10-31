import { composerSuggestionTrigger } from '../sessions/composer-suggestions';

/**
 * Most Project files the `@` list shows at once, as on Desktop; the Sessions group below it keeps its own cap
 * (`searchSessionReferenceCandidates`).
 */
export const MAX_AGENT_CHAT_FILE_MENTIONS = 8;

/**
 * The `@` token at the end of the draft and what follows the `@`, or `undefined` when the draft does not end in one.
 * Like the Terminal composer, the phone completes only the token at the end of the draft.
 */
export function agentChatMentionToken(draft: string): { query: string; token: string } | undefined {
    const trigger = composerSuggestionTrigger(draft);
    return trigger?.kind === 'file' ? { query: trigger.query, token: trigger.token } : undefined;
}

/**
 * One row of the `@` list: a Project file the name search found, or another Session whose conversation can be cited.
 */
export type AgentChatMentionRow =
    | { kind: 'file'; directory: string; name: string; path: string }
    | { kind: 'session'; projectTitle: string; sessionId: string; title: string };

/**
 * The `@` list as Desktop orders it: files first (a name search needs at least one typed character), then the Sessions
 * that match the title.
 */
export function agentChatMentionRows(
    paths: readonly string[] | undefined,
    sessions: ReadonlyArray<{ id: string; projectTitle: string; title: string }>,
): AgentChatMentionRow[] {
    const files = (paths ?? [])
        .slice(0, MAX_AGENT_CHAT_FILE_MENTIONS)
        .map((path): AgentChatMentionRow => {
            const slash = path.lastIndexOf('/');
            return {
                kind: 'file',
                directory: slash === -1 ? '' : path.slice(0, slash),
                name: path.slice(slash + 1),
                path,
            };
        });
    return [
        ...files,
        ...sessions.map((session): AgentChatMentionRow => ({
            kind: 'session',
            projectTitle: session.projectTitle,
            sessionId: session.id,
            title: session.title,
        })),
    ];
}

/**
 * The group heading row `index` starts, or `undefined` when it continues the group above it.
 */
export function agentChatMentionHeading(
    rows: readonly AgentChatMentionRow[],
    index: number,
): AgentChatMentionRow['kind'] | undefined {
    if (index < 0 || index >= rows.length) return undefined;
    const { kind } = rows[index];
    return index === 0 || rows[index - 1].kind !== kind ? kind : undefined;
}
