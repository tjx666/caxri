import type { AgentActivityRow } from './agent-activity-rows';

/**
 * A short state phrase on a row's metadata line, for the states the group heading does not say by itself.
 */
export type AgentActivityStatusNote = 'background' | 'failed' | 'waiting';

/**
 * Which phrase a row's metadata line carries.
 *
 * A working row that is only watching background work says so, because its heading ("Working") would otherwise read as
 * live progress. A Needs attention row that ended on a question or a failure says which one, but only while excerpts
 * are hidden: the excerpt quotes the question or error itself, so repeating the state beside it would be noise, whereas
 * without it the row would read as a plain result. The mark is a word and a shape (`?`, `✕`), never color alone.
 */
export function agentActivityStatusNote(
    row: Pick<AgentActivityRow, 'groupId' | 'isBackgroundWait'> & {
        session: Pick<AgentActivityRow['session'], 'lastAttentionKind'>;
    },
    areExcerptsShown: boolean,
): AgentActivityStatusNote | undefined {
    if (row.groupId === 'working') return row.isBackgroundWait ? 'background' : undefined;
    if (areExcerptsShown || row.groupId !== 'attention') return undefined;
    const kind = row.session.lastAttentionKind;
    return kind === 'waiting' || kind === 'failed' ? kind : undefined;
}
