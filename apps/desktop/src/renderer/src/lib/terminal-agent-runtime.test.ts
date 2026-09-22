import type { ProcessState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isAgentProcessRunning } from './terminal-agent-runtime';

interface AgentRuntimeMatrixRow {
    expected: boolean;
    lastAgentProcessState: ProcessState | undefined;
    name: string;
}

describe('isAgentProcessRunning', () => {
    const matrix: AgentRuntimeMatrixRow[] = [
        {
            name: 'the Agent child is running inside the shell',
            lastAgentProcessState: 'running',
            expected: true,
        },
        {
            name: 'the shell is running before the Agent child starts',
            lastAgentProcessState: 'starting',
            expected: false,
        },
        {
            name: 'the Agent child exited while the shell kept running',
            lastAgentProcessState: 'stopped',
            expected: false,
        },
        {
            name: 'the Agent child failed while the shell kept running',
            lastAgentProcessState: 'failed',
            expected: false,
        },
        {
            name: 'the Agent child died while the shell kept running',
            lastAgentProcessState: 'dead',
            expected: false,
        },
        {
            name: 'the Agent child was interrupted while the shell kept running',
            lastAgentProcessState: 'interrupted',
            expected: false,
        },
        {
            name: 'the Terminal has a durable Agent association but no active Agent child',
            lastAgentProcessState: undefined,
            expected: false,
        },
    ];

    for (const row of matrix) {
        it(row.name, () => {
            expect(isAgentProcessRunning(row.lastAgentProcessState)).toBe(row.expected);
        });
    }
});
