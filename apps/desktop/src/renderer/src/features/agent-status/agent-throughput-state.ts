import type { AgentThroughput, AgentThroughputSample } from '@caxri/protocol';

/**
 * What the Agent status tab's speed report can say, kept apart so a failed read, a closed Terminal, and an Agent that
 * has not answered yet never collapse into one "nothing measured" sentence.
 */
export type AgentThroughputViewState =
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'closed' }
    | { kind: 'notMeasured' }
    | { kind: 'measured'; throughput: AgentThroughput; latest: AgentThroughputSample };

/**
 * A reading already on screen wins over a later failed poll: the figures stay, and the next poll retries anyway.
 */
export function agentThroughputViewState({
    data,
    isError,
    isTerminalOpen,
}: {
    data: AgentThroughput | null | undefined;
    isError: boolean;
    isTerminalOpen: boolean;
}): AgentThroughputViewState {
    const latest = data?.samples.at(-1);
    if (data && latest) return { kind: 'measured', throughput: data, latest };
    if (isError) return { kind: 'error' };
    if (!isTerminalOpen) return { kind: 'closed' };
    if (data === undefined) return { kind: 'loading' };
    return { kind: 'notMeasured' };
}

export const AGENT_THROUGHPUT_STATE_MESSAGES = {
    loading: 'Reading the transcript…',
    error: "Couldn't read the Agent's transcript.",
    closed: 'Nothing was measured before this Terminal closed.',
    notMeasured:
        'No response has been measured yet. Speed appears after the Agent finishes its first response.',
} as const satisfies Record<Exclude<AgentThroughputViewState['kind'], 'measured'>, string>;
