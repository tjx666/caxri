import type { AgentThroughput } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { agentThroughputViewState, throughputBarDescription } from '../agent-throughput-state';

const empty = { outputTokens: 0, durationMs: 0, responseCount: 0 };

function throughput(samples: AgentThroughput['samples']): AgentThroughput {
    return { provider: 'claude', recent: empty, turn: empty, session: empty, byModel: [], samples };
}

const sample = { outputTokens: 100, durationMs: 2_000, completedAt: 1 };

describe('agentThroughputViewState', () => {
    it('keeps figures already read even when a later poll fails or the Terminal closed', () => {
        const state = agentThroughputViewState({
            data: throughput([sample]),
            isError: true,
            isTerminalOpen: false,
        });
        expect(state.kind).toBe('measured');
    });

    it('tells a failed read apart from a closed Terminal and from an Agent with no response yet', () => {
        expect(
            agentThroughputViewState({ data: undefined, isError: true, isTerminalOpen: true }).kind,
        ).toBe('error');
        expect(
            agentThroughputViewState({ data: null, isError: false, isTerminalOpen: false }).kind,
        ).toBe('closed');
        expect(
            agentThroughputViewState({ data: throughput([]), isError: false, isTerminalOpen: true })
                .kind,
        ).toBe('notMeasured');
        expect(
            agentThroughputViewState({ data: undefined, isError: false, isTerminalOpen: true })
                .kind,
        ).toBe('loading');
    });
});

describe('throughputBarDescription', () => {
    it('reads one response bar the same way in its Tooltip and the keyboard readout', () => {
        const text = throughputBarDescription(translate, {
            ...sample,
            completedAt: new Date(2026, 0, 2, 15, 4, 5).getTime(),
            model: 'gpt-5',
            speed: 'fast',
        });
        expect(text).toMatch(/^gpt-5 · Fast: .+, finished 3:04:05\sPM$/u);
    });
});
