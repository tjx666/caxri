import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentActionTerminalInput, canExecuteAgentAction } from '../agent-action-input';

const action = (patch: Partial<AgentAction> = {}): AgentAction => ({
    invocation: '/review',
    kind: 'command',
    requiresArguments: false,
    source: 'builtIn',
    ...patch,
});

describe('agent action input', () => {
    it('inserts an invocation with a trailing space and no Return', () => {
        expect(agentActionTerminalInput(action(), false)).toBe('/review ');
    });

    it('sends exactly one Return only for explicit execution', () => {
        expect(agentActionTerminalInput(action(), true)).toBe('/review\r');
    });

    it('blocks immediate execution for actions with required arguments', () => {
        expect(canExecuteAgentAction(action({ requiresArguments: true }))).toBe(false);
        expect(canExecuteAgentAction(action({ argumentHint: '[target]' }))).toBe(true);
    });
});
