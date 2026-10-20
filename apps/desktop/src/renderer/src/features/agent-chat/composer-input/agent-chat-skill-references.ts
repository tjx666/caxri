import type { AgentAction } from '@caxri/protocol';

/**
 * The skills an Agent can use, keyed by bare name (`commit` for `$commit`), so inline code in a reply can be matched
 * against them whichever sigil the Agent wrote.
 */
export function agentChatSkillIndex(
    actions: readonly AgentAction[] | undefined,
): ReadonlyMap<string, string> {
    return new Map(
        (actions ?? [])
            .filter((action) => action.kind === 'skill')
            .map((action) => [action.invocation.slice(1), action.invocation]),
    );
}

/**
 * The skill invocation inline code names: the bare name (`commit`), Codex's `$commit`, or Claude Code's `/commit`.
 * Anything else, including surrounding text or a second sigil, names no skill.
 */
export function agentChatSkillMatch(
    index: ReadonlyMap<string, string>,
    code: string,
): string | undefined {
    const name = code.startsWith('$') || code.startsWith('/') ? code.slice(1) : code;
    return index.get(name);
}
