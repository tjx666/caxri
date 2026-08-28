import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentActionSubmitModes,
    agentActionTerminalInputSteps,
    canExecuteAgentAction,
} from '../agent-action-input';

const action = (patch: Partial<AgentAction> = {}): AgentAction => ({
    invocation: '/review',
    kind: 'command',
    requiresArguments: false,
    source: 'builtIn',
    ...patch,
});

describe('agent action input', () => {
    it('runs the primary selection and reserves insertion for the alternate chord', () => {
        expect(agentActionSubmitModes).toEqual({ primary: 'run', alternate: 'insert' });
    });

    it('inserts an invocation with a trailing space and no Return', () => {
        expect(agentActionTerminalInputSteps('codex', action(), 'insert')).toEqual([
            { data: '/review ' },
        ]);
    });

    it('runs commands with Return for both providers', () => {
        expect(agentActionTerminalInputSteps('claude', action(), 'run')).toEqual([
            { data: '/review\r' },
        ]);
        expect(agentActionTerminalInputSteps('codex', action(), 'run')).toEqual([
            { data: '/review\r' },
        ]);
    });

    it('lets Codex flush a skill invocation before confirming and submitting it', () => {
        const skill = action({ invocation: '$review', kind: 'skill' });

        expect(agentActionTerminalInputSteps('codex', skill, 'run')).toEqual([
            { data: '$review' },
            { data: '\t\n', delayBeforeMs: 150 },
        ]);
        expect(agentActionTerminalInputSteps('claude', skill, 'run')).toEqual([
            { data: '$review\r' },
        ]);
    });

    it('blocks immediate execution for actions with required arguments', () => {
        expect(canExecuteAgentAction(action({ requiresArguments: true }))).toBe(false);
        expect(canExecuteAgentAction(action({ argumentHint: '[target]' }))).toBe(true);
    });
});
