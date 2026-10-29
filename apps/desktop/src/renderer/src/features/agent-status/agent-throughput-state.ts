import type { AgentThroughput, AgentThroughputSample } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { localeDateTimeFormat } from '../../lib/locale-format';
import {
    describeThroughputSample,
    describeThroughputVariant,
} from '../status-bar/agent-throughput-label';

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

export const AGENT_THROUGHPUT_STATE_MESSAGE_KEYS = {
    loading: 'agentStatus.throughput.loading',
    error: 'agentStatus.throughput.error',
    closed: 'agentStatus.throughput.closed',
    notMeasured: 'agentStatus.throughput.notMeasured',
} as const satisfies Record<Exclude<AgentThroughputViewState['kind'], 'measured'>, TranslationKey>;

/**
 * One response bar's Tooltip and keyboard readout: `Opus 4.6: 1,200 tokens in 20s, finished 3:04:05 PM`, its time in
 * the interface language.
 */
export function throughputBarDescription(t: Translate, sample: AgentThroughputSample): string {
    return t('agentStatus.throughput.barDescription', {
        variant: describeThroughputVariant(sample, t),
        sample: describeThroughputSample(sample, t),
        time: localeDateTimeFormat({ timeStyle: 'medium' }, t.locale).format(sample.completedAt),
    });
}
